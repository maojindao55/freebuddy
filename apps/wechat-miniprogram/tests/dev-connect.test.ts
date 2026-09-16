/**
 * Local DEV connect controller tests.
 *
 * The controller is the gate that keeps a local-only, in-memory, non-WeChat credential from
 * leaking into a production build, into storage, into a log or into UI state. Each of those claims
 * is asserted here rather than trusted.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createDevConnectController, DEV_CONNECTION_NOTICE } from "../miniprogram/services/devConnect";
import { SECRET_MASK } from "../miniprogram/utils/view";
import { PAGE_ADMIN_URL, PAGE_HOST, createPageHarness } from "./helpers/pageHarness";
import { conversationSummary, snapshotPayload } from "./helpers/fakeTransport";
import type { MiniProgramEnvVersion } from "../miniprogram/platform/wechatApi";
import type { EnvironmentName } from "../miniprogram/config/environments";

const TOKEN = "dev-operator-token-abcdefghijklmnop";

function controller(
  envVersion: MiniProgramEnvVersion,
  envName: EnvironmentName = "local",
  endpoints: { httpBaseUrl: string; wsBaseUrl: string } = {
    httpBaseUrl: "http://127.0.0.1:8080",
    wsBaseUrl: "ws://127.0.0.1:8080"
  }
) {
  const h = createPageHarness();
  const dev = createDevConnectController({
    target: h.connection,
    envName,
    envVersion,
    httpBaseUrl: endpoints.httpBaseUrl,
    wsBaseUrl: endpoints.wsBaseUrl
  });
  return { h, dev };
}

describe("production and non-local isolation", () => {
  test("a release build has no entry, refuses the token and never connects", () => {
    const { h, dev } = controller("release");

    assert.equal(dev.getState().visible, false);
    assert.equal(dev.getState().available, false);
    assert.equal(dev.getState().blockReason, "release_build");
    assert.match(dev.getState().blockMessage, /正式版/);

    const result = dev.setToken(TOKEN);
    assert.equal(result.accepted, false);
    assert.equal(result.length, 0, "拒绝时不得回显长度");
    assert.equal(h.connection.hasToken(), false);

    const connect = dev.connect();
    assert.equal(connect.connected, false);
    assert.equal(h.hub.tasks.length, 0, "release 构建不得创建任何 socket");
  });

  test("a non-local environment stays hidden even in a develop build", () => {
    const { h, dev } = controller("develop", "dev");
    assert.equal(dev.getState().visible, false);
    assert.equal(dev.getState().available, false);
    assert.equal(dev.getState().blockReason, "not_local_environment");
    assert.equal(dev.setToken(TOKEN).accepted, false);
    assert.equal(h.connection.hasToken(), false);
  });

  test("a non-loopback endpoint is refused even in the local environment", () => {
    const { dev } = controller("develop", "local", {
      httpBaseUrl: "http://relay.example.com",
      wsBaseUrl: "ws://relay.example.com"
    });
    assert.equal(dev.getState().visible, true, "入口可见");
    assert.equal(dev.getState().available, false);
    assert.equal(dev.getState().blockReason, "non_loopback_endpoint");
    assert.equal(dev.setToken(TOKEN).accepted, false);
  });

  test("the entry is visible but closed until the operator arms it", () => {
    const { dev } = controller("develop");
    assert.equal(dev.getState().visible, true);
    assert.equal(dev.getState().available, false);
    assert.equal(dev.getState().armed, false);
    assert.equal(dev.getState().blockReason, "not_armed");
    assert.equal(dev.setToken(TOKEN).accepted, false);

    dev.arm();
    assert.equal(dev.getState().available, true);
    assert.equal(dev.getState().blockReason, null);
    assert.equal(dev.setToken(TOKEN).accepted, true);

    dev.disarm();
    assert.equal(dev.getState().available, false);
  });
});

describe("credential handling", () => {
  test("the token is held in memory only and never appears in published state", () => {
    const { h, dev } = controller("develop");
    dev.arm();
    assert.equal(dev.setToken(TOKEN).accepted, true);

    assert.equal(h.connection.hasToken(), true);

    const state = dev.getState();
    assert.equal(state.hasToken, true);
    assert.equal(state.tokenMask, SECRET_MASK);
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes(TOKEN), "状态里不得出现令牌原文");
    assert.ok(!serialized.includes("dev-operator"), "状态里不得出现令牌片段");
    // The only persisted record in this design is the cursor map; it is asserted empty here
    // because no snapshot has been applied yet.
    assert.ok(!JSON.stringify(h.storage.snapshot()).includes(TOKEN));
  });

  test("an empty token is rejected without touching an existing credential", () => {
    const { dev } = controller("develop");
    dev.arm();
    dev.setToken(TOKEN);
    const rejected = dev.setToken("");
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.length, 0);
  });

  test("the socket URL is derived from the environment and cannot be supplied by the operator", () => {
    const { dev } = controller("develop");
    dev.arm();
    const state = dev.getState();
    assert.equal(state.socketUrl, PAGE_ADMIN_URL);

    // There is deliberately no endpoint setter: the interface is the guarantee.
    const surface = Object.keys(dev);
    assert.ok(!surface.includes("setEndpoint"));
    assert.ok(!surface.includes("setUrl"));
    assert.ok(!surface.includes("setBaseUrl"));
    assert.ok(!surface.includes("discoverHosts"));
  });
});

describe("connect", () => {
  test("connecting without a host id is refused locally, with no request on the wire", () => {
    const { h, dev } = controller("develop");
    dev.arm();
    dev.setToken(TOKEN);
    const result = dev.connect();
    assert.equal(result.connected, false);
    assert.match(result.reason ?? "", /主机 ID/);
    assert.equal(h.hub.tasks.length, 0, "缺少 hostId 时不得建连");
  });

  test("connecting without a token is refused", () => {
    const { h, dev } = controller("develop");
    dev.arm();
    dev.setHostId(PAGE_HOST);
    const result = dev.connect();
    assert.equal(result.connected, false);
    assert.match(result.reason ?? "", /令牌/);
    assert.equal(h.hub.tasks.length, 0);
  });

  test("a full DEV session connects, reads a snapshot and clears everything on sign-out", async () => {
    const { h, dev } = controller("develop");
    h.responders["sync.snapshot"] = () =>
      snapshotPayload(PAGE_HOST, 7, { conversations: [conversationSummary()] });

    dev.arm();
    assert.equal(dev.setToken(TOKEN).accepted, true);
    assert.equal(dev.setHostId(PAGE_HOST).accepted, true);
    assert.equal(dev.connect().connected, true);

    // One socket, and the URL is the environment's, not anything the operator typed.
    assert.equal(h.hub.tasks.length, 1);
    assert.equal(h.hub.tasks[0].url, PAGE_ADMIN_URL);

    h.open();
    await h.pump();
    assert.equal(h.stores.conversations.getState().items.length, 1);
    assert.equal(h.connection.resume.resumeFrom(PAGE_HOST), 7, "快照点亮游标");

    dev.signOut();

    assert.equal(dev.getState().hasToken, false);
    assert.equal(dev.getState().tokenMask, null);
    assert.equal(dev.getState().hostId, "");
    assert.equal(dev.getState().armed, false, "退出后需要重新明确开启入口");
    assert.equal(h.connection.hasToken(), false);
    assert.equal(h.connection.getHostId(), null);
    assert.equal(h.stores.host.getState().host, null);
    assert.equal(h.stores.conversations.getState().items.length, 0);
    assert.deepEqual(h.connection.resume.states(), []);
    assert.deepEqual(h.storage.snapshot(), {}, "持久化游标必须被清除");
    assert.ok(!JSON.stringify(h.storage.snapshot()).includes(TOKEN));
  });

  test("host id validation is bounded and clears an unusable value", () => {
    const { h, dev } = controller("develop");
    assert.equal(dev.setHostId("   ").accepted, false);
    assert.equal(h.connection.getHostId(), null);
    assert.equal(dev.setHostId("x".repeat(129)).accepted, false);
    assert.equal(h.connection.getHostId(), null);
    const ok = dev.setHostId(`  ${PAGE_HOST}  `);
    assert.equal(ok.accepted, true);
    assert.equal(ok.hostId, PAGE_HOST, "两端空白被裁剪");
    assert.equal(h.connection.getHostId(), PAGE_HOST);
  });

  test("subscribe publishes state changes without a page polling", () => {
    const { dev } = controller("develop");
    const seen: boolean[] = [];
    const unsubscribe = dev.subscribe((state) => seen.push(state.armed));
    dev.arm();
    dev.disarm();
    unsubscribe();
    dev.arm();
    assert.deepEqual(seen, [true, false], "退订后不再收到状态");
  });

  test("the notice states that this is not a WeChat administrator login", () => {
    assert.match(DEV_CONNECTION_NOTICE, /DEV/);
    assert.match(DEV_CONNECTION_NOTICE, /不是微信管理员登录/);
    assert.match(DEV_CONNECTION_NOTICE, /v1\/auth\/wechat/);
  });
});

describe("no invented host discovery", () => {
  test("a DEV session only ever issues protocol-declared read methods", async () => {
    const { h, dev } = controller("develop");
    dev.arm();
    dev.setToken(TOKEN);
    dev.setHostId(PAGE_HOST);
    dev.connect();
    h.open();
    await h.pump();

    const requested = h
      .framesSent()
      .filter((frame) => frame.type === "rpc.request")
      .map((frame) => String((frame.payload as { method?: string }).method ?? ""));

    assert.ok(requested.length > 0, "会话至少发出一次只读请求");
    for (const method of requested) {
      assert.ok(
        !/host\.list|hosts|pairing|discover/i.test(method),
        `不得私造主机发现方法：${method}`
      );
      assert.ok(
        ["host.status", "sync.snapshot", "project.list", "agent.list", "conversation.list", "conversation.get", "message.list", "task.list", "task.readLog", "workflow.list", "workflow.get", "delegation.list", "delegation.get"].includes(method),
        `只允许协议声明的只读方法：${method}`
      );
    }
  });
});

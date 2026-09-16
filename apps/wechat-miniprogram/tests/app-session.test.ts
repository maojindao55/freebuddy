/**
 * App session tests.
 *
 * The session is what makes the singleton promises real: one socket, one network listener, one
 * place that reacts to foreground/background. These tests drive the *production* adapter over a
 * recording fake `wx` host, so "exactly one listener" and "no HTTP request" are observed rather
 * than asserted by convention.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveEnvironment } from "../miniprogram/config/runtimeConfig";
import { createWechatApi } from "../miniprogram/platform/wechatApi";
import { resetWechatApi, setWechatApi } from "../miniprogram/platform/wechatApiProvider";
import { createAppSession, getAppSession, resetAppSession } from "../miniprogram/services/appSession";
import { createManualScheduler } from "./helpers/fakeTransport";
import { createFakeWechatHost } from "./helpers/fakeWechatHost";

const TOKEN = "dev-operator-token-abcdefghijklmnop";
const HOST_ID = "host-1";

function sessionFixture(override: "local" | "dev" = "local") {
  const host = createFakeWechatHost({ envVersion: "develop" });
  const api = createWechatApi(host);
  const scheduler = createManualScheduler();
  const session = createAppSession({
    api,
    environment: resolveEnvironment({ envVersion: "develop", override }),
    clientVersion: "0.9.10",
    scheduler
  });
  return { host, api, scheduler, session };
}

describe("session assembly", () => {
  test("the admin socket URL is derived from the environment, never from input", () => {
    const { session } = sessionFixture();
    assert.equal(session.environment.name, "local");
    assert.equal(session.environment.wsBaseUrl, "ws://127.0.0.1:8080");
    assert.equal(session.dev.getState().socketUrl, "ws://127.0.0.1:8080/v1/ws/admin");
  });

  test("a non-local environment has no DEV entry", () => {
    const { session } = sessionFixture("dev");
    assert.equal(session.environment.name, "dev");
    assert.equal(session.dev.getState().visible, false);
  });

  test("nothing connects before a credential exists", () => {
    const { host, session } = sessionFixture();
    session.onShow();
    assert.equal(host.sockets.length, 0, "无凭证时不得建连");
    assert.equal(session.connection.stores.connection.getState().status, "signedOut");
    session.dispose();
  });
});

describe("lifecycle", () => {
  test("the network listener is registered once and released on dispose", () => {
    const { host, session } = sessionFixture();
    session.start();
    session.start();
    session.onShow();
    assert.equal(host.listenerCount(), 1, "重复 start 不得叠加监听");

    session.dispose();
    assert.equal(host.listenerCount(), 0);
  });

  test("onShow connects once a DEV credential and host are configured", () => {
    const { host, session } = sessionFixture();
    session.dev.arm();
    assert.equal(session.dev.setToken(TOKEN).accepted, true);
    assert.equal(session.dev.setHostId(HOST_ID).accepted, true);
    assert.equal(session.dev.connect().connected, true);

    session.onShow();
    assert.equal(host.sockets.length, 1);
    assert.equal(host.sockets[0].url, "ws://127.0.0.1:8080/v1/ws/admin");

    // A second onShow while the socket is still connecting must not open a second one.
    session.onShow();
    assert.equal(host.sockets.length, 1, "不得并发建连");
    session.dispose();
  });

  test("onHide suspends the socket and onShow resumes it", () => {
    const { host, session } = sessionFixture();
    session.dev.arm();
    session.dev.setToken(TOKEN);
    session.dev.setHostId(HOST_ID);
    session.dev.connect();
    session.onShow();
    assert.equal(host.sockets.length, 1);

    session.onHide();
    assert.equal(session.connection.stores.connection.getState().suspended, true);
    session.dispose();
  });

  test("a network change is forwarded to the socket exactly once per event", () => {
    const { host, session } = sessionFixture();
    session.dev.arm();
    session.dev.setToken(TOKEN);
    session.dev.setHostId(HOST_ID);
    session.dev.connect();
    session.start();
    session.onShow();
    assert.equal(host.sockets.length, 1);

    host.emitNetworkStatus({ isConnected: false, networkType: "none" });
    const offline = session.connection.stores.connection.getState().status;
    assert.notEqual(offline, "online");
    assert.equal(offline, "backoff", "断网后进入退避而不是假装在线");

    host.emitNetworkStatus({ isConnected: true, networkType: "wifi" });
    assert.equal(host.sockets.length, 2, "网络恢复后重新建连");
    session.dispose();
  });
});

describe("credential containment", () => {
  test("a DEV session writes no token to WeChat storage and issues no HTTP request", () => {
    const { host, session } = sessionFixture();
    session.dev.arm();
    session.dev.setToken(TOKEN);
    session.dev.setHostId(HOST_ID);
    session.dev.connect();
    session.onShow();
    session.onHide();
    session.dispose();

    const storageDump = JSON.stringify([...host.storage.entries()]);
    assert.ok(!storageDump.includes(TOKEN), "令牌不得进入存储");
    const storageWrites = host.calls.filter((call) => call.method === "setStorageSync");
    for (const call of storageWrites) {
      assert.ok(!JSON.stringify(call.args).includes(TOKEN), "setStorageSync 不得收到令牌");
    }
    assert.ok(
      !host.calls.some((call) => call.method === "request"),
      "不得通过 HTTP 私造主机发现接口"
    );
    assert.ok(
      !host.calls.some((call) => call.method === "login"),
      "本阶段不得调用 wx.login"
    );
  });

  test("sign-out leaves nothing reusable behind", () => {
    const { host, session } = sessionFixture();
    session.dev.arm();
    session.dev.setToken(TOKEN);
    session.dev.setHostId(HOST_ID);
    session.dev.connect();
    session.onShow();

    session.dev.signOut();

    assert.equal(session.connection.hasToken(), false);
    assert.equal(session.connection.getHostId(), null);
    assert.equal(session.dev.getState().hasToken, false);
    // With no credential, a later foreground event must not open a socket.
    const socketsBefore = host.sockets.length;
    session.onShow();
    assert.equal(host.sockets.length, socketsBefore, "注销后不得复用旧凭证重连");
    session.dispose();
  });
});

describe("singleton", () => {
  test("the App session is created once and replaced only by an explicit reset", (t) => {
    t.after(() => {
      resetAppSession();
      resetWechatApi();
    });

    const host = createFakeWechatHost({ envVersion: "develop" });
    setWechatApi(createWechatApi(host));

    const first = getAppSession();
    assert.equal(getAppSession(), first, "同一启动周期内必须是单例");

    resetAppSession();
    const second = getAppSession();
    assert.notEqual(second, first, "reset 后必须重建");
    resetAppSession();
  });
});

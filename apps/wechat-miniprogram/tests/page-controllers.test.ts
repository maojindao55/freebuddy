/**
 * Page controller tests.
 *
 * Each page's controller is a pure object: it subscribes to App-owned stores, asks the read layer
 * for bounded pages, and emits view data. Driving it against the production connection (real
 * frames, real correlation) is what lets these tests assert navigation targets, pagination cursors,
 * unmount behaviour, reconnect re-reads and — most importantly — that a late response can never
 * write to a page that is already gone.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EnvironmentName } from "../miniprogram/config/environments";
import type { MiniProgramEnvVersion } from "../miniprogram/platform/wechatApi";
import { createDevConnectController } from "../miniprogram/services/devConnect";
import { ROUTES, chatRoute } from "../miniprogram/services/pageViews";
import { SECRET_MASK } from "../miniprogram/utils/view";
import { createLoginController, type LoginPageData } from "../miniprogram/pages/index/controller";
import { createHomeController, type HomePageData } from "../miniprogram/pages/home/controller";
import {
  createConversationsController,
  type ConversationsPageData
} from "../miniprogram/pages/conversations/controller";
import { createChatController, type ChatPageData } from "../miniprogram/pages/chat/controller";
import { createRecordingPageRuntime } from "./helpers/fakePageRuntime";
import {
  PAGE_HOST,
  PAGE_HOST_2,
  createPageHarness,
  paramsOf,
  settle,
  type PageHarness
} from "./helpers/pageHarness";
import {
  conversationSummary,
  eventFrame,
  messageSummary,
  rpcResponseFrame,
  snapshotPayload
} from "./helpers/fakeTransport";

const TOKEN = "dev-operator-token-abcdefghijklmnop";

interface Renders<T> {
  readonly all: T[];
  last(): T;
  count(): number;
}

function recorder<T>(): Renders<T> {
  const all: T[] = [];
  return {
    all,
    last() {
      const value = all[all.length - 1];
      assert.ok(value !== undefined, "controller produced no view data");
      return value;
    },
    count() {
      return all.length;
    }
  };
}

function devFor(
  h: PageHarness,
  envVersion: MiniProgramEnvVersion = "develop",
  envName: EnvironmentName = "local"
) {
  return createDevConnectController({
    target: h.connection,
    envName,
    envVersion,
    httpBaseUrl: "http://127.0.0.1:8080",
    wsBaseUrl: "ws://127.0.0.1:8080"
  });
}

function loginFixture(envVersion: MiniProgramEnvVersion = "develop", envName: EnvironmentName = "local") {
  const h = createPageHarness();
  const dev = devFor(h, envVersion, envName);
  const runtime = createRecordingPageRuntime();
  const renders = recorder<LoginPageData>();
  const controller = createLoginController({
    connection: h.connection,
    dev,
    runtime,
    environmentName: envName,
    setData: (data) => renders.all.push(data)
  });
  return { h, dev, runtime, controller, renders };
}

async function connectedConversations(): Promise<PageHarness> {
  const h = createPageHarness();
  h.responders["sync.snapshot"] = () =>
    snapshotPayload(PAGE_HOST, 7, {
      conversations: [conversationSummary({ conversationId: "c1", title: "Alpha" })]
    });
  await h.boot(7);
  return h;
}

describe("connect page controller", () => {
  test("the WeChat login button stays disabled and inert", () => {
    const { controller, renders, runtime, h } = loginFixture();
    controller.start();
    assert.equal(renders.last().wechatActionEnabled, false);
    assert.ok(renders.last().wechatActionLabel.length > 0);

    controller.wechatLogin();
    assert.deepEqual(runtime.navigations, [], "占位按钮不得导航或登录");
    assert.equal(h.connection.hasToken(), false);
  });

  test("a release build hides the DEV entry and refuses to accept a token", () => {
    const { controller, renders, runtime, h } = loginFixture("release");
    controller.start();
    assert.equal(renders.last().devVisible, false);
    assert.equal(renders.last().devAvailable, false);
    assert.equal(renders.last().canSaveToken, false);
    assert.equal(renders.last().canConnect, false);

    controller.commitToken(TOKEN);
    assert.equal(renders.last().devHasToken, false);
    assert.equal(h.connection.hasToken(), false);
    assert.ok(runtime.toasts.length >= 1, "必须明确告知凭证被拒绝");
  });

  test("arming, host id and token enable connect without ever echoing the token", () => {
    const { controller, renders, runtime, h } = loginFixture();
    controller.start();
    controller.toggleArm();
    assert.equal(renders.last().devArmed, true);

    controller.setHostId(PAGE_HOST);
    controller.commitToken(TOKEN);

    const data = renders.last();
    assert.equal(data.devHasHostId, true);
    assert.equal(data.devHasToken, true);
    assert.equal(data.devTokenMask, SECRET_MASK);
    assert.equal(data.canConnect, true);
    assert.equal(data.devSocketUrl, "ws://127.0.0.1:8080/v1/ws/admin");

    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes(TOKEN), "页面数据里不得出现令牌");
    assert.ok(!serialized.includes("dev-operator"), "页面数据里不得出现令牌片段");
    assert.deepEqual(runtime.toasts, []);
    assert.equal(h.connection.hasToken(), true);
  });

  test("an invalid host id is reported and does not become a request target", () => {
    const { controller, renders, runtime, h } = loginFixture();
    controller.start();
    controller.toggleArm();
    controller.setHostId("   ");
    assert.equal(renders.last().devHasHostId, false);
    assert.equal(h.connection.getHostId(), null);
    assert.ok(runtime.toasts.some((toast) => /主机 ID/.test(toast)));
  });

  test("entering the console navigates to the fixed home route", () => {
    const { controller, runtime } = loginFixture();
    controller.start();
    controller.openHome();
    controller.openHome();

    assert.deepEqual(runtime.navigations, [ROUTES.home, ROUTES.home]);
    // The route is a constant: operator input cannot redirect it elsewhere.
    assert.ok(!runtime.navigations.some((url) => /\/\/|http|ws:/.test(url)));
  });

  test("sign-out confirms first and only then clears the credential", async () => {
    const { controller, renders, runtime, h } = loginFixture();
    controller.start();
    controller.toggleArm();
    controller.setHostId(PAGE_HOST);
    controller.commitToken(TOKEN);
    assert.equal(h.connection.hasToken(), true);

    runtime.confirmResult = false;
    controller.signOut();
    await settle();
    assert.equal(h.connection.hasToken(), true, "取消确认不得清除凭证");

    runtime.confirmResult = true;
    controller.signOut();
    await settle();
    assert.equal(h.connection.hasToken(), false);
    assert.equal(renders.last().devHasToken, false);
    assert.equal(renders.last().devArmed, false);
    assert.equal(runtime.confirms.length, 2);
  });

  test("stop() detaches the page from every store it subscribed to", () => {
    const { controller, renders, h } = loginFixture();
    controller.start();
    const before = renders.count();

    controller.stop();
    // A connection change would normally re-render; after stop it must not.
    h.connection.stores.connection.pushDiagnostic("scope", "message", 1);
    h.connection.stores.connection.setResyncRequired(true);

    assert.equal(renders.count(), before, "卸载后不得再写页面");
  });
});

describe("home page controller", () => {
  async function homeFixture() {
    const h = await connectedConversations();
    const dev = devFor(h);
    const runtime = createRecordingPageRuntime();
    const renders = recorder<HomePageData>();
    const controller = createHomeController({
      connection: h.connection,
      dev,
      runtime,
      environmentName: "local",
      setData: (data) => renders.all.push(data)
    });
    return { h, dev, runtime, controller, renders };
  }

  test("the snapshot fills the host card and a host.status read refreshes the counters", async () => {
    const { h, controller, renders } = await homeFixture();
    controller.start();
    await h.pump();

    const data = renders.last();
    assert.equal(data.hasHost, true);
    assert.equal(data.hostTone, "ok");
    assert.equal(h.requests("host.status").length, 1, "在线后应刷新主机状态");
    const running = data.metrics.find((metric) => metric.label === "运行中");
    assert.equal(running?.value, "2");
  });

  test("openConversations navigates to the fixed conversations route", async () => {
    const { controller, runtime } = await homeFixture();
    controller.start();
    controller.openConversations();
    assert.deepEqual(runtime.navigations, [ROUTES.conversations]);
  });

  test("reconnect asks the transport for a new attempt", async () => {
    const { h, controller } = await homeFixture();
    controller.start();
    await h.pump();
    const socketsBefore = h.hub.tasks.length;

    h.dropSocket();
    controller.reconnect();

    assert.equal(h.hub.tasks.length, socketsBefore + 1, "显式重连必须发起新连接");
  });

  test("logout clears the credential and relaunches the connect page", async () => {
    const { h, runtime, controller } = await homeFixture();
    controller.start();
    await h.pump();
    assert.equal(h.connection.hasToken(), true);

    controller.logout();
    await settle();

    assert.equal(runtime.relaunches.includes(ROUTES.login), true);
    assert.equal(h.connection.hasToken(), false);
    assert.equal(h.connection.getHostId(), null);
  });

  test("stop() stops all page traffic", async () => {
    const { h, controller, renders } = await homeFixture();
    controller.start();
    await h.pump();
    const before = renders.count();

    controller.stop();
    h.hub.deliver(eventFrame(PAGE_HOST, "conversation.updated", 8, conversationSummary({ title: "x" })));

    assert.equal(renders.count(), before);
  });
});

describe("conversations page controller", () => {
  function conversationsFixture(h: PageHarness) {
    const runtime = createRecordingPageRuntime();
    const renders = recorder<ConversationsPageData>();
    const controller = createConversationsController({
      connection: h.connection,
      runtime,
      setData: (data) => renders.all.push(data)
    });
    return { runtime, controller, renders };
  }

  test("start loads the first bounded page and keeps the cursor", async () => {
    const h = await connectedConversations();
    h.responders["conversation.list"] = () => ({
      items: [conversationSummary({ conversationId: "c1", title: "Alpha" })],
      nextCursor: "page-2"
    });
    const { controller, renders } = conversationsFixture(h);

    controller.start();
    await h.pump();

    const data = renders.last();
    assert.equal(data.items.length, 1);
    assert.equal(data.hasMore, true);
    assert.equal(data.loadMoreEnabled, true);
    assert.equal(data.loading, false);
    assert.equal(paramsOf(h.requests("conversation.list")[0]).limit, 50);
  });

  test("loadMore follows the cursor and merges the second page", async () => {
    const h = await connectedConversations();
    h.responders["conversation.list"] = (params) =>
      params.cursor === "page-2"
        ? { items: [conversationSummary({ conversationId: "c2", title: "Beta" })], nextCursor: null }
        : { items: [conversationSummary({ conversationId: "c1", title: "Alpha" })], nextCursor: "page-2" };
    const { controller, renders } = conversationsFixture(h);

    controller.start();
    await h.pump();
    controller.loadMore();
    await h.pump();

    const requests = h.requests("conversation.list");
    assert.equal(requests.length, 2);
    assert.equal(paramsOf(requests[1]).cursor, "page-2");
    assert.deepEqual(
      renders.last().items.map((item) => item.id),
      ["c1", "c2"]
    );
    assert.equal(renders.last().hasMore, false);
  });

  test("loadMore is refused while the host is unreachable", async () => {
    const h = await connectedConversations();
    h.responders["conversation.list"] = () => ({
      items: [conversationSummary({ conversationId: "c1" })],
      nextCursor: "page-2"
    });
    const { controller, renders } = conversationsFixture(h);
    controller.start();
    await h.pump();
    const before = h.requests("conversation.list").length;

    h.dropSocket();
    controller.loadMore();
    await settle();

    assert.equal(h.requests("conversation.list").length, before, "离线时不得发起分页请求");
    assert.equal(renders.last().loadMoreEnabled, false);
    assert.match(renders.last().emptyMessage, /离线|主机/);
  });

  test("refresh stops the pull-down spinner", async () => {
    const h = await connectedConversations();
    h.responders["conversation.list"] = () => ({ items: [], nextCursor: null });
    const { controller, runtime } = conversationsFixture(h);
    controller.start();
    await h.pump();

    controller.refresh();
    await h.pump();
    await settle();

    assert.equal(runtime.pullDownStops(), 1);
  });

  test("openConversation navigates with an encoded id", async () => {
    const h = await connectedConversations();
    const { controller, runtime } = conversationsFixture(h);
    controller.start();
    await h.pump();

    controller.openConversation("c/1 a");
    assert.deepEqual(runtime.navigations, [chatRoute("c/1 a")]);

    controller.openConversation("");
    assert.equal(runtime.navigations.length, 1, "空 id 不得导航");
  });

  test("a page that resolves after unmount never writes to the dead page", async () => {
    const h = await connectedConversations();
    const { controller, renders } = conversationsFixture(h);
    controller.start();
    const outstanding = h.unanswered("conversation.list");
    assert.equal(outstanding.length, 1);

    controller.stop();
    const before = renders.count();

    h.hub.deliver(
      rpcResponseFrame(PAGE_HOST, outstanding[0].id as string, {
        items: [conversationSummary({ conversationId: "late", title: "Late" })],
        nextCursor: null
      })
    );
    await settle();

    assert.equal(renders.count(), before, "卸载后晚到的分页不得写页面");
    // The App still owns the cache, which is what makes a re-open cheap.
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.conversationId),
      ["late"]
    );
  });

  test("a page for the previous host is dropped after a host switch", async () => {
    const h = await connectedConversations();
    const { controller, renders } = conversationsFixture(h);
    controller.start();
    const outstanding = h.unanswered("conversation.list");
    assert.equal(outstanding.length, 1);

    h.connection.setHostId(PAGE_HOST_2);
    h.hub.deliver(
      rpcResponseFrame(PAGE_HOST, outstanding[0].id as string, {
        items: [conversationSummary({ conversationId: "other-host" })],
        nextCursor: null
      })
    );
    await settle();

    assert.equal(h.stores.conversations.getState().items.length, 0, "上一台主机的分页必须丢弃");
    assert.ok(!renders.all.some((data) => data.items.some((item) => item.id === "other-host")));
  });

  test("a reconnect re-reads the list", async () => {
    const h = await connectedConversations();
    h.responders["conversation.list"] = () => ({
      items: [conversationSummary({ conversationId: "c1" })],
      nextCursor: null
    });
    const { controller } = conversationsFixture(h);
    controller.start();
    await h.pump();
    assert.equal(h.requests("conversation.list").length, 1);

    h.dropSocket();
    h.advance(5_000);
    assert.equal(h.hub.tasks.length, 2, "断线后必须重连");
    h.open();
    await h.pump();

    assert.equal(h.requests("conversation.list").length, 1, "新连接上重新读取一次");
  });
});

describe("chat page controller", () => {
  function chatFixture(h: PageHarness) {
    const runtime = createRecordingPageRuntime();
    const renders = recorder<ChatPageData>();
    const controller = createChatController({
      connection: h.connection,
      runtime,
      conversationId: "c1",
      setData: (data) => renders.all.push(data)
    });
    return { runtime, controller, renders };
  }

  test("start reads the newest window and renders messages as plain text", async () => {
    const h = await connectedConversations();
    h.responders["message.list"] = () => ({
      items: [
        messageSummary({ messageId: "m1", role: "assistant", content: "<b>hi</b>\u0000\u0007" }),
        messageSummary({ messageId: "m2", role: "user", content: "hello" })
      ],
      nextCursor: null
    });
    const { controller, renders } = chatFixture(h);

    controller.start();
    await h.pump();

    const data = renders.last();
    assert.equal(data.title, "Alpha");
    assert.equal(data.canSend, false);
    assert.deepEqual(
      data.messages.map((message) => message.text),
      ["<b>hi</b>", "hello"]
    );
    assert.equal(data.messages[0].roleLabel, "助手");
    assert.match(data.readonlyNotice, /只读/);
    assert.equal(data.conversationId, "c1");
  });

  test("loadOlder follows the cursor and appends history", async () => {
    const h = await connectedConversations();
    h.responders["message.list"] = (params) =>
      params.cursor === "page-2"
        ? { items: [messageSummary({ messageId: "m0", content: "older" })], nextCursor: null }
        : { items: [messageSummary({ messageId: "m1", content: "newest" })], nextCursor: "page-2" };
    const { controller, renders } = chatFixture(h);

    controller.start();
    await h.pump();
    assert.equal(renders.last().hasMore, true);
    assert.equal(renders.last().loadOlderEnabled, true);

    controller.loadOlder();
    await h.pump();

    const requests = h.requests("message.list");
    assert.equal(requests.length, 2);
    assert.equal(paramsOf(requests[1]).cursor, "page-2");
    assert.equal(paramsOf(requests[1]).conversationId, "c1");
    assert.deepEqual(
      renders.last().messages.map((message) => message.text),
      ["older", "newest"]
    );
  });

  test("refresh stops the pull-down spinner", async () => {
    const h = await connectedConversations();
    const { controller, runtime } = chatFixture(h);
    controller.start();
    await h.pump();

    controller.refresh();
    await h.pump();
    await settle();
    assert.equal(runtime.pullDownStops(), 1);
  });

  test("a message page that lands after unmount never writes to the dead page", async () => {
    const h = await connectedConversations();
    const { controller, renders } = chatFixture(h);
    controller.start();
    const outstanding = h.unanswered("message.list");
    assert.equal(outstanding.length, 1);

    controller.stop();
    const before = renders.count();

    h.hub.deliver(
      rpcResponseFrame(PAGE_HOST, outstanding[0].id as string, {
        items: [messageSummary({ messageId: "m-late", content: "late" })],
        nextCursor: null
      })
    );
    await settle();

    assert.equal(renders.count(), before);
    assert.equal(h.stores.messages.thread("c1").items.length, 1, "App 缓存仍然更新");
  });

  test("a live message event updates a mounted page but not an unmounted one", async () => {
    const h = await connectedConversations();
    const { controller, renders } = chatFixture(h);
    controller.start();
    await h.pump();
    const mounted = renders.count();

    h.hub.deliver(eventFrame(PAGE_HOST, "message.created", 8, messageSummary({ messageId: "m1", content: "live" })));
    assert.equal(renders.count() > mounted, true, "挂载中的页面必须看到实时事件");
    assert.equal(renders.last().messages[0].text, "live");

    controller.stop();
    const afterStop = renders.count();
    h.hub.deliver(eventFrame(PAGE_HOST, "message.created", 9, messageSummary({ messageId: "m2", content: "after" })));
    assert.equal(renders.count(), afterStop, "卸载后不得再写页面");
  });

  test("the controller exposes no write surface at all", () => {
    const { controller } = chatFixture(createPageHarness());
    // `start`/`stop` are lifecycle, not actions. Everything that would send, stop, approve or open
    // a terminal must not exist as a method on a read-only controller.
    for (const forbidden of ["send", "respond", "decide", "approve", "terminal", "stopRun", "createTerminal"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(controller, forbidden),
        false,
        `只读页面不得提供 ${forbidden}`
      );
    }
  });
});

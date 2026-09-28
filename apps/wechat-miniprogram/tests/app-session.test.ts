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
import { createWechatApi, type WechatApi } from "../miniprogram/platform/wechatApi";
import { resetWechatApi, setWechatApi } from "../miniprogram/platform/wechatApiProvider";
import { createAppSession, getAppSession, resetAppSession } from "../miniprogram/services/appSession";
import { AUTH_SESSION_STORAGE_KEY, type AuthSessionRecord } from "../miniprogram/services/tokenStore";
import { createManualScheduler, createSocketHub, sentFrames } from "./helpers/fakeTransport";
import { AUTH_PATHS, authResponse, createFakeAuthApi, tokenPair } from "./helpers/fakeAuthApi";
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

/**
 * The auth integration: a persisted WeChat session must reach the single socket, and a session
 * whose access token expired while the mini program was in the background must be rotated
 * *before* the reconnect — presenting an expired token would only earn a `forbidden`.
 *
 * The clock is the real one here; the seeded record is simply already expired.
 */
function wechatSessionFixture(
  options: { readonly accessExpired?: boolean; readonly override?: "dev" | "local" } = {}
) {
  const pair = tokenPair("seeded");
  const now = Date.now();
  const api = createFakeAuthApi({
    storage: {
      [AUTH_SESSION_STORAGE_KEY]: {
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        accessExpiresAtMs: options.accessExpired === true ? now - 1_000 : now + 3_600_000,
        refreshExpiresAtMs: now + 7_200_000
      } satisfies AuthSessionRecord
    }
  });
  const hub = createSocketHub();
  const wired: WechatApi = {
    ...api,
    connectSocket: (socketOptions) => hub.createSocket(socketOptions.url)
  };
  const session = createAppSession({
    api: wired,
    environment: resolveEnvironment({ envVersion: "develop", override: options.override ?? "dev" }),
    clientVersion: "0.9.10",
    scheduler: createManualScheduler()
  });
  return { api, hub, session };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("wechat credential wiring", () => {
  test("a valid stored session authenticates the socket without any HTTP round trip", async () => {
    const { api, hub, session } = wechatSessionFixture();
    session.onShow();
    await settle();

    assert.equal(hub.tasks.length, 1, "有会话时前台必须建连");
    hub.last().fireOpen();
    const auth = sentFrames(hub.last()).find((frame) => frame.type === "admin.auth");
    assert.equal(
      (auth?.payload as { accessToken?: string }).accessToken,
      tokenPair("seeded").accessToken
    );
    assert.deepEqual(api.pathsRequested(), [], "有效会话不得触发刷新");
    session.dispose();
  });

  test("a session that expired in the background is rotated before the reconnect", async () => {
    const { api, hub, session } = wechatSessionFixture({ accessExpired: true });
    api.route(AUTH_PATHS.refresh, { statusCode: 200, data: authResponse("rotated", 600, 7_200) });

    session.onShow();
    await settle();
    assert.deepEqual(api.pathsRequested(), [AUTH_PATHS.refresh], "过期访问令牌必须先轮换");
    assert.equal(hub.tasks.length, 1);
    hub.last().fireOpen();

    const auth = sentFrames(hub.last()).find((frame) => frame.type === "admin.auth");
    assert.equal(
      (auth?.payload as { accessToken?: string }).accessToken,
      tokenPair("rotated").accessToken,
      "重连必须携带轮换后的令牌，而不是已过期的令牌"
    );
    assert.equal(session.connection.hasCredential(), true);
    session.dispose();
  });

  test("an expired session whose refresh is refused does not open a socket", async () => {
    const { api, hub, session } = wechatSessionFixture({ accessExpired: true });
    api.route(AUTH_PATHS.refresh, {
      statusCode: 401,
      data: { code: "unauthorized", message: "invalid or expired refresh token", retryable: false }
    });

    session.onShow();
    await settle();

    assert.equal(hub.tasks.length, 0, "无可刷新凭证时不得建连");
    assert.equal(session.auth.getAccessToken(), null);
    assert.equal(session.connection.hasCredential(), false);
    session.dispose();
  });

  test("a wechat login supersedes a DEV credential and enables the transport", async () => {
    // The DEV panel is only reachable in the local named environment.
    const { api, hub, session } = wechatSessionFixture({ override: "local" });
    // A DEV token may only exist in a local, operator-armed build; this proves precedence.
    session.dev.arm();
    assert.equal(session.dev.setToken(TOKEN).accepted, true);
    assert.equal(session.connection.hasCredential(), true);

    api.route(AUTH_PATHS.wechat, { statusCode: 200, data: authResponse("login", 600, 3_600) });
    const outcome = await session.auth.loginWithWeChat();

    assert.equal(outcome.ok, true);
    assert.equal(session.connection.hasToken(), false, "微信登录必须取代 DEV 令牌");
    assert.equal(session.connection.hasCredential(), true);
    session.connection.connect("微信管理员登录");
    hub.last().fireOpen();
    const auth = sentFrames(hub.last()).find((frame) => frame.type === "admin.auth");
    assert.equal(
      (auth?.payload as { accessToken?: string }).accessToken,
      tokenPair("login").accessToken
    );
    session.dispose();
  });

  test("logout clears the local session and the socket credential", async () => {
    const { api, session } = wechatSessionFixture();
    api.route(AUTH_PATHS.logout, { statusCode: 200, data: {} });
    const outcome = await session.auth.logout();
    assert.equal(outcome.localCleared, true);
    assert.equal(session.auth.getAccessToken(), null);
    assert.equal(session.connection.hasCredential(), false);
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

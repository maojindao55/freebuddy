/**
 * Auth session state machine tests.
 *
 * The cases are chosen around the ways an only-administrator client can be wrong:
 *
 * - mistaking "the network failed" for "you are not the administrator" (or the reverse) — one
 *   signs the operator out, the other leaves them stuck;
 * - spending a one-time refresh token twice, or replaying a rotated one;
 * - leaving a credential behind after logout when the server could not be reached;
 * - leaking a token into anything the UI or a diagnostic can read.
 *
 * A controllable clock is injected so expiry, the refresh skew and foreground rotation are decided
 * by the test, not by wall time.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveEnvironment } from "../miniprogram/config/runtimeConfig";
import { createOperatorTokenSession } from "../miniprogram/services/adminSession";
import { createAuthSession, REFRESH_SKEW_MS, type AuthState } from "../miniprogram/services/authSession";
import { AUTH_SESSION_STORAGE_KEY, createWechatAuthTokenStore, type AuthSessionRecord } from "../miniprogram/services/tokenStore";
import { createErrorBoundary } from "../miniprogram/utils/errorBoundary";
import { AUTH_PATHS, authResponse, createFakeAuthApi, tokenPair, type FakeAuthApi } from "./helpers/fakeAuthApi";

const NOW = 1_700_000_000_000;
const DEV_ENV = resolveEnvironment({ envVersion: "develop", override: "dev" });

interface Fixture {
  readonly api: FakeAuthApi;
  readonly auth: ReturnType<typeof createAuthSession>;
  readonly tokenStore: ReturnType<typeof createWechatAuthTokenStore>;
  readonly devSession: ReturnType<typeof createOperatorTokenSession>;
  readonly states: AuthState[];
  setNow(ms: number): void;
  advance(ms: number): void;
}

function fixture(options: { readonly storage?: Record<string, unknown> } = {}): Fixture {
  const api = createFakeAuthApi({ storage: options.storage });
  const tokenStore = createWechatAuthTokenStore(api);
  const devSession = createOperatorTokenSession();
  let now = NOW;
  const auth = createAuthSession({
    api,
    environment: DEV_ENV,
    clientVersion: "0.9.10",
    tokenStore,
    devSession,
    nowMs: () => now
  });
  const states: AuthState[] = [];
  auth.subscribe((state) => states.push(state));
  return {
    api,
    auth,
    tokenStore,
    devSession,
    states,
    setNow: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    }
  };
}

function storedRecord(f: Fixture): AuthSessionRecord | null {
  return f.tokenStore.read();
}

function seedSession(f: Fixture, expiresInMs: number, refreshExpiresInMs: number, label = "seeded"): AuthSessionRecord {
  const pair = tokenPair(label);
  const record: AuthSessionRecord = {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    accessExpiresAtMs: NOW + expiresInMs,
    refreshExpiresAtMs: NOW + refreshExpiresInMs
  };
  f.api.storage.set(AUTH_SESSION_STORAGE_KEY, record);
  return record;
}

describe("wechat login", () => {
  test("exchanges the wx.login code and persists the returned pair", async () => {
    const f = fixture();
    f.api.route(AUTH_PATHS.wechat, { statusCode: 200, data: authResponse("login") });

    const outcome = await f.auth.loginWithWeChat();

    assert.equal(outcome.ok, true);
    assert.equal(f.api.loginCalls(), 1);
    assert.deepEqual(f.api.pathsRequested(), [AUTH_PATHS.wechat]);
    const state = f.auth.getState();
    assert.equal(state.mode, "wechat");
    assert.equal(state.status, "signedIn");
    assert.equal(state.hasCredential, true);
    assert.equal(state.accessExpiresAtMs, NOW + 3_600_000);
    assert.equal(f.auth.getAccessToken(), tokenPair("login").accessToken);
    assert.deepEqual(storedRecord(f), {
      accessToken: tokenPair("login").accessToken,
      refreshToken: tokenPair("login").refreshToken,
      accessExpiresAtMs: NOW + 3_600_000,
      refreshExpiresAtMs: NOW + 86_400_000
    });
  });

  test("a non-administrator is refused, told why, and inherits nothing", async () => {
    const f = fixture();
    seedSession(f, 3_600_000, 86_400_000, "previous");
    f.api.route(AUTH_PATHS.wechat, {
      statusCode: 403,
      data: { code: "forbidden", message: "admin authentication forbidden", retryable: false }
    });

    const outcome = await f.auth.loginWithWeChat();

    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "non_admin");
    assert.match(outcome.message, /管理员/);
    assert.equal(f.auth.getState().status, "rejected");
    assert.equal(f.auth.getState().mode, "none");
    assert.equal(f.auth.hasCredential(), false);
    assert.equal(storedRecord(f), null, "被拒绝的登录不得保留旧会话");
    assert.equal(f.api.pathsRequested().length, 1, "被拒绝后不得自动重试");
  });

  test("a refused WeChat login does not knock out a working DEV credential", async () => {
    const f = fixture();
    f.devSession.setToken("dev-operator-token-abcdefghijklmnop");
    f.api.route(AUTH_PATHS.wechat, {
      statusCode: 403,
      data: { code: "forbidden", message: "admin authentication forbidden", retryable: false }
    });

    const outcome = await f.auth.loginWithWeChat();

    assert.equal(outcome.ok, false);
    assert.equal(f.devSession.hasToken(), true, "微信登录被拒不得清除仍可用的 DEV 凭证");
    assert.equal(f.auth.credential.getAccessToken(), "dev-operator-token-abcdefghijklmnop");
  });

  test("a network failure keeps any existing session and stays retryable", async () => {
    const f = fixture();
    const previous = seedSession(f, 3_600_000, 86_400_000, "previous");
    f.api.route(AUTH_PATHS.wechat, { networkError: "request:fail timeout" });

    const outcome = await f.auth.loginWithWeChat();

    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "network");
    assert.equal(f.auth.getState().status, "error");
    assert.match(f.auth.getState().lastError, /网络/);
    assert.deepEqual(storedRecord(f), previous, "网络失败不得清掉仍可能有效的会话");
    assert.equal(f.auth.hasCredential(), true);
  });

  test("a double tap spends one login code", async () => {
    const f = fixture();
    f.api.route(AUTH_PATHS.wechat, { statusCode: 200, data: authResponse("login") });
    const [first, second] = await Promise.all([f.auth.loginWithWeChat(), f.auth.loginWithWeChat()]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(f.api.loginCalls(), 1, "并发登录必须合并");
    assert.equal(f.api.pathsRequested().length, 1);
  });

  test("a session that cannot be persisted is not treated as signed in", async () => {
    const f = fixture();
    f.api.route(AUTH_PATHS.wechat, { statusCode: 200, data: authResponse("login") });
    f.api.failStorageWrites(true);

    const outcome = await f.auth.loginWithWeChat();

    assert.equal(outcome.ok, false);
    assert.equal(f.auth.getState().status, "error");
    assert.equal(f.auth.getAccessToken(), null);
  });

  test("a wx.login failure is a network failure, not an identity verdict", async () => {
    const f = fixture();
    f.api.setLoginOutcome({ error: "login:fail no network" });
    const outcome = await f.auth.loginWithWeChat();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "network");
    assert.equal(f.api.requests.length, 0, "wx.login 失败时不得再发登录请求");
    assert.equal(f.auth.getState().status, "error");
  });
});

describe("refresh rotation", () => {
  test("rotates both tokens in place before the access token expires", async () => {
    const f = fixture();
    seedSession(f, 30_000, 86_400_000, "old");
    assert.equal(f.auth.needsRefresh(), true, "进入刷新窗口");

    f.api.route(AUTH_PATHS.refresh, { statusCode: 200, data: authResponse("rotated", 600, 7_200) });
    const refreshed = await f.auth.refreshNow();

    assert.equal(refreshed, true);
    assert.deepEqual(f.api.pathsRequested(), [AUTH_PATHS.refresh]);
    assert.equal(f.auth.getAccessToken(), tokenPair("rotated").accessToken);
    const stored = storedRecord(f);
    assert.equal(stored?.refreshToken, tokenPair("rotated").refreshToken, "必须替换刷新令牌");
    assert.equal(stored?.accessExpiresAtMs, NOW + 600_000);
    assert.equal(stored?.refreshExpiresAtMs, NOW + 7_200_000);
    assert.equal(f.auth.getState().status, "signedIn");
  });

  test("a valid access token needs no refresh", () => {
    const f = fixture();
    seedSession(f, REFRESH_SKEW_MS * 3, 86_400_000, "fresh");
    assert.equal(f.auth.needsRefresh(), false);
  });

  test("concurrent refreshes spend the one-time token once", async () => {
    const f = fixture();
    seedSession(f, 10_000, 86_400_000, "old");
    f.api.route(AUTH_PATHS.refresh, { statusCode: 200, data: authResponse("rotated") });

    const results = await Promise.all([f.auth.refreshNow(), f.auth.refreshNow(), f.auth.refreshNow()]);

    assert.deepEqual(results, [true, true, true]);
    assert.equal(f.api.pathsRequested().length, 1, "并发刷新必须合并为一次轮换");
  });

  test("a replayed/revoked refresh token clears the session and is not retried", async () => {
    const f = fixture();
    seedSession(f, 10_000, 86_400_000, "replayed");
    f.api.route(AUTH_PATHS.refresh, {
      statusCode: 401,
      data: { code: "unauthorized", message: "invalid or expired refresh token", retryable: false }
    });

    assert.equal(await f.auth.refreshNow(), false);
    assert.equal(f.auth.getState().status, "expired");
    assert.equal(f.auth.hasCredential(), false);
    assert.equal(storedRecord(f), null, "重放被拒后必须删除刷新令牌");

    // The rotated token is gone, so a later attempt must not replay it.
    assert.equal(await f.auth.refreshNow(), false);
    assert.equal(f.api.pathsRequested().length, 1, "不得重复提交已失效的刷新令牌");
  });

  test("an expired refresh token never reaches the network", async () => {
    const f = fixture();
    seedSession(f, -1_000, -500, "expired");
    assert.equal(f.auth.needsRefresh(), false, "无可刷新时不得声称需要刷新");
    assert.equal(f.auth.getAccessToken(), null, "过期令牌不得交给传输层");

    assert.equal(await f.auth.refreshNow(), false);
    assert.equal(f.api.pathsRequested().length, 0);
    assert.equal(f.auth.getState().status, "expired");
  });

  test("a rotation that cannot be persisted signs out instead of pretending", async () => {
    const f = fixture();
    seedSession(f, 10_000, 86_400_000, "old");
    f.api.route(AUTH_PATHS.refresh, { statusCode: 200, data: authResponse("rotated") });
    f.api.failStorageWrites(true);

    assert.equal(await f.auth.refreshNow(), false);
    assert.equal(f.auth.getState().status, "expired");
    assert.equal(f.auth.getAccessToken(), null);
  });

  test("a transient refresh failure keeps the stored pair", async () => {
    const f = fixture();
    const seeded = seedSession(f, 10_000, 86_400_000, "old");
    f.api.route(AUTH_PATHS.refresh, { networkError: "request:fail offline" });

    assert.equal(await f.auth.refreshNow(), false);
    assert.deepEqual(storedRecord(f), seeded, "网络失败不得作废仍可能有效的会话");
    assert.equal(f.auth.getAccessToken(), tokenPair("old").accessToken);
    assert.equal(f.auth.getState().lastErrorKind, "network");
  });
});

describe("relay rejections", () => {
  test("forbidden is terminal and clears everything without a refresh", async () => {
    const f = fixture();
    seedSession(f, 600_000, 86_400_000, "session");
    const recovered = await f.auth.handleAuthRejected("forbidden");
    assert.equal(recovered, false);
    assert.equal(f.api.pathsRequested().length, 0, "forbidden 不得触发刷新");
    assert.equal(f.auth.hasCredential(), false);
    assert.equal(f.auth.getState().status, "rejected");
  });

  test("unauthorized rotates the token so the caller can reconnect", async () => {
    const f = fixture();
    seedSession(f, 600_000, 86_400_000, "session");
    f.api.route(AUTH_PATHS.refresh, { statusCode: 200, data: authResponse("rotated") });
    const recovered = await f.auth.handleAuthRejected("unauthorized");
    assert.equal(recovered, true);
    assert.equal(f.auth.getAccessToken(), tokenPair("rotated").accessToken);
  });

  test("a DEV credential is never refreshed", async () => {
    const f = fixture();
    assert.equal(f.auth.credential.getAccessToken(), null);
    f.devSession.setToken("dev-operator-token-abcdefghijklmnop");
    assert.equal(f.auth.credential.getAccessToken(), "dev-operator-token-abcdefghijklmnop");
    assert.equal(await f.auth.handleAuthRejected("unauthorized"), false);
    assert.equal(f.api.pathsRequested().length, 0);
    assert.equal(f.auth.getState().mode, "dev");
  });
});

describe("logout", () => {
  test("revokes server-side and clears this device", async () => {
    const f = fixture();
    seedSession(f, 600_000, 86_400_000, "session");
    f.api.route(AUTH_PATHS.logout, { statusCode: 200, data: {} });

    const outcome = await f.auth.logout();

    assert.equal(outcome.revoked, "ok");
    assert.equal(outcome.localCleared, true);
    const request = f.api.requests[0];
    assert.equal(request.header?.Authorization, `Bearer ${tokenPair("session").accessToken}`);
    assert.equal(f.auth.getAccessToken(), null);
    assert.equal(storedRecord(f), null);
    assert.equal(f.auth.getState().status, "signedOut");
  });

  test("local state is cleared even when the server cannot be reached", async () => {
    const f = fixture();
    seedSession(f, 600_000, 86_400_000, "session");
    f.api.route(AUTH_PATHS.logout, { networkError: "request:fail offline" });

    const outcome = await f.auth.logout();

    assert.equal(outcome.revoked, "failed");
    assert.equal(outcome.localCleared, true);
    assert.equal(f.auth.getAccessToken(), null, "离线也必须清理本地凭证");
    assert.equal(storedRecord(f), null);
  });

  test("logout with no session still clears and reports skipped", async () => {
    const f = fixture();
    const outcome = await f.auth.logout();
    assert.equal(outcome.revoked, "skipped");
    assert.equal(f.api.pathsRequested().length, 0);
    assert.equal(f.auth.getState().status, "signedOut");
  });

  test("an explicit credential clear drops the DEV token too", () => {
    const f = fixture();
    f.devSession.setToken("dev-operator-token-abcdefghijklmnop");
    seedSession(f, 600_000, 86_400_000, "session");
    f.auth.credential.clear();
    assert.equal(f.devSession.hasToken(), false);
    assert.equal(storedRecord(f), null);
    assert.equal(f.auth.hasCredential(), false);
  });
});

describe("credential containment", () => {
  test("no observed state ever contains a token", async () => {
    const f = fixture();
    f.api.route(AUTH_PATHS.wechat, { statusCode: 200, data: authResponse("login") });
    f.api.route(AUTH_PATHS.refresh, { statusCode: 200, data: authResponse("rotated") });
    f.api.route(AUTH_PATHS.logout, { statusCode: 200, data: {} });

    await f.auth.loginWithWeChat();
    f.advance(3_600_000);
    await f.auth.refreshNow();
    const logout = await f.auth.logout();

    const dump = JSON.stringify({ states: f.states, logout });
    assert.ok(f.states.length > 0, "必须发布过状态");
    for (const label of ["login", "rotated"]) {
      assert.ok(!dump.includes(tokenPair(label).accessToken), `状态/结果不得出现 ${label} access token`);
      assert.ok(!dump.includes(tokenPair(label).refreshToken), `状态/结果不得出现 ${label} refresh token`);
    }
    assert.ok(!dump.includes("wx-login-code-abcdef"), "状态/结果不得出现登录码");
    assert.ok(!dump.includes(DEV_ENV.httpBaseUrl), "状态不得出现端点");
  });

  test("refusals never echo the submitted credential", async () => {
    const f = fixture();
    f.api.route(AUTH_PATHS.wechat, {
      statusCode: 401,
      data: { code: "unauthorized", message: "wechat authentication failed", retryable: false }
    });
    const outcome = await f.auth.loginWithWeChat();
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.message.includes("wx-login-code-abcdef"));
    assert.ok(!/accessToken|refreshToken/i.test(outcome.message));
  });

  test("the app's log sink redacts a credential embedded in an auth failure", () => {
    // The auth modules never log; the only console sink in the app is the error boundary, and it
    // is the path a future report/toast would take. This proves the credential is masked there.
    const boundary = createErrorBoundary({ debug: false });
    const token = tokenPair("login").accessToken;
    const entry = boundary.handleError("auth.login", new Error(`request:fail accessToken=${token}`));
    assert.ok(!entry.message.includes(token));
    assert.match(entry.message, /\[redacted\]/);
  });

  test("logout after a refusal still leaves nothing behind", async () => {
    const f = fixture();
    seedSession(f, 600_000, 86_400_000, "session");
    await f.auth.handleAuthRejected("forbidden");
    await f.auth.logout();
    assert.equal(f.api.storage.size, 0, "存储中不得残留任何会话记录");
  });
});

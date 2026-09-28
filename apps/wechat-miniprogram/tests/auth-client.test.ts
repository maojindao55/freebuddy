/**
 * Auth HTTP client tests.
 *
 * These pin the *wire* behaviour: the exact paths and body fields the frozen companion schema
 * declares, the acceptance rules for a response, and — as importantly — that a failure class is
 * never confused with another. A 403 (not the administrator) and a dropped connection are both
 * "login did not happen", but only one of them means the account is wrong, and the state machine
 * downstream signs out on one and retries the other.
 *
 * Every assertion reads bodies produced by the production client; nothing here re-declares a
 * field, so a schema change that the binding picks up cannot silently pass.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveEnvironment, type ResolvedEnvironment } from "../miniprogram/config/runtimeConfig";
import { createAuthClient, kindForErrorCode, AUTH_REQUEST_TIMEOUT_MS } from "../miniprogram/services/authClient";
import { REMOTE_ERROR_CODES } from "../miniprogram/protocol/index";
import { AUTH_PATHS, authResponse, createFakeAuthApi, tokenPair } from "./helpers/fakeAuthApi";

const DEV_ENV = resolveEnvironment({ envVersion: "develop", override: "dev" });

function client(api = createFakeAuthApi(), environment: ResolvedEnvironment = DEV_ENV) {
  return { api, auth: createAuthClient({ api, environment }) };
}

describe("endpoint hardening", () => {
  test("the base URL comes from the environment table and has no setter", () => {
    const { auth } = client();
    assert.equal(auth.httpBaseUrl, "https://relay-dev.example.com");
    assert.equal(
      Object.values(auth).some((value) => typeof value === "function" && /endpoint/i.test(String(value))),
      false
    );
    assert.ok(!("setEndpoint" in auth), "不得提供端点设置入口");
  });

  test("a release build cannot be pointed at plaintext http", () => {
    const insecureProd: ResolvedEnvironment = {
      name: "prod",
      httpBaseUrl: "http://relay.example.com",
      wsBaseUrl: "wss://relay.example.com",
      debugLogging: false,
      source: "policy"
    };
    assert.throws(() => createAuthClient({ api: createFakeAuthApi(), environment: insecureProd }), /https/);
  });

  test("a base URL carrying a path or credentials is refused", () => {
    const smuggled: ResolvedEnvironment = {
      name: "dev",
      httpBaseUrl: "https://relay-dev.example.com/evil",
      wsBaseUrl: "wss://relay-dev.example.com",
      debugLogging: true,
      source: "policy"
    };
    assert.throws(() => createAuthClient({ api: createFakeAuthApi(), environment: smuggled }));
  });
});

describe("POST /v1/auth/wechat", () => {
  test("sends exactly code + clientVersion (+ optional deviceLabel) as JSON", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    api.route(AUTH_PATHS.wechat, { statusCode: 200, data: authResponse("one") });

    const outcome = await auth.requestWeChatAuth({
      code: "login-code-1",
      clientVersion: "0.9.10",
      deviceLabel: "iPhone"
    });

    assert.equal(outcome.ok, true);
    assert.equal(api.requests.length, 1);
    const request = api.requests[0];
    assert.equal(request.url, "https://relay-dev.example.com/v1/auth/wechat");
    assert.equal(request.method, "POST");
    assert.equal(request.header?.["Content-Type"], "application/json");
    assert.equal(request.timeout, AUTH_REQUEST_TIMEOUT_MS);
    assert.deepEqual(Object.keys(request.data as object).sort(), ["clientVersion", "code", "deviceLabel"]);
    assert.equal((request.data as { code: string }).code, "login-code-1");
  });

  test("omits deviceLabel rather than sending an empty one", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    api.route(AUTH_PATHS.wechat, { statusCode: 200, data: authResponse("one") });
    await auth.requestWeChatAuth({ code: "c", clientVersion: "1", deviceLabel: "" });
    assert.deepEqual(Object.keys(api.requests[0].data as object).sort(), ["clientVersion", "code"]);
  });

  test("a locally invalid code is refused without any request", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    const empty = await auth.requestWeChatAuth({ code: "", clientVersion: "1" });
    const overlong = await auth.requestWeChatAuth({ code: "c".repeat(257), clientVersion: "1" });
    assert.equal(empty.ok, false);
    assert.equal(overlong.ok, false);
    if (!empty.ok) {
      assert.equal(empty.failure.kind, "invalid_request");
    }
    assert.equal(api.requests.length, 0, "非法请求不得上线");
  });

  test("accepts only a response the frozen schema admits", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);

    api.route(AUTH_PATHS.wechat, {
      statusCode: 200,
      data: { ...authResponse("one"), extraField: "drift" }
    });
    const withUnknownField = await auth.requestWeChatAuth({ code: "c", clientVersion: "1" });
    assert.equal(withUnknownField.ok, false);
    if (!withUnknownField.ok) {
      assert.equal(withUnknownField.failure.kind, "invalid_response");
    }

    api.route(AUTH_PATHS.wechat, {
      statusCode: 200,
      data: { ...authResponse("one"), accessToken: "too-short" }
    });
    const shortToken = await auth.requestWeChatAuth({ code: "c", clientVersion: "1" });
    assert.equal(shortToken.ok, false);

    api.route(AUTH_PATHS.wechat, {
      statusCode: 200,
      data: { ...authResponse("one"), expiresIn: 10 }
    });
    const shortTtl = await auth.requestWeChatAuth({ code: "c", clientVersion: "1" });
    assert.equal(shortTtl.ok, false, "expiresIn 越界必须拒绝");
  });
});

describe("failure classification", () => {
  test("403 means the account is not the administrator", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    api.route(AUTH_PATHS.wechat, {
      statusCode: 403,
      data: { code: "forbidden", message: "admin authentication forbidden", retryable: false }
    });
    const outcome = await auth.requestWeChatAuth({ code: "c", clientVersion: "1" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.failure.kind, "non_admin");
      assert.equal(outcome.failure.code, "forbidden");
      assert.equal(outcome.failure.retryable, false);
      assert.equal(outcome.failure.statusCode, 403);
    }
  });

  test("401 means the credential/code was refused", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    api.route(AUTH_PATHS.wechat, {
      statusCode: 401,
      data: { code: "unauthorized", message: "wechat authentication failed", retryable: false }
    });
    const outcome = await auth.requestWeChatAuth({ code: "c", clientVersion: "1" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.failure.kind, "unauthorized");
    }
  });

  test("a 5xx structured error stays retryable and does not look like a rejection", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    api.route(AUTH_PATHS.wechat, {
      statusCode: 500,
      data: { code: "internal_error", message: "wechat upstream service error", retryable: true }
    });
    const outcome = await auth.requestWeChatAuth({ code: "c", clientVersion: "1" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.failure.kind, "server_error");
      assert.equal(outcome.failure.retryable, true);
    }
  });

  test("an unparsable body is a protocol failure, and its content is not echoed", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    api.route(AUTH_PATHS.wechat, { statusCode: 502, data: "<html>Bad Gateway</html>" });
    const outcome = await auth.requestWeChatAuth({ code: "c", clientVersion: "1" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.failure.kind, "invalid_response");
      assert.ok(!outcome.failure.message.includes("Bad Gateway"), "不得回显未经验证的响应体");
    }
  });

  test("a dropped connection is a retryable network failure", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    api.route(AUTH_PATHS.wechat, { networkError: "request:fail timeout" });
    const outcome = await auth.requestWeChatAuth({ code: "c", clientVersion: "1" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.failure.kind, "network");
      assert.equal(outcome.failure.retryable, true);
      assert.equal(outcome.failure.statusCode, null);
    }
  });

  test("a credential embedded in a platform error message is redacted", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    const secret = "SECRET-CODE-0123456789";
    api.route(AUTH_PATHS.wechat, { networkError: `request:fail url=/v1/auth/wechat?code=${secret}` });
    const outcome = await auth.requestWeChatAuth({ code: secret, clientVersion: "1" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(!outcome.failure.message.includes(secret), "错误信息不得包含登录码");
      assert.ok(outcome.failure.message.includes("[redacted]") || !outcome.failure.message.includes("code="));
    }
  });

  test("every protocol error code maps to a reaction", () => {
    const mapped = REMOTE_ERROR_CODES.map((code) => kindForErrorCode(code));
    assert.equal(mapped.length, REMOTE_ERROR_CODES.length);
    assert.equal(kindForErrorCode("forbidden"), "non_admin");
    for (const code of REMOTE_ERROR_CODES) {
      assert.ok(new Set(["non_admin", "unauthorized", "unsupported_version", "invalid_request", "server_error"]).has(kindForErrorCode(code)));
    }
  });
});

describe("refresh and logout", () => {
  test("refresh posts the refresh token and returns a rotated pair", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    const pair = tokenPair("rotated");
    api.route(AUTH_PATHS.refresh, {
      statusCode: 200,
      data: { accessToken: pair.accessToken, refreshToken: pair.refreshToken, expiresIn: 600, refreshExpiresIn: 7_200 }
    });
    const outcome = await auth.refresh(tokenPair("old").refreshToken);
    assert.equal(outcome.ok, true);
    assert.equal(api.requests[0].url, "https://relay-dev.example.com/v1/auth/refresh");
    assert.deepEqual(api.requests[0].data, { refreshToken: tokenPair("old").refreshToken });
  });

  test("logout carries the access token in the Authorization header, not the URL or body", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    const access = tokenPair("logout").accessToken;
    api.route(AUTH_PATHS.logout, { statusCode: 200, data: {} });
    const outcome = await auth.logout(access);
    assert.equal(outcome.ok, true);
    const request = api.requests[0];
    assert.equal(request.url, "https://relay-dev.example.com/v1/sessions/logout");
    assert.equal(request.header?.Authorization, `Bearer ${access}`);
    assert.deepEqual(request.data, {});
    assert.ok(!request.url.includes(access), "令牌不得出现在 URL 中");
  });

  test("logout reports failure without throwing, so the caller can still clear locally", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    api.route(AUTH_PATHS.logout, { networkError: "request:fail offline" });
    const outcome = await auth.logout(tokenPair("logout").accessToken);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.failure.kind, "network");
    }
  });

  test("a revoked refresh token surfaces as unauthorized", async () => {
    const api = createFakeAuthApi();
    const { auth } = client(api);
    api.route(AUTH_PATHS.refresh, {
      statusCode: 401,
      data: { code: "unauthorized", message: "invalid or expired refresh token", retryable: false }
    });
    const outcome = await auth.refresh(tokenPair("old").refreshToken);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.failure.kind, "unauthorized");
    }
  });
});

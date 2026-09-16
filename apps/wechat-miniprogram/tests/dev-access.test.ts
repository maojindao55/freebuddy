import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluateDevAccess, isLiteralLoopbackEndpoint, WECHAT_AUTH_LIMITATION } from "../miniprogram/config/devAccess";
import { ENVIRONMENTS } from "../miniprogram/config/environments";
import {
  createOperatorTokenSession,
  describeCredentialSources,
  getOperatorTokenSession,
  isPlausibleToken,
  resetOperatorTokenSession
} from "../miniprogram/services/adminSession";
import { createExplodingWechatApi } from "./helpers/fakeWechatApi";

const LOCAL_LOOPBACK = {
  envName: "local" as const,
  httpBaseUrl: "http://127.0.0.1:8080",
  wsBaseUrl: "ws://127.0.0.1:8080",
  envVersion: "develop" as const,
  armed: true
};

describe("dev access gate", () => {
  test("a release build never exposes the local DEV entry point", () => {
    const result = evaluateDevAccess({ ...LOCAL_LOOPBACK, envVersion: "release" });
    assert.deepEqual(result, {
      allowed: false,
      reason: "release_build",
      message: "正式版不允许本地 DEV 直连入口。"
    });
  });

  test("only the named local environment qualifies", () => {
    for (const envName of ["dev", "prod"] as const) {
      const result = evaluateDevAccess({
        ...LOCAL_LOOPBACK,
        envName,
        httpBaseUrl: ENVIRONMENTS[envName].httpBaseUrl,
        wsBaseUrl: ENVIRONMENTS[envName].wsBaseUrl
      });
      assert.equal(result.allowed, false);
      assert.equal(result.allowed === false && result.reason, "not_local_environment");
    }
  });

  test("loopback hostnames, LAN addresses and tunnel domains are refused", () => {
    for (const base of ["http://localhost:8080", "http://192.168.1.10:8080", "https://foo.ngrok.io", "http://127.0.0.1.evil.test"]) {
      assert.equal(isLiteralLoopbackEndpoint(base), false, `${base} must not count as loopback`);
    }
    assert.equal(isLiteralLoopbackEndpoint("ws://127.0.0.1:8080"), true);
    assert.equal(isLiteralLoopbackEndpoint("ws://[::1]:8080"), true);
    assert.equal(isLiteralLoopbackEndpoint("not a url"), false);

    const result = evaluateDevAccess({ ...LOCAL_LOOPBACK, wsBaseUrl: "ws://192.168.1.10:8080" });
    assert.equal(result.allowed, false);
    assert.equal(result.allowed === false && result.reason, "non_loopback_endpoint");
  });

  test("an unarmed session has no path even when everything else matched", () => {
    assert.deepEqual(evaluateDevAccess({ ...LOCAL_LOOPBACK, armed: false }), {
      allowed: false,
      reason: "not_armed",
      message: "请先明确开启本地 DEV 入口。"
    });
  });

  test("the gate never downgrades TLS: local-only tokens are paired with local-only endpoints", () => {
    // Passing combination stays strict about its own environment: it is local + loopback only.
    assert.deepEqual(evaluateDevAccess(LOCAL_LOOPBACK), { allowed: true });

    // dev/prod environments keep https+wss regardless of anything the client asks for.
    assert.equal(ENVIRONMENTS.prod.wsBaseUrl.startsWith("wss://"), true);
    assert.equal(ENVIRONMENTS.dev.wsBaseUrl.startsWith("wss://"), true);
    assert.equal(ENVIRONMENTS.prod.allowInsecureTransport, false);
    assert.equal(ENVIRONMENTS.dev.allowInsecureTransport, false);
  });
});

describe("operator token session", () => {
  test("the token lives in memory and never touches WeChat storage", () => {
    const api = createExplodingWechatApi();
    const session = createOperatorTokenSession();
    session.setToken("dev token value");
    session.readToken();
    session.clear();
    assert.equal(api.calls.length, 0, "no WeChat API call may ever be made for the token");
    assert.equal(session.readToken(), null);
    assert.equal(session.hasToken(), false);
  });

  test("impossible token values are rejected without echoing them", () => {
    const session = createOperatorTokenSession();
    for (const raw of ["", "  ", "a b", "x".repeat(513), null, undefined, 42]) {
      const result = session.setToken(raw as string | null | undefined);
      assert.equal(result.accepted, false, `${String(raw)} must be refused`);
      assert.equal(result.length, 0);
      assert.equal(session.hasToken(), false);
    }
    assert.equal(isPlausibleToken("abc.def_1"), true);
    assert.equal(isPlausibleToken("with space"), false);
  });

  test("acceptance reports length only and never the value", () => {
    const session = createOperatorTokenSession();
    const result = session.setToken("local-dev-token");
    assert.deepEqual(result, { accepted: true, length: 15 });
    assert.doesNotMatch(JSON.stringify(result), /local-dev-token/);
    assert.equal(session.readToken(), "local-dev-token");
  });

  test("the process-wide session is resettable for tests", () => {
    const first = getOperatorTokenSession();
    first.setToken("token-a");
    assert.equal(getOperatorTokenSession().readToken(), "token-a");
    resetOperatorTokenSession();
    assert.equal(getOperatorTokenSession().readToken(), null);
  });
});

describe("credential source view", () => {
  test("wechat login is described as unavailable, not faked", () => {
    const views = describeCredentialSources({
      envName: "local",
      httpBaseUrl: LOCAL_LOOPBACK.httpBaseUrl,
      wsBaseUrl: LOCAL_LOOPBACK.wsBaseUrl,
      envVersion: "develop",
      devArmed: true,
      hasToken: true
    });
    const wechat = views[0];
    assert.equal(wechat.source, "wechat_code");
    assert.equal(wechat.available, false);
    assert.equal(wechat.actionEnabled, false);
    assert.equal(wechat.detail, WECHAT_AUTH_LIMITATION);
    assert.match(wechat.detail, /\/v1\/auth\/wechat/);
  });

  test("the DEV source is labelled as what it is and leaks nothing", () => {
    const armed = describeCredentialSources({
      envName: "local",
      httpBaseUrl: LOCAL_LOOPBACK.httpBaseUrl,
      wsBaseUrl: LOCAL_LOOPBACK.wsBaseUrl,
      envVersion: "develop",
      devArmed: true,
      hasToken: true
    })[1];
    assert.equal(armed.source, "dev_operator_token");
    assert.match(armed.detail, /不是微信身份/);
    assert.equal(armed.actionEnabled, true);

    const release = describeCredentialSources({
      envName: "prod",
      httpBaseUrl: ENVIRONMENTS.prod.httpBaseUrl,
      wsBaseUrl: ENVIRONMENTS.prod.wsBaseUrl,
      envVersion: "release",
      devArmed: false,
      hasToken: false
    })[1];
    assert.equal(release.available, false);
    assert.equal(release.actionEnabled, false);
    assert.doesNotMatch(`${release.detail} ${release.actionLabel}`, /token|secret/i);
    assert.equal(armed.actionLabel.includes("•••"), true, "the UI shows a fixed mask, never token material");
  });
});

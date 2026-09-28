/**
 * Login view tests.
 *
 * The view is a pure projection of `AuthState`. What matters is that each outcome is described
 * honestly — a refused account is not told "network error", a DEV connection is not called a
 * WeChat login — and that nothing the UI can render contains credential material or an endpoint.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AuthState } from "../miniprogram/services/authSession";
import { describeWeChatLogin, WECHAT_LOGIN_TITLE } from "../miniprogram/services/loginView";

function state(overrides: Partial<AuthState> = {}): AuthState {
  return {
    mode: "none",
    status: "signedOut",
    hasCredential: false,
    accessExpiresAtMs: null,
    refreshExpiresAtMs: null,
    accessExpired: false,
    refreshExpired: false,
    lastErrorKind: null,
    lastError: "",
    ...overrides
  };
}

describe("login view", () => {
  test("signed out offers a working WeChat login", () => {
    const view = describeWeChatLogin(state());
    assert.equal(view.title, WECHAT_LOGIN_TITLE);
    assert.equal(view.actionEnabled, true);
    assert.equal(view.tone, "neutral");
    assert.match(view.message, /微信登录/);
    assert.equal(view.canRefresh, false);
  });

  test("a non-administrator is told the account is refused, and may try another", () => {
    const view = describeWeChatLogin(state({ mode: "wechat", status: "rejected", lastErrorKind: "non_admin" }));
    assert.equal(view.tone, "error");
    assert.equal(view.actionEnabled, true);
    assert.equal(view.actionLabel, "换账号重试");
    assert.match(view.message, /不是唯一管理员/);
  });

  test("a network failure is presented as retryable, not as a rejected identity", () => {
    const view = describeWeChatLogin(
      state({ mode: "wechat", status: "error", lastErrorKind: "network", lastError: "网络不可用，未能完成登录，请检查网络后重试。" })
    );
    assert.equal(view.tone, "warn");
    assert.equal(view.actionEnabled, true);
    assert.match(view.message, /网络/);
    assert.doesNotMatch(view.message, /管理员/);
  });

  test("an expired session offers refresh when a stored pair still exists", () => {
    const expiring = describeWeChatLogin(
      state({
        mode: "wechat",
        status: "expired",
        hasCredential: false,
        accessExpiresAtMs: 1,
        refreshExpiresAtMs: 2,
        accessExpired: true
      })
    );
    assert.equal(expiring.canRefresh, true);
    assert.equal(expiring.actionEnabled, true);
    assert.equal(expiring.actionLabel, "重新登录");

    const refreshDead = describeWeChatLogin(
      state({ mode: "wechat", status: "expired", refreshExpired: true, refreshExpiresAtMs: 1, accessExpiresAtMs: 0 })
    );
    assert.equal(refreshDead.canRefresh, false, "刷新令牌也失效时不得再提供刷新");
  });

  test("a signed-in WeChat session needs no further action", () => {
    const view = describeWeChatLogin(state({ mode: "wechat", status: "signedIn", hasCredential: true }));
    assert.equal(view.tone, "ok");
    assert.equal(view.actionEnabled, false);
    assert.equal(view.actionLabel, "已登录");
  });

  test("a DEV connection is labelled as not a WeChat login", () => {
    const view = describeWeChatLogin(state({ mode: "dev", status: "signedIn", hasCredential: true }));
    assert.match(view.message, /DEV/);
    assert.match(view.message, /不是微信登录/);
    assert.equal(view.actionEnabled, true, "DEV 会话下仍允许改用微信登录");
  });

  test("busy states disable the action", () => {
    for (const status of ["authenticating", "refreshing"] as const) {
      const view = describeWeChatLogin(state({ mode: "wechat", status }));
      assert.equal(view.actionEnabled, false, `${status} 必须禁用按钮`);
    }
  });

  test("no rendered value carries credential material or an endpoint", () => {
    const statuses: AuthState["status"][] = [
      "signedOut",
      "authenticating",
      "signedIn",
      "refreshing",
      "expired",
      "rejected",
      "error"
    ];
    for (const status of statuses) {
      for (const mode of ["none", "dev", "wechat"] as const) {
        const serialized = JSON.stringify(describeWeChatLogin(state({ status, mode })));
        assert.doesNotMatch(serialized, /https?:\/\//, `${status}/${mode} 不得渲染端点`);
        assert.doesNotMatch(serialized, /accessToken|refreshToken|appSecret|Bearer/);
      }
    }
  });
});

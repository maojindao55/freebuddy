/**
 * The WeChat login view model for the connect page.
 *
 * This is a pure projection of `AuthState` — no `wx` call, no storage, no endpoint and no
 * credential material. Keeping it pure is what makes the page's copy testable, and it is also why
 * the page can never show a toast that contains a login code or a token: the only strings that
 * reach the UI are the fixed ones below plus `AuthState.lastError`, which `services/authSession.ts`
 * has already redacted.
 *
 * The copy states what is actually true. A DEV connection is *not* a WeChat login and is labelled
 * as such; a refused account is told it is not the administrator; a transient network failure is
 * presented as retryable rather than as a rejected identity.
 */

import type { AuthState, AuthStatus } from "./authSession";

export type LoginTone = "neutral" | "ok" | "warn" | "error";

export interface WeChatLoginView {
  readonly status: AuthStatus;
  readonly title: string;
  readonly message: string;
  readonly actionLabel: string;
  readonly actionEnabled: boolean;
  readonly tone: LoginTone;
  /** A stored session can be rotated in place, so the operator may retry without re-login. */
  readonly canRefresh: boolean;
}

export const WECHAT_LOGIN_TITLE = "FreeBuddy 远程管理";

const DEFAULT_SIGNED_OUT_MESSAGE =
  "使用微信登录唯一管理员账号：登录码只发送到本环境配置的 Relay，客户端不保存微信密钥，也不上报微信身份。";

const DEV_MODE_MESSAGE =
  "当前使用本地 DEV 直连凭证（不是微信登录）。微信登录成功后会取代该凭证。";

export function describeWeChatLogin(state: AuthState): WeChatLoginView {
  const hasStoredSession = state.accessExpiresAtMs !== null && !state.refreshExpired;

  const base = {
    status: state.status,
    title: WECHAT_LOGIN_TITLE,
    canRefresh: state.mode === "wechat" && hasStoredSession
  } as const;

  switch (state.status) {
    case "authenticating":
      return {
        ...base,
        message: "正在通过微信登录…",
        actionLabel: "登录中…",
        actionEnabled: false,
        tone: "neutral"
      };

    case "refreshing":
      return {
        ...base,
        message: "正在刷新登录状态…",
        actionLabel: "刷新中…",
        actionEnabled: false,
        tone: "neutral"
      };

    case "rejected":
      return {
        ...base,
        message: state.lastError.length > 0 ? state.lastError : "该微信账号不是唯一管理员，已拒绝进入。",
        actionLabel: "换账号重试",
        actionEnabled: true,
        tone: "error"
      };

    case "expired":
      return {
        ...base,
        message: state.lastError.length > 0 ? state.lastError : "登录状态已过期，请重新登录。",
        actionLabel: "重新登录",
        actionEnabled: true,
        tone: "warn"
      };

    case "error":
      return {
        ...base,
        message: state.lastError.length > 0 ? state.lastError : "登录未能完成，请重试。",
        actionLabel: "重试",
        actionEnabled: true,
        tone: "warn"
      };

    case "signedIn":
      return state.mode === "dev"
        ? {
            ...base,
            message: DEV_MODE_MESSAGE,
            actionLabel: "微信登录",
            actionEnabled: true,
            tone: "neutral"
          }
        : {
            ...base,
            message: "已通过微信登录为唯一管理员。",
            actionLabel: "已登录",
            actionEnabled: false,
            tone: "ok"
          };

    default:
      return {
        ...base,
        message: DEFAULT_SIGNED_OUT_MESSAGE,
        actionLabel: "微信登录",
        actionEnabled: true,
        tone: "neutral"
      };
  }
}

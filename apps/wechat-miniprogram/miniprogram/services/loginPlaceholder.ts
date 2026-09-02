/**
 * Login placeholder view model (W1).
 *
 * Deliberately does no authentication: it never calls `wx.login`, never exchanges a code and
 * never writes to storage. Real admin login is W2 and must go through the Relay
 * `/v1/auth/wechat` endpoint, where the server compares `ADMIN_OPENID`. A client that claims
 * to be the administrator has no effect.
 */

export type LoginPlaceholderStatus = "auth_not_implemented";

export interface LoginPlaceholderView {
  readonly status: LoginPlaceholderStatus;
  readonly title: string;
  readonly message: string;
  readonly actionLabel: string;
  readonly actionEnabled: boolean;
}

export const LOGIN_PLACEHOLDER_MESSAGE =
  "管理员登录将在 W2 通过 Relay /v1/auth/wechat 接入。当前构建不会调用 wx.login，也不会保存任何令牌。";

export function getLoginPlaceholderView(): LoginPlaceholderView {
  return {
    status: "auth_not_implemented",
    title: "FreeBuddy 远程管理",
    message: LOGIN_PLACEHOLDER_MESSAGE,
    actionLabel: "微信登录（未开放）",
    actionEnabled: false
  };
}

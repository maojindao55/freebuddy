/**
 * Login placeholder view model (W1).
 *
 * Deliberately does no authentication: it never calls `wx.login`, never exchanges a code and
 * never writes to storage. Real admin login is not implemented, because the Relay exposes no
 * `/v1/auth/wechat`, so there is nothing for a code exchange to talk to. The only credential this
 * stage can hold is the Relay's own DEV operator token, entered through the local-only gate in
 * `services/devConnect.ts` — which is not an administrator identity and is labelled as such.
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
  "微信管理员登录尚未开放：Relay 未实现 /v1/auth/wechat，无法完成 code2Session 交换。" +
  "本构建不会调用 wx.login，也不保存任何微信派生凭证。";

export function getLoginPlaceholderView(): LoginPlaceholderView {
  return {
    status: "auth_not_implemented",
    title: "FreeBuddy 远程管理",
    message: LOGIN_PLACEHOLDER_MESSAGE,
    actionLabel: "微信登录（未开放）",
    actionEnabled: false
  };
}

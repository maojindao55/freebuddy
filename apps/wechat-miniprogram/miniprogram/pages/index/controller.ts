/**
 * Connect page controller (route `pages/index/index`).
 *
 * Two credential paths meet on this page, and the page keeps them visibly distinct:
 *
 * - **WeChat administrator login** (the production path): `wx.login` -> `/v1/auth/wechat`, driven
 *   entirely by `services/authSession.ts`. The page only starts it, renders the resulting state and
 *   forwards the operator to the read-only console on success.
 * - **local DEV direct connect** (fallback): rendered only when `services/devConnect.ts` says the
 *   build/environment allows it, so a release build has no visible entry and no reachable path.
 *
 * What the page must never do, and does not: read a credential itself, keep a token in page data,
 * accept an endpoint from input, or claim a DEV connection is a WeChat identity. The token field is
 * emptied as soon as it is committed, and the socket URL is rendered read-only.
 */

import type { AdminConnection } from "../../services/adminConnection";
import type { AuthSession } from "../../services/authSession";
import type { DevConnectController } from "../../services/devConnect";
import { buildConnectionBanner, type ConnectionBanner } from "../../services/pageViews";
import type { PageRuntime } from "../../platform/pageRuntime";
import { describeWeChatLogin, type LoginTone } from "../../services/loginView";
import { maskSecret } from "../../utils/view";

export interface LoginPageData {
  readonly title: string;
  readonly message: string;
  readonly wechatActionLabel: string;
  readonly wechatActionEnabled: boolean;
  readonly wechatTone: LoginTone;
  /** A stored WeChat session can be rotated without a full re-login. */
  readonly canRefreshSession: boolean;
  /** True while a credential (DEV or WeChat) is usable. */
  readonly hasCredential: boolean;
  readonly credentialMode: string;
  readonly environment: string;
  readonly banner: ConnectionBanner;
  readonly bannerDetail: string;
  readonly devVisible: boolean;
  readonly devAvailable: boolean;
  readonly devArmed: boolean;
  readonly devBlockMessage: string;
  readonly devHostId: string;
  readonly devHasHostId: boolean;
  readonly devHasToken: boolean;
  /** Fixed placeholder while a DEV token is held; empty string when none. Never the value. */
  readonly devTokenMask: string;
  readonly devNotice: string;
  readonly devSocketUrl: string;
  /** The DEV gate is open, so a token may be entered and stored in memory. */
  readonly canSaveToken: boolean;
  readonly canConnect: boolean;
  readonly canSignOut: boolean;
  readonly canEnterConsole: boolean;
  /** Reminds the operator to clear the token field after typing. */
  readonly tokenFieldHint: string;
}

export const TOKEN_FIELD_HINT = "输入后立即写入内存，输入框会清空，页面不保留原值。";

export interface LoginControllerOptions {
  readonly connection: AdminConnection;
  readonly dev: DevConnectController;
  readonly auth: AuthSession;
  readonly runtime: PageRuntime;
  readonly environmentName: string;
  readonly setData: (data: LoginPageData) => void;
}

export interface LoginController {
  start(): void;
  stop(): void;
  render(): void;
  toggleArm(): void;
  setHostId(raw: string): void;
  commitToken(raw: string): void;
  connect(): void;
  signOut(): void;
  openHome(): void;
  /** Starts a WeChat administrator login. Single-flight inside the auth session. */
  wechatLogin(): void;
  /** Rotates the stored session in place; only offered when a stored pair exists. */
  refreshSession(): void;
}

export function createLoginController(options: LoginControllerOptions): LoginController {
  const { connection, dev, auth, runtime } = options;
  let started = false;
  let unsubscribeDev: (() => void) | null = null;
  let unsubscribeConnection: (() => void) | null = null;
  let unsubscribeAuth: (() => void) | null = null;

  function build(): LoginPageData {
    const login = describeWeChatLogin(auth.getState());
    const connectionState = connection.stores.connection.getState();
    const devState = dev.getState();
    const authState = auth.getState();
    const hasCredential = connection.hasCredential();
    const hasHostId = devState.hasHostId;
    return {
      title: login.title,
      message: login.message,
      wechatActionLabel: login.actionLabel,
      wechatActionEnabled: login.actionEnabled,
      wechatTone: login.tone,
      canRefreshSession: login.canRefresh,
      hasCredential,
      credentialMode: authState.mode,
      environment: options.environmentName,
      banner: buildConnectionBanner(connectionState),
      bannerDetail: devState.blockMessage,
      devVisible: devState.visible,
      devAvailable: devState.available,
      devArmed: devState.armed,
      devBlockMessage: devState.blockMessage,
      devHostId: devState.hostId,
      devHasHostId: devState.hasHostId,
      devHasToken: devState.hasToken,
      devTokenMask: devState.hasToken ? maskSecret() : "",
      devNotice: devState.notice,
      devSocketUrl: devState.socketUrl,
      canSaveToken: devState.available,
      canConnect: devState.available && devState.hasHostId && devState.hasToken,
      canSignOut: hasCredential,
      canEnterConsole: hasCredential && hasHostId,
      tokenFieldHint: TOKEN_FIELD_HINT
    };
  }

  function render(): void {
    // A torn-down page must never be written to: a late frame would otherwise resurrect it.
    if (!started) {
      return;
    }
    options.setData(build());
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      unsubscribeDev = dev.subscribe(render);
      unsubscribeConnection = connection.stores.connection.subscribe(render);
      unsubscribeAuth = auth.subscribe(render);
      render();
    },

    stop() {
      started = false;
      unsubscribeDev?.();
      unsubscribeDev = null;
      unsubscribeConnection?.();
      unsubscribeConnection = null;
      unsubscribeAuth?.();
      unsubscribeAuth = null;
    },

    render,

    toggleArm() {
      if (dev.getState().armed) {
        dev.disarm();
      } else {
        dev.arm();
      }
      render();
    },

    setHostId(raw) {
      const result = dev.setHostId(raw);
      if (!result.accepted && result.reason !== undefined) {
        runtime.showToast({ title: result.reason });
      }
      render();
    },

    commitToken(raw) {
      const result = dev.setToken(raw);
      if (!result.accepted && result.reason !== undefined) {
        runtime.showToast({ title: result.reason });
      }
      // The page never keeps the value: the field is cleared and only the mask is rendered.
      render();
    },

    connect() {
      const result = dev.connect();
      if (!result.connected) {
        runtime.showToast({ title: result.reason ?? "无法连接" });
      } else {
        runtime.showToast({ title: "已发起 DEV 连接" });
      }
      render();
    },

    signOut() {
      void runtime
        .showConfirm({
          title: "退出并清除凭证",
          content: "将断开连接并清除本机的登录状态（DEV 令牌、微信会话、主机标识与本地缓存）。",
          confirmText: "退出"
        })
        .then((confirmed) => {
          if (!confirmed) {
            return;
          }
          // Best-effort server revocation first, then unconditional local isolation. The DEV
          // controller's sign-out runs through the connection, which clears the credential store
          // (WeChat session included), the host target, the caches and the persisted cursors, so
          // the two paths cannot disagree about what survived.
          void auth.logout().then(() => {
            dev.signOut();
            render();
          });
        });
    },

    openHome() {
      runtime.navigateTo("/pages/home/home");
    },

    wechatLogin() {
      // Single-flight inside the auth session, so a double tap cannot spend two login codes.
      void auth.loginWithWeChat().then((outcome) => {
        if (outcome.ok) {
          runtime.showToast({ title: "微信登录成功", icon: "success" });
          // The credential now exists; the socket can authenticate.
          connection.connect("微信管理员登录");
        } else {
          // The message is already redacted by the auth session; the view renders it too.
          runtime.showToast({ title: outcome.message });
        }
        render();
      });
    },

    refreshSession() {
      void auth.refreshNow().then(() => render());
    }
  };
}

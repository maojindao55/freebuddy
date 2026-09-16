/**
 * Connect page controller (route `pages/index/index`).
 *
 * The only page that can turn a credential into a session, and the only page that renders the
 * local DEV entry. It is deliberately explicit about what is *not* available:
 *
 * - the WeChat login button stays disabled; there is no `wx.login` call anywhere in this stage;
 * - the DEV panel is rendered only when `services/devConnect.ts` says the build/environment allows
 *   it, so a release build has no visible entry and no reachable code path;
 * - the token field never echoes: `commitToken` forwards the value, clears the input back to empty
 *   and stores only the fixed mask in page data;
 * - there is no endpoint field at all. The socket URL is derived from the environment table and
 *   rendered read-only.
 */

import type { AdminConnection } from "../../services/adminConnection";
import type { DevConnectController } from "../../services/devConnect";
import { buildConnectionBanner, type ConnectionBanner } from "../../services/pageViews";
import type { PageRuntime } from "../../platform/pageRuntime";
import { getLoginPlaceholderView } from "../../services/loginPlaceholder";
import { maskSecret } from "../../utils/view";

export interface LoginPageData {
  readonly title: string;
  readonly message: string;
  readonly wechatActionLabel: string;
  readonly wechatActionEnabled: boolean;
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
  /** Fixed placeholder while a token is held; empty string when none. Never the value. */
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
  /** Kept for the W1 placeholder button: it must remain inert. */
  wechatLogin(): void;
}

export function createLoginController(options: LoginControllerOptions): LoginController {
  const { connection, dev, runtime } = options;
  let started = false;
  let unsubscribeDev: (() => void) | null = null;
  let unsubscribeConnection: (() => void) | null = null;

  function build(): LoginPageData {
    const placeholder = getLoginPlaceholderView();
    const connectionState = connection.stores.connection.getState();
    const devState = dev.getState();
    return {
      title: placeholder.title,
      message: placeholder.message,
      wechatActionLabel: placeholder.actionLabel,
      wechatActionEnabled: false,
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
      canSignOut: devState.hasToken,
      canEnterConsole: devState.hasToken && devState.hasHostId,
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
      render();
    },

    stop() {
      started = false;
      unsubscribeDev?.();
      unsubscribeDev = null;
      unsubscribeConnection?.();
      unsubscribeConnection = null;
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
          title: "断开并清除凭证",
          content: "将断开连接并清除内存中的 DEV 令牌、主机标识与本地缓存。",
          confirmText: "清除"
        })
        .then((confirmed) => {
          if (!confirmed) {
            return;
          }
          dev.signOut();
          render();
        });
    },

    openHome() {
      runtime.navigateTo("/pages/home/home");
    },

    wechatLogin() {
      // Intentionally inert: no wx.login, no code exchange, no token. The label already says the
      // entry is unavailable, so a silent no-op is the correct behaviour.
    }
  };
}

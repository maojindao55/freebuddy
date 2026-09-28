/**
 * Home page controller (route `pages/home/home`).
 *
 * Renders the single-host overview: connection state, host status, run/decision/terminal counters
 * and the read-only project/decision/task summaries. It names which credential is in force, so a
 * local DEV connection is never presented as a WeChat administrator login.
 *
 * Lifecycle: `start()` on `onShow`, `stop()` on `onHide` and `onUnload`. Recovery state lives in
 * the App session, so leaving this page never loses a cursor or a connection; only the page's
 * subscriptions and `setData` traffic stop.
 */

import type { AdminConnection } from "../../services/adminConnection";
import type { AuthSession } from "../../services/authSession";
import type { DevConnectController } from "../../services/devConnect";
import { ROUTES, buildHomeView, type HomeView } from "../../services/pageViews";
import type { PageRuntime } from "../../platform/pageRuntime";
import { describeErrorCode } from "../../stores/connectionStore";

export interface HomePageData extends HomeView {
  /** Last `host.status` read failure, redacted for display. */
  readonly hostStatusError: string | null;
}

export interface HomeControllerOptions {
  readonly connection: AdminConnection;
  readonly dev: DevConnectController;
  readonly auth: AuthSession;
  readonly runtime: PageRuntime;
  readonly environmentName: string;
  readonly setData: (data: HomePageData) => void;
}

export interface HomeController {
  start(): void;
  stop(): void;
  render(): void;
  reloadStatus(): void;
  reconnect(): void;
  openConversations(): void;
  logout(): void;
}

export function createHomeController(options: HomeControllerOptions): HomeController {
  const { connection, dev, auth, runtime } = options;
  let started = false;
  let hostStatusError: string | null = null;
  let lastStatus: string | null = null;
  let statusReadInFlight = false;
  let unsubscribeConnection: (() => void) | null = null;
  let unsubscribeHost: (() => void) | null = null;
  let unsubscribeAuth: (() => void) | null = null;

  function credentialSource(): "wechat_code" | "dev_operator_token" | "none" {
    const mode = auth.getState().mode;
    if (mode === "dev") {
      return "dev_operator_token";
    }
    return mode === "wechat" ? "wechat_code" : "none";
  }

  function build(): HomePageData {
    const view = buildHomeView({
      connection: connection.stores.connection.getState(),
      host: connection.stores.host.getState(),
      environmentName: options.environmentName,
      // Exactly which credential is in force; a DEV session is never presented as a WeChat login.
      credentialSource: credentialSource()
    });
    return { ...view, hostStatusError };
  }

  function render(): void {
    if (!started) {
      return;
    }
    options.setData(build());
  }

  async function loadStatus(): Promise<void> {
    if (statusReadInFlight) {
      return;
    }
    const hostId = connection.getHostId();
    if (hostId === null || connection.stores.connection.getState().status !== "online") {
      return;
    }
    statusReadInFlight = true;
    try {
      const result = await connection.state.loadHostStatus();
      hostStatusError = result.ok ? null : describeErrorCode(result.error.code) || result.error.message;
    } finally {
      statusReadInFlight = false;
    }
    render();
  }

  function handleConnectionChange(): void {
    const status = connection.stores.connection.getState().status;
    const previous = lastStatus;
    lastStatus = status;
    if (status === "online" && previous !== "online") {
      // A count that was stale while the host was disconnected must not be shown as current.
      void loadStatus();
    }
    render();
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      lastStatus = connection.stores.connection.getState().status;
      unsubscribeConnection = connection.stores.connection.subscribe(handleConnectionChange);
      unsubscribeHost = connection.stores.host.subscribe(render);
      unsubscribeAuth = auth.subscribe(render);
      render();
      void loadStatus();
    },

    stop() {
      started = false;
      unsubscribeConnection?.();
      unsubscribeConnection = null;
      unsubscribeHost?.();
      unsubscribeHost = null;
      unsubscribeAuth?.();
      unsubscribeAuth = null;
    },

    render,

    reloadStatus() {
      void loadStatus();
      render();
    },

    reconnect() {
      // Explicit operator action only: automatic backoff is the socket layer's job.
      connection.connect("操作员手动重连");
      render();
    },

    openConversations() {
      runtime.navigateTo(ROUTES.conversations);
    },

    logout() {
      void runtime
        .showConfirm({
          title: "退出并清除凭证",
          content: "将断开连接、尽力撤销服务端会话，并清除本机登录状态、主机标识与本地缓存，返回连接页。",
          confirmText: "退出"
        })
        .then((confirmed) => {
          if (!confirmed) {
            return;
          }
          // Best-effort server revocation first (a network failure must not block the local
          // cleanup), then the isolation pass, then back to the connect page.
          void auth.logout().then(() => {
            dev.signOut();
            runtime.reLaunch(ROUTES.login);
          });
        });
    }
  };
}

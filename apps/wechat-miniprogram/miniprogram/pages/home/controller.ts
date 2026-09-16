/**
 * Home page controller (route `pages/home/home`).
 *
 * Renders the single-host overview: connection state, host status, run/decision/terminal counters
 * and the read-only project/decision/task summaries. It is the page that makes "this is a DEV
 * connection, not a WeChat administrator login" impossible to miss.
 *
 * Lifecycle: `start()` on `onShow`, `stop()` on `onHide` and `onUnload`. Recovery state lives in
 * the App session, so leaving this page never loses a cursor or a connection; only the page's
 * subscriptions and `setData` traffic stop.
 */

import type { AdminConnection } from "../../services/adminConnection";
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
  const { connection, dev, runtime } = options;
  let started = false;
  let hostStatusError: string | null = null;
  let lastStatus: string | null = null;
  let statusReadInFlight = false;
  let unsubscribeConnection: (() => void) | null = null;
  let unsubscribeHost: (() => void) | null = null;

  function build(): HomePageData {
    const view = buildHomeView({
      connection: connection.stores.connection.getState(),
      host: connection.stores.host.getState(),
      environmentName: options.environmentName,
      // The only credential this stage can hold is the DEV operator token; saying otherwise
      // would present a DEV session as an administrator login.
      credentialSource: dev.getState().hasToken ? "dev_operator_token" : "none"
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
      render();
      void loadStatus();
    },

    stop() {
      started = false;
      unsubscribeConnection?.();
      unsubscribeConnection = null;
      unsubscribeHost?.();
      unsubscribeHost = null;
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
          title: "断开并清除凭证",
          content: "将断开连接并清除内存中的 DEV 令牌、主机标识与本地缓存，返回连接页。",
          confirmText: "清除"
        })
        .then((confirmed) => {
          if (!confirmed) {
            return;
          }
          dev.signOut();
          runtime.reLaunch(ROUTES.login);
        });
    }
  };
}

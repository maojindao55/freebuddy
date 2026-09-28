/**
 * App-scoped session: the one place the transport, the recovery layer and the DEV gate are
 * assembled.
 *
 * The mini program may be reclaimed at any moment, and pages come and go with navigation, so
 * everything with a lifetime longer than a page lives here and is owned by the App:
 *
 * - exactly **one** `AdminConnection` (one socket, one RPC client, one resume manager) per
 *   process. Pages receive typed reads and stores; they never see a socket and never call
 *   `wx.connectSocket`.
 * - exactly **one** network-status listener. The socket already suppresses duplicate reconnect
 *   timers, but re-registering on every `onShow` would still leak listeners across a long
 *   session, so registration is idempotent.
 * - `onShow` re-evaluates the connection (a backgrounded mini program must not assume its socket
 *   survived) and `onHide` persists the cursor before WeChat may freeze the process.
 * - the administrator credential (`services/authSession.ts`): a WeChat-issued, persisted session
 *   refreshed on foreground, plus the local-only DEV operator token. The pages never hold either;
 *   they ask this session, which is also what the transport's credential seam reads.
 *
 * This file decides *nothing* about what the wire means — that is `services/adminState.ts` — and
 * it exposes no write surface.
 */

import { getActiveEnvironment, type ResolvedEnvironment } from "../config/runtimeConfig";
import type { AdminConnection } from "./adminConnection";
import { createAdminConnection } from "./adminConnection";
import type { WechatApi } from "../platform/wechatApi";
import { getWechatApi } from "../platform/wechatApiProvider";
import { createWechatResumeCursorStorage } from "./resumeCursorStorage";
import { createDefaultScheduler, nextIdFactory, type IdFactory, type Scheduler } from "../utils/scheduler";
import { createDevConnectController, type DevConnectController } from "./devConnect";
import { createAuthSession, type AuthSession } from "./authSession";
import { getOperatorTokenSession, type OperatorTokenSession } from "./adminSession";
import type { AuthTokenStore } from "./tokenStore";

/** The admin endpoint is derived from the environment table; it is never operator input. */
export function adminSocketUrlFor(wsBaseUrl: string): string {
  return `${wsBaseUrl}/v1/ws/admin`;
}

export interface AppSessionOptions {
  readonly api: WechatApi;
  readonly environment: ResolvedEnvironment;
  readonly clientVersion?: string;
  readonly scheduler?: Scheduler;
  readonly nextId?: IdFactory;
  /** Injection point for tests; production always builds one connection. */
  readonly connection?: AdminConnection;
  /** Injection point for tests; production always builds one auth session. */
  readonly auth?: AuthSession;
  readonly tokenStore?: AuthTokenStore;
  /** In-memory DEV credential, shared by the DEV controller and the auth session. */
  readonly devTokenSession?: OperatorTokenSession;
}

export interface AppSession {
  readonly environment: ResolvedEnvironment;
  readonly connection: AdminConnection;
  readonly dev: DevConnectController;
  /** Administrator authentication (WeChat login, rotation, logout). */
  readonly auth: AuthSession;
  /** Registers the single network listener. Idempotent. */
  start(): void;
  onShow(): void;
  onHide(): void;
  /** Unregisters the network listener and tears the connection down. */
  dispose(): void;
}

export function createAppSession(options: AppSessionOptions): AppSession {
  const { api, environment } = options;
  const envVersion = api.getEnvVersion();
  const clientVersion = options.clientVersion ?? api.getClientInfo().version ?? "0.0.0";

  // One DEV credential instance for the whole process: the DEV controller writes through the
  // connection, and the auth session reads the same object, so both always agree on whether a DEV
  // token is in force.
  const devTokenSession = options.devTokenSession ?? getOperatorTokenSession();

  const auth =
    options.auth ??
    createAuthSession({
      api,
      environment,
      clientVersion,
      tokenStore: options.tokenStore,
      devSession: devTokenSession
    });

  const connection: AdminConnection =
    options.connection ??
    createAdminConnection({
      adminSocketUrl: adminSocketUrlFor(environment.wsBaseUrl),
      clientVersion,
      createSocket: (url) => api.connectSocket({ url }),
      scheduler: options.scheduler ?? createDefaultScheduler(),
      isoNow: () => new Date().toISOString(),
      nextId: options.nextId ?? nextIdFactory,
      tokenSession: devTokenSession,
      // The transport never learns where a token came from: it asks this credential.
      credential: auth.credential,
      // Cursors are the only thing persisted; see `services/resumeCursorStorage.ts`.
      resumeStorage: createWechatResumeCursorStorage(api)
    });

  const dev = createDevConnectController({
    target: connection,
    envName: environment.name,
    envVersion,
    httpBaseUrl: environment.httpBaseUrl,
    wsBaseUrl: environment.wsBaseUrl
  });

  let networkUnsubscribe: (() => void) | null = null;

  function start(): void {
    if (networkUnsubscribe !== null || typeof api.onNetworkStatusChange !== "function") {
      return;
    }
    networkUnsubscribe = api.onNetworkStatusChange((status) => {
      connection.notifyNetworkChange(status.isConnected === true);
    });
  }

  return {
    environment,
    connection,
    dev,
    auth,

    start,

    onShow() {
      start();
      // Returns to the foreground: prove the socket is alive, or reconnect. A WeChat access token
      // may have expired while the process was frozen, and presenting an expired token would only
      // earn a `forbidden`, so the token is rotated *before* the reconnect. The DEV path has
      // nothing to rotate and therefore stays synchronous.
      if (auth.needsRefresh()) {
        void auth.refreshNow().then(() => connection.notifyForeground());
        return;
      }
      connection.notifyForeground();
    },

    onHide() {
      // WeChat may reclaim the process here, so the cursor is written while it is still accurate.
      connection.notifyBackground();
    },

    dispose() {
      if (networkUnsubscribe !== null) {
        try {
          networkUnsubscribe();
        } catch {
          // An unsubscribe that fails must not prevent the rest of the teardown.
        }
        networkUnsubscribe = null;
      }
      connection.dispose();
      auth.dispose();
      dev.disarm();
    }
  };
}

let singleton: AppSession | null = null;

/** The App session for this launch. Created on first use so importing this module never needs `wx`. */
export function getAppSession(): AppSession {
  if (!singleton) {
    singleton = createAppSession({ api: getWechatApi(), environment: getActiveEnvironment() });
  }
  return singleton;
}

/** Test/teardown hook. Production never calls it: a session lasts the whole launch. */
export function resetAppSession(): void {
  if (singleton) {
    singleton.dispose();
    singleton = null;
  }
}

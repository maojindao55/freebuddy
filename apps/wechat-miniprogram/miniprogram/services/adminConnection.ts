/**
 * App-level composition of the W2 transport and the W3 recovery/cache layer.
 *
 * Everything below this file owns exactly one concern (frames, timers, correlation, sequence
 * bookkeeping, cache merges, page-level reads). This module is the only place that knows how they
 * fit together, and it is owned by the App rather than by a page so a navigation can never tear
 * down recovery state.
 *
 * Responsibilities that are *transport* concerns and therefore belong here:
 * - the singleton socket is created once per App; pages receive typed reads, never a socket;
 * - `rpc.response` frames are correlated by the layer that owns pending requests, and every
 *   response is checked against the currently configured host before it can settle anything;
 * - a Relay `error` frame that carries a request id settles that request with the server's own
 *   code, so `host_offline` reaches the UI immediately instead of as a local timeout;
 * - when the transport drops, every in-flight request is failed immediately with
 *   `unknownOutcome: true`. Waiting for the per-request timeout would leave the UI believing a
 *   request is still running after the host could already have applied it;
 * - sign-out additionally drops the in-memory credential, so a later connect cannot reuse it.
 *
 * Sequence/state responsibilities are delegated, not re-implemented: `services/adminState.ts`
 * decides whether a connection resumes or takes a snapshot, whether an event may be applied, and
 * how a snapshot replaces the caches. This file only hands it the frames the transport admitted.
 *
 * Deliberately *not* here: no page, no UI state, no write method, and no terminal.
 */

import { getHostTargetRegistry, type HostTargetRegistry, type HostTargetState } from "../config/hostTarget";
import { getAdminStores, type AdminStores } from "../stores/adminStores";
import { buildResumeFrame } from "../protocol/frameRules";
import type { EventFrame, RemoteId, SnapshotFrame } from "../protocol/remote.generated";
import type { SocketTaskLike } from "../platform/wechatApi";
import type { IdFactory, Scheduler } from "../utils/scheduler";
import { nextIdFactory } from "../utils/scheduler";
import { getOperatorTokenSession, type OperatorTokenSession, type SetTokenResult } from "./adminSession";
import { createAdminState, type AdminState } from "./adminState";
import { createReadRpcApi, type ReadRpcApi } from "./readRpc";
import { createRelaySocket, type ConnectionSnapshot, type RelaySocketHandlers } from "./relaySocket";
import { createRpcClient, type RpcClient, type RpcFailure } from "./rpcClient";
import { createResumeManager, type ResumeManager } from "./resumeManager";
import type { ResumeCursorStorage } from "./resumeCursorStorage";

/** A dropped transport means the request may already have reached the host. */
const DISCONNECTED_FAILURE: RpcFailure = {
  code: "internal_error",
  message: "连接已断开，请求结果未知",
  retryable: true,
  unknownOutcome: true
};

export interface AdminConnectionOptions {
  /** Full admin endpoint, e.g. `${wsBaseUrl}/v1/ws/admin`. */
  readonly adminSocketUrl: string;
  readonly clientVersion: string;
  readonly createSocket: (url: string) => SocketTaskLike;
  readonly scheduler: Scheduler;
  readonly isoNow: () => string;
  readonly nextId?: IdFactory;
  readonly random?: () => number;
  readonly tokenSession?: OperatorTokenSession;
  readonly hostTarget?: HostTargetRegistry;
  /** App-scoped caches. Defaults to the App singleton. */
  readonly stores?: AdminStores;
  /** Sequence bookkeeping. Defaults to a manager bound to `resumeStorage`. */
  readonly resume?: ResumeManager;
  /** Persisted per-host cursors. Nothing is persisted when omitted. */
  readonly resumeStorage?: ResumeCursorStorage;
  readonly maxPending?: number;
  readonly handlers?: RelaySocketHandlers;
}

export interface AdminConnection {
  /** Validates and stores the DEV operator token **in memory only**. */
  setToken(raw: string | null | undefined): SetTokenResult;
  clearToken(): void;
  hasToken(): boolean;
  setHostId(hostId: RemoteId | null): HostTargetState;
  getHostId(): RemoteId | null;
  connect(reason: string): void;
  /** Closes the transport without discarding the credential. */
  close(reason: string): void;
  /** Closes the transport and drops the credential: no later connect can reuse it. */
  signOut(reason: string): void;
  notifyForeground(): void;
  notifyBackground(): void;
  notifyNetworkChange(isConnected: boolean): void;
  getSnapshot(): ConnectionSnapshot;
  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void;
  onEvent(listener: (frame: EventFrame) => void): () => void;
  onSnapshot(listener: (frame: SnapshotFrame) => void): () => void;
  pendingCount(): number;
  dispose(): void;
  readonly reads: ReadRpcApi;
  /** Recovery + cache coordination. Pages read state from here, never from the socket. */
  readonly state: AdminState;
  readonly resume: ResumeManager;
  readonly stores: AdminStores;
}

export function createAdminConnection(options: AdminConnectionOptions): AdminConnection {
  const nextId = options.nextId ?? nextIdFactory;
  const random = options.random ?? (() => Math.random());
  const tokenSession = options.tokenSession ?? getOperatorTokenSession();
  const hostTarget = options.hostTarget ?? getHostTargetRegistry();
  const stores = options.stores ?? getAdminStores();
  const resume = options.resume ?? createResumeManager({ storage: options.resumeStorage });

  const eventListeners = new Set<(frame: EventFrame) => void>();
  const snapshotListeners = new Set<(frame: SnapshotFrame) => void>();

  const rpcClient: RpcClient = createRpcClient({
    // Evaluated per call, so it always targets the live socket rather than a captured one.
    send: (frame) => socket.send(frame),
    scheduler: options.scheduler,
    isoNow: options.isoNow,
    nextId,
    maxPending: options.maxPending
  });

  const socket = createRelaySocket({
    adminSocketUrl: options.adminSocketUrl,
    clientVersion: options.clientVersion,
    getAccessToken: () => tokenSession.readToken(),
    createSocket: options.createSocket,
    scheduler: options.scheduler,
    isoNow: options.isoNow,
    nextId,
    random,
    handlers: {
      ...options.handlers,
      onStatusChange(snapshot) {
        // Mirror the socket snapshot into the connection store so a page reads one source of
        // truth: status/reason/limits from the socket, plus the resync and diagnostic fields
        // `adminState` maintains. Without this a page would have to subscribe to both.
        stores.connection.applySocketSnapshot(snapshot);
        options.handlers?.onStatusChange?.(snapshot);
      },
      onRpcResponse(frame) {
        options.handlers?.onRpcResponse?.(frame);
        rpcClient.settle(frame, hostTarget.getHostId());
      },
      onErrorFrame(frame) {
        options.handlers?.onErrorFrame?.(frame);
        // The Relay rejects a request with an `error` frame carrying its id (host_offline,
        // request_expired, backpressure, ...). Settle it here; a frame that matches no pending
        // request is a connection-level error and is left to the transport layer.
        rpcClient.settleError(frame, hostTarget.getHostId());
      },
      onAuthOk(frame) {
        options.handlers?.onAuthOk?.(frame);
        // A connection is only useful once it has a baseline: resume from the last completely
        // applied seq, or take the snapshot when there is nothing to resume from.
        state.onAuthenticated();
      },
      onEventFrame(frame) {
        options.handlers?.onEventFrame?.(frame);
        // Sequence bookkeeping runs first: a duplicate or out-of-window event must never reach a
        // store, and a gap must turn into a snapshot request before anything else sees it.
        state.onEventFrame(frame as EventFrame);
        for (const listener of [...eventListeners]) {
          listener(frame as EventFrame);
        }
      },
      onSnapshotFrame(frame) {
        options.handlers?.onSnapshotFrame?.(frame);
        state.onSnapshotFrame(frame as SnapshotFrame);
        for (const listener of [...snapshotListeners]) {
          listener(frame as SnapshotFrame);
        }
      },
      onDisconnected() {
        options.handlers?.onDisconnected?.();
        // Fail every in-flight request now: once the transport is gone its outcome is unknown
        // and must be re-read, never assumed and never blindly retried.
        rpcClient.rejectAll(DISCONNECTED_FAILURE);
      }
    }
  });

  const reads = createReadRpcApi(rpcClient, () => hostTarget.getHostId());

  const state: AdminState = createAdminState({
    stores,
    resume,
    reads,
    // Only fields `protocol/remote/v1` declares for `resume`; the transport refuses it unless the
    // socket is online, in which case the caller falls back to a snapshot.
    sendResume: (hostId, resumeFrom) =>
      socket.send(
        buildResumeFrame({
          id: nextId("msg"),
          sentAt: options.isoNow(),
          hostId,
          resumeFrom
        })
      ),
    getHostId: () => hostTarget.getHostId(),
    canSend: () => socket.getSnapshot().status === "online",
    nowMs: () => Date.now()
  });

  return {
    setToken(raw) {
      return tokenSession.setToken(raw);
    },

    clearToken() {
      tokenSession.clear();
    },

    hasToken() {
      return tokenSession.hasToken();
    },

    setHostId(hostId) {
      const previous = hostTarget.getHostId();
      const target = hostTarget.setHostId(hostId);
      // Every later frame is bound to this identity, so admission uses the same source of truth.
      socket.setExpectedHostId(target.hostId);
      if (previous === target.hostId) {
        // Re-selecting the same host must not wipe the caches it just filled.
        return target;
      }
      // Caches are host-scoped: the previous host's entities must not survive the switch.
      state.onHostChanged(previous, target.hostId);
      // Establish the new host's baseline now, while the transport is still usable.
      if (target.hostId !== null) {
        state.onAuthenticated();
      }
      return target;
    },

    getHostId() {
      return hostTarget.getHostId();
    },

    connect(reason) {
      socket.connect(reason);
    },

    close(reason) {
      // Persist before the connection goes away: a cursor saved at a snapshot boundary is what
      // makes the next session's recovery cheap (and it is never used without entities anyway).
      state.flush();
      socket.close(reason);
    },

    signOut(reason) {
      socket.close(reason);
      tokenSession.clear();
      rpcClient.rejectAll(DISCONNECTED_FAILURE);
      // Sign-out is isolation: no cache, no cursor and no credential may survive it.
      state.clearAll();
    },

    notifyForeground() {
      socket.notifyForeground();
    },

    notifyBackground() {
      // WeChat may reclaim the app here; the cursor is persisted while it is still accurate.
      state.flush();
      socket.notifyBackground();
    },

    notifyNetworkChange(isConnected) {
      socket.notifyNetworkChange(isConnected);
    },

    getSnapshot() {
      return socket.getSnapshot();
    },

    subscribe(listener) {
      return socket.subscribe(listener);
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },

    pendingCount() {
      return rpcClient.pendingCount();
    },

    dispose() {
      state.flush();
      socket.close("dispose");
      rpcClient.dispose();
      eventListeners.clear();
      snapshotListeners.clear();
    },

    reads,
    state,
    resume,
    stores
  };
}

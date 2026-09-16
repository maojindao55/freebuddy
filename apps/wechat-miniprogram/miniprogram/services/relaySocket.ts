/**
 * App-level singleton Relay socket.
 *
 * Exactly one socket exists for the whole mini program; pages must never call
 * `wx.connectSocket` themselves. The state machine is deliberately explicit —
 * `signedOut → connecting → authenticating → online`, with `backoff`, `offline`,
 * `forbidden` and `incompatible` as terminal-ish resting states — because WeChat can reclaim
 * the app at any moment and the UI must be able to say precisely what happened.
 *
 * Invariants enforced here:
 * - one socket per connection attempt, and stale callbacks are ignored via a generation guard;
 * - one reconnect timer: scheduling always clears the previous handle first;
 * - exponential backoff with jitter; repeated attempts are capped, then the socket rests;
 * - authentication failures do not retry: only a new credential or an explicit reconnect may
 *   leave `forbidden`, and an unknown protocol major version leaves `incompatible`;
 * - the app-in-background state stops heartbeats and suppresses reconnects until `onShow`;
 * - inbound frames pass the direction/identity admission pipeline before anything else sees
 *   them, so no store can be mutated by a frame the protocol never addresses to the admin.
 *
 * Nothing in this file decides *what* an RPC means; it only moves frames.
 */

import {
  buildAdminAuthFrame,
  buildPingFrame,
  buildPongFrame,
  classifyInboundFrame,
  ADMIN_OUTBOUND_FRAME_TYPES,
  type AdminOutboundFrame,
  type InboundViolation
} from "../protocol/frameRules";
import {
  exceedsFrameLimit,
  type AuthOkFrame,
  type ConnectionLimits,
  type ErrorFrame,
  type EventFrame,
  type PingFrame,
  type PongFrame,
  type RemoteErrorCode,
  type RemoteFrameType,
  type RpcResponseFrame,
  type ServerDrainingFrame,
  type SnapshotFrame
} from "../protocol/remote.generated";
import type { SocketTaskLike } from "../platform/wechatApi";
import { safeMessage } from "../utils/redact";
import type { IdFactory, Scheduler } from "../utils/scheduler";

export type ConnectionStatus =
  | "signedOut"
  | "connecting"
  | "authenticating"
  | "online"
  | "backoff"
  | "offline"
  | "forbidden"
  | "incompatible";

export interface ConnectionSnapshot {
  readonly status: ConnectionStatus;
  readonly reasonCode: RemoteErrorCode | null;
  /** Always redacted and truncated; safe to render. */
  readonly reasonMessage: string;
  readonly attempt: number;
  readonly nextRetryInMs: number | null;
  readonly connectionId: string | null;
  readonly serverTime: string | null;
  readonly limits: ConnectionLimits | null;
  readonly suspended: boolean;
  readonly violations: number;
  readonly droppedFrames: number;
  readonly heartbeatMissed: number;
}

export interface RelaySocketHandlers {
  onStatusChange?(snapshot: ConnectionSnapshot): void;
  onAuthOk?(frame: AuthOkFrame): void;
  onErrorFrame?(frame: ErrorFrame): void;
  /** `unauthorized` / `forbidden` / `unsupported_version`: automatic retry must stop. */
  onTerminalError?(frame: ErrorFrame): void;
  onRpcResponse?(frame: RpcResponseFrame): void;
  onEventFrame?(frame: EventFrame): void;
  onSnapshotFrame?(frame: SnapshotFrame): void;
  onServerDraining?(frame: ServerDrainingFrame): void;
  onViolation?(violation: InboundViolation): void;
  onDisconnected?(): void;
}

export interface RelaySocketOptions {
  /** Full admin endpoint, e.g. `ws://127.0.0.1:8080/v1/ws/admin`. */
  readonly adminSocketUrl: string;
  readonly clientVersion: string;
  /** Returns the current in-memory credential, or null when unavailable. */
  readonly getAccessToken: () => string | null;
  readonly createSocket: (url: string) => SocketTaskLike;
  readonly scheduler: Scheduler;
  readonly isoNow: () => string;
  readonly nextId: IdFactory;
  readonly random: () => number;
  readonly handlers?: RelaySocketHandlers;
  readonly authTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly maxAutoAttempts?: number;
}

export interface RelaySocket {
  connect(reason: string): void;
  close(reason: string): void;
  notifyForeground(): void;
  notifyBackground(): void;
  notifyNetworkChange(isConnected: boolean): void;
  /** Queues nothing and never blocks: returns false when the transport is not usable. */
  send(frame: AdminOutboundFrame): boolean;
  setExpectedHostId(hostId: string | null): void;
  getExpectedHostId(): string | null;
  getSnapshot(): ConnectionSnapshot;
  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void;
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_BACKOFF_BASE_MS = 800;
const DEFAULT_BACKOFF_CAP_MS = 20_000;
const DEFAULT_MAX_AUTO_ATTEMPTS = 5;

/** `rpc.request`, `resume`, `admin.auth`, `ping`, `pong` — everything the admin may emit. */
export type AdminOutboundFrameType = AdminOutboundFrame["type"];

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function createRelaySocket(options: RelaySocketOptions): RelaySocket {
  const handlers = options.handlers ?? {};
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCapMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const maxAutoAttempts = options.maxAutoAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS;

  let status: ConnectionStatus = "signedOut";
  let reasonCode: RemoteErrorCode | null = null;
  let reasonMessage = "尚未连接";
  let attempt = 0;
  let nextRetryInMs: number | null = null;
  let connectionId: string | null = null;
  let serverTime: string | null = null;
  let limits: ConnectionLimits | null = null;
  let suspended = false;
  let violations = 0;
  let droppedFrames = 0;
  let heartbeatMissed = 0;
  let expectedHostId: string | null = null;

  let generation = 0;
  let socket: SocketTaskLike | null = null;
  let reconnectTimer: unknown = null;
  let authTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  let heartbeatMissTimer: unknown = null;
  let heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  let pendingPingNonce: string | null = null;

  const listeners = new Set<(snapshot: ConnectionSnapshot) => void>();

  function snapshot(): ConnectionSnapshot {
    return {
      status,
      reasonCode,
      reasonMessage,
      attempt,
      nextRetryInMs,
      connectionId,
      serverTime,
      limits,
      suspended,
      violations,
      droppedFrames,
      heartbeatMissed
    };
  }

  function publish(): void {
    const current = snapshot();
    handlers.onStatusChange?.(current);
    for (const listener of [...listeners]) {
      listener(current);
    }
  }

  function setStatus(next: ConnectionStatus, code: RemoteErrorCode | null, message: string): void {
    status = next;
    reasonCode = code;
    reasonMessage = safeMessage(message);
    publish();
  }

  function setMessage(message: string): void {
    if (reasonMessage !== message) {
      reasonMessage = safeMessage(message);
      publish();
    }
  }

  function clearTimeout(handle: unknown): void {
    if (handle !== null && handle !== undefined) {
      options.scheduler.clearTimeout(handle);
    }
  }

  function clearReconnectTimer(): void {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    nextRetryInMs = null;
  }

  function clearAuthTimer(): void {
    clearTimeout(authTimer);
    authTimer = null;
  }

  function stopHeartbeat(): void {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    clearTimeout(heartbeatMissTimer);
    heartbeatMissTimer = null;
    pendingPingNonce = null;
  }

  function closeTransport(): void {
    // Bumping the generation invalidates every callback still attached to the old task.
    generation += 1;
    clearAuthTimer();
    stopHeartbeat();
    const task = socket;
    socket = null;
    if (task) {
      try {
        task.close(1000, "client_close");
      } catch {
        // A socket that refuses to close must not take down the caller.
      }
    }
  }

  function sendNow(frame: AdminOutboundFrame): boolean {
    const task = socket;
    if (!task) {
      droppedFrames += 1;
      return false;
    }
    if (!ADMIN_OUTBOUND_FRAME_TYPES.has(frame.type as RemoteFrameType)) {
      droppedFrames += 1;
      violations += 1;
      handlers.onViolation?.({
        code: "frame_direction",
        detail: `${frame.type} is not an admin-to-relay frame`,
        frameType: frame.type
      });
      return false;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(frame);
    } catch (error) {
      droppedFrames += 1;
      setMessage(safeMessage(error));
      return false;
    }
    if (exceedsFrameLimit(serialized)) {
      droppedFrames += 1;
      handlers.onViolation?.({ code: "frame_too_large", detail: "outbound frame exceeds MAX_FRAME_BYTES" });
      return false;
    }
    try {
      task.send(serialized);
      return true;
    } catch (error) {
      droppedFrames += 1;
      handleTransportClosed(safeMessage(error));
      return false;
    }
  }

  function heartbeatTimeoutFor(intervalMs: number): number {
    return Math.max(1_000, Math.min(Math.floor(intervalMs / 2), heartbeatTimeoutMs));
  }

  function scheduleHeartbeatTick(delayMs: number): void {
    // Exclusive ownership: a heartbeat tick is the only source of the next tick, so clearing
    // first is what guarantees exactly one outstanding timer after any reschedule.
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    heartbeatTimer = options.scheduler.setTimeout(() => {
      heartbeatTimer = null;
      tickHeartbeat();
    }, delayMs);
  }

  function tickHeartbeat(): void {
    if (status !== "online" || suspended) {
      return;
    }
    const nonce = options.nextId("nonce");
    pendingPingNonce = nonce;
    const sent = sendNow(
      buildPingFrame({ id: options.nextId("msg"), sentAt: options.isoNow(), nonce })
    );
    if (!sent) {
      return;
    }
    // Only one outstanding probe is ever tracked, so clear before arming the next deadline.
    clearTimeout(heartbeatMissTimer);
    heartbeatMissTimer = options.scheduler.setTimeout(() => {
      heartbeatMissTimer = null;
      heartbeatMissed += 1;
      pendingPingNonce = null;
      handleTransportClosed("心跳超时");
    }, heartbeatTimeoutFor(heartbeatIntervalMs));
    scheduleHeartbeatTick(heartbeatIntervalMs);
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatIntervalMs = clampNumber(
      limits?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      5_000,
      120_000
    );
    scheduleHeartbeatTick(heartbeatIntervalMs);
  }

  function onPong(frame: PongFrame): void {
    const nonce = frame.payload && typeof frame.payload.nonce === "string" ? frame.payload.nonce : null;
    // Liveness proof, not traffic: only a pong that echoes the nonce of the single outstanding
    // ping resets the deadline. Unsolicited or mismatched pongs are ignored, so a peer cannot
    // keep a dead connection looking alive by streaming pongs.
    if (pendingPingNonce === null || nonce === null || nonce !== pendingPingNonce) {
      return;
    }
    pendingPingNonce = null;
    clearTimeout(heartbeatMissTimer);
    heartbeatMissTimer = null;
  }

  function answerPing(frame: PingFrame): void {
    const nonce = frame.payload && typeof frame.payload.nonce === "string" ? frame.payload.nonce : undefined;
    sendNow(buildPongFrame({ id: options.nextId("msg"), sentAt: options.isoNow(), nonce, serverTime: options.isoNow() }));
  }

  /**
   * `auth.ok` is also emitted for host connections, so role and host binding are checked here:
   * accepting a frame from another connection would give this client someone else's session.
   */
  function authFailure(frame: AuthOkFrame, detail: string): void {
    closeTransport();
    clearReconnectTimer();
    handlers.onViolation?.({ code: "frame_identity", detail, frameType: frame.type });
    setStatus("forbidden", "forbidden", `认证结果不可接受：${detail}`);
  }

  function completeAuth(frame: AuthOkFrame): void {
    if (frame.payload.role !== "admin") {
      authFailure(frame, `auth.ok 返回的角色是 ${frame.payload.role}，不是 admin`);
      return;
    }
    const frameHostId = frame.payload.hostId;
    if (frameHostId !== undefined && expectedHostId !== null && frameHostId !== expectedHostId) {
      authFailure(frame, "auth.ok 返回的 hostId 与已配置主机不一致");
      return;
    }
    clearAuthTimer();
    connectionId = frame.payload.connectionId;
    serverTime = frame.payload.serverTime;
    limits = frame.payload.limits;
    attempt = 0;
    nextRetryInMs = null;
    setStatus("online", null, "已连接");
    startHeartbeat();
    handlers.onAuthOk?.(frame);
  }

  function handleErrorFrame(frame: ErrorFrame): void {
    const code = frame.payload.code;
    const message = frame.payload.message;
    handlers.onErrorFrame?.(frame);

    if (code === "unauthorized" || code === "forbidden") {
      closeTransport();
      clearReconnectTimer();
      handlers.onTerminalError?.(frame);
      setStatus("forbidden", code, `凭证被拒绝：${message}`);
      return;
    }
    if (code === "unsupported_version") {
      closeTransport();
      clearReconnectTimer();
      handlers.onTerminalError?.(frame);
      setStatus("incompatible", code, `协议版本不兼容：${message}`);
      return;
    }
    setStatus(status, code, message);
  }

  function handleServerDraining(frame: ServerDrainingFrame): void {
    const delay = clampNumber(frame.payload.reconnectAfterMs, 500, 60_000);
    closeTransport();
    clearReconnectTimer();
    handlers.onServerDraining?.(frame);
    setStatus("backoff", null, `服务端即将关闭（${frame.payload.reason}）`);
    attempt = Math.max(attempt, 1);
    nextRetryInMs = delay;
    reconnectTimer = options.scheduler.setTimeout(() => {
      reconnectTimer = null;
      openAttempt("服务端恢复后重连");
    }, delay);
  }

  function backoffDelay(currentAttempt: number): number {
    const raw = Math.min(backoffCapMs, backoffBaseMs * Math.pow(2, Math.max(0, currentAttempt - 1)));
    return Math.max(100, Math.round(raw * (0.5 + options.random() * 0.5)));
  }

  function scheduleReconnect(message: string): void {
    clearReconnectTimer();
    if (suspended) {
      setStatus("offline", null, `${message}（小程序在后台，回到前台后重连）`);
      return;
    }
    attempt += 1;
    if (attempt > maxAutoAttempts) {
      setStatus("offline", null, `${message}（自动重连次数已用尽）`);
      return;
    }
    const delay = backoffDelay(attempt);
    nextRetryInMs = delay;
    setStatus("backoff", null, message);
    reconnectTimer = options.scheduler.setTimeout(() => {
      reconnectTimer = null;
      openAttempt("自动重连");
    }, delay);
  }

  function handleTransportClosed(message: string): void {
    closeTransport();
    clearReconnectTimer();
    handlers.onDisconnected?.();
    connectionId = null;
    serverTime = null;
    limits = null;

    if (status === "forbidden" || status === "incompatible") {
      setStatus(status, reasonCode, message);
      return;
    }
    scheduleReconnect(message);
  }

  function openAttempt(reason: string): void {
    if (status === "connecting" || status === "authenticating" || status === "online") {
      return;
    }
    if (status === "forbidden" || status === "incompatible") {
      setStatus(status, reasonCode, `${reason} 已取消：连接处于 ${status} 状态，需要新凭证后显式重连`);
      return;
    }
    closeTransport();

    const token = options.getAccessToken();
    if (!token) {
      setStatus("signedOut", null, `${reason}：缺少管理员凭证`);
      return;
    }

    let task: SocketTaskLike;
    try {
      task = options.createSocket(options.adminSocketUrl);
    } catch (error) {
      setStatus("offline", null, safeMessage(error));
      scheduleReconnect(`连接失败：${safeMessage(error)}`);
      return;
    }

    socket = task;
    const myGeneration = generation;
    setStatus("connecting", null, reason);

    task.onClose((event) => {
      if (myGeneration !== generation) {
        return;
      }
      handleTransportClosed(`连接已关闭 (${event.code})`);
    });
    task.onError((event) => {
      if (myGeneration !== generation) {
        return;
      }
      handleTransportClosed(`连接错误：${safeMessage(event.errMsg)}`);
    });
    task.onOpen(() => {
      if (myGeneration !== generation) {
        return;
      }
      setStatus("authenticating", null, "等待认证结果");
      sendNow(
        buildAdminAuthFrame({
          id: options.nextId("msg"),
          sentAt: options.isoNow(),
          accessToken: token,
          clientVersion: options.clientVersion
        })
      );
    });
    task.onMessage((event) => {
      if (myGeneration !== generation) {
        return;
      }
      handleInbound(event.data);
    });

    authTimer = options.scheduler.setTimeout(() => {
      authTimer = null;
      if (myGeneration !== generation) {
        return;
      }
      handleTransportClosed("认证超时");
    }, authTimeoutMs);
  }

  function handleInbound(raw: unknown): void {
    const outcome = classifyInboundFrame(raw, { authenticated: status === "online", expectedHostId });
    if (outcome.kind === "violation") {
      violations += 1;
      handlers.onViolation?.(outcome.violation);
      return;
    }

    const frame = outcome.frame;
    switch (frame.type) {
      case "auth.ok":
        completeAuth(frame);
        return;
      case "error":
        handleErrorFrame(frame);
        return;
      case "rpc.response":
        handlers.onRpcResponse?.(frame as RpcResponseFrame);
        return;
      case "event":
        handlers.onEventFrame?.(frame as EventFrame);
        return;
      case "snapshot":
        handlers.onSnapshotFrame?.(frame as SnapshotFrame);
        return;
      case "ping":
        answerPing(frame as PingFrame);
        return;
      case "pong":
        onPong(frame as PongFrame);
        return;
      case "server.draining":
        handleServerDraining(frame as ServerDrainingFrame);
        return;
      default:
        return;
    }
  }

  return {
    connect(reason) {
      attempt = 0;
      suspended = false;
      clearReconnectTimer();
      openAttempt(reason);
    },

    close(reason) {
      clearReconnectTimer();
      closeTransport();
      connectionId = null;
      serverTime = null;
      limits = null;
      attempt = 0;
      // An explicit sign-out is still a disconnection: in-flight RPCs must learn that their
      // outcome is unknown instead of waiting for their timeout.
      handlers.onDisconnected?.();
      setStatus("signedOut", null, reason);
    },

    notifyForeground() {
      suspended = false;
      if (status === "online") {
        // A socket that survived the background must prove it is still alive. Restarting clears
        // every timer first, so foreground events cannot accumulate heartbeat timers.
        stopHeartbeat();
        tickHeartbeat();
        publish();
        return;
      }
      attempt = 0;
      clearReconnectTimer();
      openAttempt("回到前台");
    },

    notifyBackground() {
      suspended = true;
      stopHeartbeat();
      publish();
    },

    notifyNetworkChange(isConnected) {
      if (!isConnected) {
        handleTransportClosed("网络不可用");
        return;
      }
      if (suspended) {
        return;
      }
      attempt = 0;
      clearReconnectTimer();
      openAttempt("网络恢复");
    },

    send(frame) {
      if (status !== "online" || socket === null) {
        droppedFrames += 1;
        return false;
      }
      return sendNow(frame);
    },

    setExpectedHostId(hostId) {
      expectedHostId = hostId;
    },

    getExpectedHostId() {
      return expectedHostId;
    },

    getSnapshot() {
      return snapshot();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

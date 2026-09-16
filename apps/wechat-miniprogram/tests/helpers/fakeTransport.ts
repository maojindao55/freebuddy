/** Deterministic timer + socket doubles. Lives under `tests/` so it can never reach a bundle. */

import type { SocketTaskLike } from "../../miniprogram/platform/wechatApi";
import type { Scheduler } from "../../miniprogram/utils/scheduler";

interface TimerEntry {
  readonly id: number;
  readonly dueAt: number;
  readonly handler: () => void;
  cancelled: boolean;
}

export interface ManualScheduler extends Scheduler {
  /** Fires every timer due within the next `ms` virtual milliseconds, oldest first. */
  advance(ms: number): number;
  /** Number of timers still scheduled. Used to prove only one reconnect timer exists. */
  pendingCount(): number;
  now(): number;
}

export function createManualScheduler(): ManualScheduler {
  const timers: TimerEntry[] = [];
  let clock = 0;
  let nextId = 1;

  function drop(handle: unknown): void {
    for (const entry of timers) {
      if (entry.id === handle) {
        entry.cancelled = true;
      }
    }
  }

  const scheduler: ManualScheduler = {
    setTimeout(handler, ms) {
      const id = nextId;
      nextId += 1;
      timers.push({ id, dueAt: clock + Math.max(0, ms), handler, cancelled: false });
      return id;
    },
    clearTimeout(handle) {
      drop(handle);
    },
    advance(ms) {
      clock += ms;
      let fired = 0;
      for (;;) {
        const due = timers
          .filter((entry) => !entry.cancelled && entry.dueAt <= clock)
          .sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!due) {
          return fired;
        }
        due.cancelled = true;
        timers.splice(timers.indexOf(due), 1);
        fired += 1;
        due.handler();
      }
    },
    pendingCount() {
      return timers.filter((entry) => !entry.cancelled).length;
    },
    now() {
      return clock;
    }
  };

  return scheduler;
}

export interface FakeSocketTask extends SocketTaskLike {
  readonly url: string;
  readonly sent: readonly string[];
  readonly closedCode: number | null;
  fireOpen(): void;
  fireMessage(raw: string): void;
  fireClose(code?: number, reason?: string): void;
  fireError(errMsg?: string): void;
}

export interface SocketHub {
  createSocket(url: string): SocketTaskLike;
  readonly tasks: readonly FakeSocketTask[];
  last(): FakeSocketTask;
  /** Delivers a text frame to the newest task, mirroring how WeChat routes callbacks. */
  deliver(raw: string): void;
}

export function createSocketHub(options: { throwOnCreate?: string } = {}): SocketHub {
  const tasks: FakeSocketTask[] = [];

  function create(url: string): FakeSocketTask {
    if (options.throwOnCreate) {
      throw new Error(options.throwOnCreate);
    }
    const sent: string[] = [];
    let openListeners: Array<() => void> = [];
    let messageListeners: Array<(event: { data: unknown }) => void> = [];
    let errorListeners: Array<(event: { errMsg: string }) => void> = [];
    let closeListeners: Array<(event: { code: number; reason: string }) => void> = [];
    let closedCode: number | null = null;

    const task: FakeSocketTask = {
      url,
      get sent() {
        return [...sent];
      },
      get closedCode() {
        return closedCode;
      },
      send(data) {
        if (closedCode !== null) {
          throw new Error("socket closed");
        }
        sent.push(data);
      },
      close(code = 1000, reason = "") {
        closedCode = code;
        for (const listener of closeListeners) {
          listener({ code, reason });
        }
      },
      onOpen(listener) {
        openListeners.push(listener);
      },
      onMessage(listener) {
        messageListeners.push(listener);
      },
      onError(listener) {
        errorListeners.push(listener);
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
      fireOpen() {
        for (const listener of openListeners) {
          listener();
        }
      },
      fireMessage(raw) {
        for (const listener of messageListeners) {
          listener({ data: raw });
        }
      },
      fireClose(code = 1006, reason = "server_close") {
        if (closedCode === null) {
          closedCode = code;
        }
        for (const listener of closeListeners) {
          listener({ code, reason });
        }
      },
      fireError(errMsg = "socket error") {
        for (const listener of errorListeners) {
          listener({ errMsg });
        }
      }
    };

    tasks.push(task);
    return task;
  }

  function last(): FakeSocketTask {
    const task = tasks[tasks.length - 1];
    if (!task) {
      throw new Error("no socket task was created");
    }
    return task;
  }

  return {
    createSocket: create,
    tasks,
    last,
    deliver(raw) {
      last().fireMessage(raw);
    }
  };
}

/** Remote frame builders for tests. All fields come from `protocol/remote/v1` shapes. */

let frameSequence = 0;

export function resetFrameSequence(): void {
  frameSequence = 0;
}

function nextFrameId(prefix: string): string {
  frameSequence += 1;
  return `${prefix}${frameSequence}`;
}

export const ISOTIME = "2026-09-14T10:00:00.000Z";

export function createTestIdFactory(): (prefix: string) => string {
  let n = 0;
  return (prefix) => {
    n += 1;
    return `${prefix}${n}`;
  };
}

export function adminAuthOkFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "auth.ok",
    sentAt: ISOTIME,
    payload: {
      connectionId: "conn-1",
      role: "admin",
      serverTime: ISOTIME,
      limits: {
        maxFrameBytes: 262_144,
        maxChunkBytes: 32_768,
        maxConcurrentRpcs: 8,
        rpcReadTimeoutMs: 15_000,
        rpcWriteTimeoutMs: 30_000,
        heartbeatIntervalMs: 10_000,
        challengeTtlMs: 60_000
      },
      ...overrides
    }
  });
}

export function errorFrame(code: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "error",
    sentAt: ISOTIME,
    payload: { code, message: `server said ${code}`, retryable: false, ...overrides }
  });
}

export function eventFrame(hostId: string, name: string, seq: number, data: unknown): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "event",
    hostId,
    seq,
    sentAt: ISOTIME,
    payload: { name, data }
  });
}

/**
 * Snapshot payload as a host would build it. `overrides` is deliberately untyped so tests can
 * also send *illegal* extra fields (a smuggled `accessToken`, say) and prove they are not cached.
 */
export function snapshotPayload(
  hostId: string,
  baseSeq: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    baseSeq,
    host: {
      hostId,
      online: true,
      appVersion: "0.0.0",
      protocolVersion: 1,
      remoteEnabled: true,
      activeRunCount: 0,
      pendingDecisionCount: 0,
      activeTerminalCount: 0,
      serverTime: ISOTIME
    },
    ...overrides
  };
}

export function snapshotFrame(hostId: string, seq: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "snapshot",
    hostId,
    seq,
    sentAt: ISOTIME,
    payload: snapshotPayload(hostId, seq, overrides)
  });
}

export function conversationSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: "c1",
    title: "conversation 1",
    archived: false,
    updatedAt: ISOTIME,
    ...overrides
  };
}

export function messageSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "msg1",
    conversationId: "c1",
    role: "user",
    content: "hello",
    createdAt: ISOTIME,
    ...overrides
  };
}

/** Frames the client put on the wire, parsed, oldest first. */
export function sentFrames(task: { readonly sent: readonly string[] }): Record<string, unknown>[] {
  return task.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

export function framesOfMethod(
  task: { readonly sent: readonly string[] },
  method: string
): Record<string, unknown>[] {
  return sentFrames(task).filter((frame) => {
    const payload = frame.payload as { method?: string } | undefined;
    return frame.type === "rpc.request" && payload?.method === method;
  });
}

export function pingFrame(nonce?: string): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "ping",
    sentAt: ISOTIME,
    payload: nonce === undefined ? {} : { nonce }
  });
}

export function pongFrame(nonce?: string): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "pong",
    sentAt: ISOTIME,
    payload: { serverTime: ISOTIME, ...(nonce === undefined ? {} : { nonce }) }
  });
}

export function rpcResponseFrame(hostId: string, requestId: string, result: unknown): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "rpc.response",
    hostId,
    sentAt: ISOTIME,
    payload: { requestId, ok: true, result }
  });
}

export function rpcFailureFrame(hostId: string, requestId: string, code: string): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "rpc.response",
    hostId,
    sentAt: ISOTIME,
    payload: {
      requestId,
      ok: false,
      error: { code, message: `${code} failure`, retryable: false }
    }
  });
}

/**
 * A Relay-level `error` that answers one request: the envelope `id` *is* the request id. This is
 * how the real Relay reports `host_offline`, `request_expired`, `backpressure` and
 * `duplicate_request` (see `services/remote-relay/internal/router/router.go`).
 */
export function requestErrorFrame(requestId: string, code: string, hostId?: string): string {
  return JSON.stringify({
    v: 1,
    id: requestId,
    type: "error",
    ...(hostId === undefined ? {} : { hostId }),
    sentAt: ISOTIME,
    payload: { code, message: `server said ${code}`, retryable: false }
  });
}

export function serverDrainingFrame(reconnectAfterMs: number, reason = "restart"): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "server.draining",
    sentAt: ISOTIME,
    payload: { reason, reconnectAfterMs }
  });
}

/** A frame the protocol only ever sends to the *host*; the admin must reject it. */
export function challengeFrame(): string {
  return JSON.stringify({
    v: 1,
    id: nextFrameId("m"),
    type: "challenge",
    sentAt: ISOTIME,
    payload: {
      connectionId: "conn-1",
      challenge: "abc",
      issuedAt: ISOTIME,
      expiresAt: ISOTIME
    }
  });
}

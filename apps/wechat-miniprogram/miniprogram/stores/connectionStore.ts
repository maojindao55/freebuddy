/**
 * Connection-facing state.
 *
 * Mirrors `RelaySocket`'s snapshot and adds the recovery fields the pages need: whether a
 * resync is outstanding, which sequence we would resume from, and a *bounded* ring of redacted
 * diagnostics. The diagnostic ring exists so an operator can see what happened without any
 * chat content, terminal output or token material ever being recorded.
 */

import type { RemoteErrorCode } from "../protocol/remote.generated";
import type { ConnectionSnapshot, ConnectionStatus } from "../services/relaySocket";
import { capHead, createStore, type Store } from "./createStore";
import { safeMessage } from "../utils/redact";

export const MAX_DIAGNOSTICS = 20;

export interface ConnectionDiagnostic {
  readonly atMs: number;
  readonly scope: string;
  readonly message: string;
}

export interface ConnectionState extends ConnectionSnapshot {
  /** True while we are falling back to `sync.snapshot` after a gap. */
  readonly resyncRequired: boolean;
  readonly resumeFrom: number | null;
  readonly lastViolation: string | null;
  readonly diagnostics: readonly ConnectionDiagnostic[];
}

export interface ConnectionStore extends Store<ConnectionState> {
  applySocketSnapshot(snapshot: ConnectionSnapshot): void;
  setResyncRequired(value: boolean): void;
  setResumeFrom(seq: number | null): void;
  pushDiagnostic(scope: string, message: string, atMs: number): void;
  reset(): void;
}

function initialState(): ConnectionState {
  return {
    status: "signedOut",
    reasonCode: null,
    reasonMessage: "尚未连接",
    attempt: 0,
    nextRetryInMs: null,
    connectionId: null,
    serverTime: null,
    limits: null,
    suspended: false,
    violations: 0,
    droppedFrames: 0,
    heartbeatMissed: 0,
    resyncRequired: false,
    resumeFrom: null,
    lastViolation: null,
    diagnostics: []
  };
}

export function createConnectionStore(): ConnectionStore {
  const store = createStore<ConnectionState>(initialState());

  return {
    getState: store.getState,
    setState: store.setState,
    subscribe: store.subscribe,

    applySocketSnapshot(snapshot) {
      store.setState((previous) => ({ ...previous, ...snapshot }));
    },

    setResyncRequired(value) {
      store.setState((previous) =>
        previous.resyncRequired === value ? previous : { ...previous, resyncRequired: value }
      );
    },

    setResumeFrom(seq) {
      store.setState((previous) => (previous.resumeFrom === seq ? previous : { ...previous, resumeFrom: seq }));
    },

    pushDiagnostic(scope, message, atMs) {
      const entry: ConnectionDiagnostic = { atMs, scope, message: safeMessage(message) };
      store.setState((previous) => ({
        ...previous,
        lastViolation: `${scope}: ${entry.message}`,
        diagnostics: capHead([...previous.diagnostics, entry], MAX_DIAGNOSTICS)
      }));
    },

    reset() {
      store.setState(() => initialState());
    }
  };
}

let singleton: ConnectionStore | null = null;

export function getConnectionStore(): ConnectionStore {
  if (!singleton) {
    singleton = createConnectionStore();
  }
  return singleton;
}

export function resetConnectionStore(): void {
  singleton = null;
}

/** UI-facing grouping of statuses: pages render a tone, not a raw state machine value. */
export function isTerminalStatus(status: ConnectionStatus): boolean {
  return status === "forbidden" || status === "incompatible" || status === "signedOut";
}

export function describeErrorCode(code: RemoteErrorCode | null): string {
  switch (code) {
    case "unauthorized":
      return "凭证无效";
    case "forbidden":
      return "无权访问该主机";
    case "unsupported_version":
      return "协议版本不兼容";
    case "host_offline":
      return "主机离线";
    case "request_expired":
      return "请求已过期";
    case "duplicate_request":
      return "重复请求";
    case "rpc_timeout":
      return "请求超时";
    case "backpressure":
      return "服务繁忙";
    case "conflict":
      return "状态冲突";
    case "not_found":
      return "资源不存在";
    case "method_not_allowed":
      return "方法不被允许";
    case "invalid_request":
      return "请求不合法";
    case "internal_error":
      return "主机内部错误";
    default:
      return "";
  }
}

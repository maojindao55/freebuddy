/**
 * RPC correlation layer.
 *
 * The protocol correlates responses by `payload.requestId` — never by event `seq` — so this
 * layer keeps a *bounded* map of in-flight requests and a timer per request.
 *
 * - pending set is capped: exceeding it fails fast with `backpressure` instead of growing
 *   without limit while the host is slow;
 * - every pending request has a timeout taken from the method spec (`sync.snapshot` etc. are
 *   reads: 15 s by default in v1);
 * - a response that arrives after its timeout is **late**: it is dropped, counted and reported,
 *   and never applied to a store — this is what stops yesterday's page replacing today's event;
 * - a response whose `hostId` disagrees with the request is ignored;
 * - a Relay-level `error` frame carries the id of the request it answers (`host_offline`,
 *   `request_expired`, `backpressure`, `duplicate_request`, ...), so it settles that request with
 *   the wire's own code instead of waiting for the local timeout. Only `rpc_timeout` is an
 *   unknown outcome: the Relay waited for the host and never got a verdict;
 * - when the transport drops, every pending request fails immediately with *unknown outcome*.
 *   The caller then re-reads or resumes; it must never silently retry a write (write methods are
 *   rejected outright in this read-only substage).
 */

import {
  buildRpcRequestFrame,
  readRpcRequestId
} from "../protocol/frameRules";
import {
  getMethodSpec,
  isRemoteMethod,
  isWriteMethod,
  type ReadRemoteMethod,
  type RemoteErrorCode,
  type RemoteMethod,
  type RemoteMethodParamsMap,
  type RemoteMethodResultMap,
  type RemoteStructuredError,
  type ErrorFrame,
  type RpcRequestFrame,
  type RpcResponseFrame
} from "../protocol/remote.generated";
import { safeMessage } from "../utils/redact";
import type { IdFactory, Scheduler } from "../utils/scheduler";

export interface RpcFailure {
  readonly code: RemoteErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** True when the connection died before a verdict: the outcome is genuinely unknown. */
  readonly unknownOutcome?: boolean;
}

export type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcFailure };

export const DEFAULT_MAX_PENDING = 32;

export interface LateResponseInfo {
  readonly requestId: string;
  /** Unknown for late responses: the request record is already gone by definition. */
  readonly method: RemoteMethod | null;
}

export interface RpcClientOptions {
  /** `RelaySocket.send`. Returns false when the transport refused the frame. */
  readonly send: (frame: RpcRequestFrame) => boolean;
  readonly scheduler: Scheduler;
  readonly isoNow: () => string;
  readonly nextId: IdFactory;
  readonly maxPending?: number;
  readonly onLateResponse?: (info: LateResponseInfo) => void;
  readonly onDiagnostic?: (entry: { readonly scope: string; readonly message: string }) => void;
}

export interface RpcClient {
  /** Read-only stage: write methods are refused before they ever reach the transport. */
  request<M extends ReadRemoteMethod>(
    method: M,
    hostId: string,
    params: RemoteMethodParamsMap[M]
  ): Promise<RpcResult<RemoteMethodResultMap[M]>>;
  settle(frame: RpcResponseFrame, expectedHostId: string | null): boolean;
  /** Settles the request a Relay `error` frame answers. False for connection-level errors. */
  settleError(frame: ErrorFrame, expectedHostId: string | null): boolean;
  rejectAll(failure: RpcFailure): void;
  pendingCount(): number;
  dispose(): void;
}

interface PendingEntry {
  readonly requestId: string;
  readonly method: RemoteMethod;
  readonly hostId: string;
  readonly timeoutMs: number;
  timer: unknown;
  settle(result: RpcResult<unknown>): void;
}

function toFailure(error: RemoteStructuredError): RpcFailure {
  return {
    code: error.code,
    message: safeMessage(error.message),
    retryable: error.retryable === true
  };
}

function notAllowed(message: string): { readonly ok: false; readonly error: RpcFailure } {
  return { ok: false, error: { code: "method_not_allowed", message, retryable: false } };
}

export function createRpcClient(options: RpcClientOptions): RpcClient {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const pending = new Map<string, PendingEntry>();

  function remove(requestId: string, timer: unknown): void {
    if (timer !== null && timer !== undefined) {
      options.scheduler.clearTimeout(timer);
    }
    pending.delete(requestId);
  }

  /**
   * The transport refused the frame before it reached the wire, so the host provably never saw
   * the request: this is a failed send, not an unknown outcome.
   */
  function sendFailure(): RpcFailure {
    return {
      code: "internal_error",
      message: "连接不可用，请求未发送",
      retryable: true,
      unknownOutcome: false
    };
  }

  async function request<M extends ReadRemoteMethod>(
    method: M,
    hostId: string,
    params: RemoteMethodParamsMap[M]
  ): Promise<RpcResult<RemoteMethodResultMap[M]>> {
    // The registry is checked before any spec lookup: an unregistered name has no timeout or
    // idempotency spec, and looking one up must never throw inside a request promise.
    if (typeof method !== "string" || !isRemoteMethod(method)) {
      return notAllowed("未知或不允许的方法");
    }
    // Write methods stay unreachable in the read-only substage: no idempotency key is generated
    // here, and a blind retry after reconnect could duplicate a side effect on the host.
    if (isWriteMethod(method)) {
      return notAllowed("只读阶段不提供写方法");
    }
    if (typeof hostId !== "string" || hostId.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid_request",
          message: "尚未显式配置 hostId",
          retryable: false
        }
      };
    }
    if (pending.size >= maxPending) {
      options.onDiagnostic?.({ scope: "rpc", message: `pending limit reached (${maxPending})` });
      return {
        ok: false,
        error: { code: "backpressure", message: "并发请求过多，请稍后重试", retryable: true }
      };
    }

    const spec = getMethodSpec(method);
    const requestId = options.nextId("req");
    const sentAt = options.isoNow();
    const expiresAt = new Date(Date.parse(sentAt) + spec.timeoutMs).toISOString();
    const frame = buildRpcRequestFrame({
      id: requestId,
      sentAt,
      hostId,
      method,
      params,
      expiresAt
    });

    return new Promise<RpcResult<RemoteMethodResultMap[M]>>((resolve) => {
      const entry: PendingEntry = {
        requestId,
        method,
        hostId,
        timeoutMs: spec.timeoutMs,
        timer: null,
        settle(result) {
          if (result.ok) {
            resolve({ ok: true, value: result.value as RemoteMethodResultMap[M] });
          } else {
            resolve({ ok: false, error: result.error });
          }
        }
      };

      entry.timer = options.scheduler.setTimeout(() => {
        remove(requestId, null);
        entry.settle({
          ok: false,
          error: { code: "rpc_timeout", message: "请求超时", retryable: spec.autoRetry }
        });
      }, spec.timeoutMs);
      pending.set(requestId, entry);

      if (!options.send(frame as RpcRequestFrame)) {
        remove(requestId, entry.timer);
        entry.settle({ ok: false, error: sendFailure() });
      }
    });
  }

  function settle(frame: RpcResponseFrame, expectedHostId: string | null): boolean {
    const requestId = readRpcRequestId(frame);
    if (requestId === null) {
      options.onDiagnostic?.({ scope: "rpc", message: "rpc.response without requestId" });
      return false;
    }
    if (expectedHostId !== null && frame.hostId !== expectedHostId) {
      options.onDiagnostic?.({ scope: "rpc", message: "rpc.response hostId mismatch" });
      return false;
    }
    const entry = pending.get(requestId);
    if (!entry) {
      // Late or unknown: the request already timed out, was never ours, or lost its transport.
      options.onLateResponse?.({ requestId, method: null });
      return false;
    }
    if (frame.hostId !== entry.hostId) {
      options.onDiagnostic?.({ scope: "rpc", message: "rpc.response hostId does not match the request" });
      return false;
    }
    remove(requestId, entry.timer);

    if (frame.payload.ok) {
      entry.settle({ ok: true, value: frame.payload.result });
    } else {
      entry.settle({ ok: false, error: toFailure(frame.payload.error) });
    }
    return true;
  }

  /**
   * The Relay answers a rejected request with an `error` frame whose `id` is the request id
   * (`host_offline`, `request_expired`, `backpressure`, `duplicate_request`). Treating those as
   * connection-level noise would make the UI wait for the local timeout and then report
   * `rpc_timeout` for a failure the server had already explained.
   */
  function settleError(frame: ErrorFrame, expectedHostId: string | null): boolean {
    const entry = pending.get(frame.id);
    if (!entry) {
      // No such request: a connection-level error (its id is a connection id), already handled
      // by the transport layer.
      return false;
    }
    if (frame.hostId !== undefined && frame.hostId !== entry.hostId) {
      options.onDiagnostic?.({ scope: "rpc", message: "error frame hostId does not match the request" });
      return false;
    }
    if (expectedHostId !== null && frame.hostId !== undefined && frame.hostId !== expectedHostId) {
      options.onDiagnostic?.({
        scope: "rpc",
        message: "error frame hostId does not match the configured host"
      });
      return false;
    }
    remove(entry.requestId, entry.timer);
    const failure = toFailure(frame.payload);
    entry.settle({
      ok: false,
      // The Relay gave up waiting for the host, so the host may still have applied it.
      error: failure.code === "rpc_timeout" ? { ...failure, unknownOutcome: true } : failure
    });
    return true;
  }

  function rejectAll(failure: RpcFailure): void {
    for (const entry of [...pending.values()]) {
      remove(entry.requestId, entry.timer);
      entry.settle({ ok: false, error: failure });
    }
  }

  function dispose(): void {
    rejectAll({ code: "internal_error", message: "RPC 客户端已释放", retryable: false, unknownOutcome: true });
  }

  return {
    request,
    settle,
    settleError,
    rejectAll,
    pendingCount() {
      return pending.size;
    },
    dispose
  };
}

/**
 * Thin WeChat API adapter.
 *
 * Pages and services never touch `wx` directly: they depend on `WechatApi`, so the same code
 * runs unchanged in Node unit tests with an injected fake. W1 only needs login, storage and
 * the network basics; transport, resume and RPC (W2+) will extend this same seam.
 *
 * The adapter is intentionally dumb: it normalises callbacks into promises, wraps failures
 * with redacted messages, and does not interpret payloads, status codes or business errors.
 */

import { safeMessage } from "../utils/redact";

export type HttpMethod = "GET" | "POST";

export interface LoginTicket {
  /** Short-lived `wx.login` code. Never persisted; consumed server-side by the Relay. */
  readonly code: string;
}

export interface RequestOptions {
  readonly url: string;
  readonly method: HttpMethod;
  readonly header?: Readonly<Record<string, string>>;
  readonly data?: unknown;
  readonly timeout?: number;
}

export interface RequestResult<T> {
  readonly statusCode: number;
  readonly data: T;
}

export interface SocketMessageEvent {
  readonly data: unknown;
}

export interface SocketCloseEvent {
  readonly code: number;
  readonly reason: string;
}

export interface SocketErrorEvent {
  readonly errMsg: string;
}

export interface SocketTaskLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (event: SocketMessageEvent) => void): void;
  onError(listener: (event: SocketErrorEvent) => void): void;
  onClose(listener: (event: SocketCloseEvent) => void): void;
}

/** Object-form argument the real `wx` `SocketTask.send` requires. */
export interface WechatSocketTaskSendOptions {
  readonly data: string | ArrayBuffer;
  readonly success?: () => void;
  readonly fail?: (error: SocketErrorEvent) => void;
  readonly complete?: () => void;
}

export interface WechatSocketTaskCloseOptions {
  readonly code?: number;
  readonly reason?: string;
  readonly success?: () => void;
  readonly fail?: (error: SocketErrorEvent) => void;
  readonly complete?: () => void;
}

/**
 * The raw `SocketTask` returned by `wx.connectSocket`.
 *
 * Real WeChat is object-form: `send({ data })` and `close({ code, reason })`. This is deliberately
 * declared separately from `SocketTaskLike` (primitive-form `send(string)` / `close(code, reason)`):
 * treating the raw task as if it already spoke the business interface is what let the DEV
 * `admin.auth` frame fail to leave the device while every Node fake — which implemented
 * `SocketTaskLike` — kept passing. The adapter below is the single place that bridges the two.
 */
export interface WechatSocketTask {
  send(options: WechatSocketTaskSendOptions): void;
  /** The real `wx` signature requires the options object (it is not optional). */
  close(options: WechatSocketTaskCloseOptions): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (event: SocketMessageEvent) => void): void;
  onError(listener: (event: SocketErrorEvent) => void): void;
  onClose(listener: (event: SocketCloseEvent) => void): void;
}

export interface NetworkStatus {
  readonly isConnected: boolean;
  readonly networkType: string;
}

export interface ClientInfo {
  readonly SDKVersion: string;
  readonly version?: string;
  readonly language?: string;
}

export type MiniProgramEnvVersion = "develop" | "trial" | "release";

export interface WechatApi {
  /** Identifier of the implementation; useful in diagnostics and test assertions. */
  readonly kind: string;
  login(): Promise<LoginTicket>;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  request<T>(options: RequestOptions): Promise<RequestResult<T>>;
  connectSocket(options: { readonly url: string; readonly protocols?: readonly string[] }): SocketTaskLike;
  onNetworkStatusChange(listener: (status: NetworkStatus) => void): () => void;
  getClientInfo(): ClientInfo;
  getEnvVersion(): MiniProgramEnvVersion;
}

/** Structural subset of the global `wx` object this adapter actually calls. */
export interface WechatLike {
  login(option: {
    success?: (result: { code: string }) => void;
    fail?: (error: { errMsg: string }) => void;
  }): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  request(option: {
    url: string;
    method?: HttpMethod;
    header?: Record<string, string>;
    data?: unknown;
    timeout?: number;
    success?: (result: { statusCode: number; data: unknown }) => void;
    fail?: (error: { errMsg: string }) => void;
  }): void;
  connectSocket(option: { url: string; protocols?: readonly string[] }): WechatSocketTask;
  onNetworkStatusChange(listener: (status: NetworkStatus) => void): void;
  offNetworkStatusChange(listener: (status: NetworkStatus) => void): void;
  getAppBaseInfo(): ClientInfo;
  getAccountInfoSync(): { miniProgram?: { envVersion?: string } };
}

function toError(cause: unknown): Error {
  return new Error(safeMessage(cause));
}

/** Fixed prefix so a failure message can never carry the (token-bearing) frame itself. */
const SEND_FAILURE_PREFIX = "socket send failed";

/**
 * Normalises the real object-form `wx` `SocketTask` into the business `SocketTaskLike`.
 *
 * Both failure channels are preserved:
 * - a *raw* socket error (network drop, handshake failure) is forwarded to the business `onError`
 *   that `relaySocket.ts` registered — without this the state machine would never learn about the
 *   error and never reconnect;
 * - a *send* failure, which real `wx` reports asynchronously through `send`'s `fail` callback, is
 *   surfaced through the same `onError` listener because `SocketTaskLike.send` returns `void`.
 *
 * Either channel reports at most once per connection. Every message is a fixed prefix plus
 * `safeMessage(cause)` — never the frame — so the access token inside the outbound `admin.auth`
 * payload cannot leak through the failure path.
 */
export function adaptWechatSocketTask(task: WechatSocketTask): SocketTaskLike {
  let errorListener: ((event: SocketErrorEvent) => void) | null = null;
  let errorReported = false;

  const reportError = (message: string): void => {
    if (errorReported || errorListener === null) {
      return;
    }
    errorReported = true;
    errorListener({ errMsg: message });
  };

  // The business listener is registered later (relaySocket wires it after createSocket returns),
  // so the raw error is forwarded through the stored reference rather than directly.
  task.onError((event) => {
    reportError(`socket error: ${safeMessage(event)}`);
  });

  return {
    send(data) {
      try {
        task.send({
          data,
          fail: (cause) => reportError(`${SEND_FAILURE_PREFIX}: ${safeMessage(cause)}`)
        });
      } catch (error) {
        // A synchronous parameter error must reach the caller's try/catch, still redacted.
        throw toError(error);
      }
    },

    close(code, reason) {
      try {
        task.close({ code: code ?? 1000, reason: reason ?? "client_close" });
      } catch {
        // Mirror the previous contract: a socket that refuses to close must not take down the caller.
      }
    },

    onOpen(listener) {
      task.onOpen(listener);
    },

    onMessage(listener) {
      task.onMessage(listener);
    },

    onError(listener) {
      errorListener = listener;
    },

    onClose(listener) {
      task.onClose(listener);
    }
  };
}

export function createWechatApi(host: WechatLike): WechatApi {
  return {
    kind: "wx",

    login() {
      return new Promise<LoginTicket>((resolve, reject) => {
        host.login({
          success: (result) => resolve({ code: result.code }),
          fail: (error) => reject(toError(error))
        });
      });
    },

    getStorageSync(key) {
      try {
        return host.getStorageSync(key);
      } catch (error) {
        throw toError(error);
      }
    },

    setStorageSync(key, value) {
      try {
        host.setStorageSync(key, value);
      } catch (error) {
        throw toError(error);
      }
    },

    removeStorageSync(key) {
      try {
        host.removeStorageSync(key);
      } catch (error) {
        throw toError(error);
      }
    },

    request<T>(options: RequestOptions): Promise<RequestResult<T>> {
      return new Promise<RequestResult<T>>((resolve, reject) => {
        host.request({
          url: options.url,
          method: options.method,
          header: options.header ? { ...options.header } : undefined,
          data: options.data,
          timeout: options.timeout,
          success: (result) => resolve({ statusCode: result.statusCode, data: result.data as T }),
          fail: (error) => reject(toError(error))
        });
      });
    },

    connectSocket(options) {
      return adaptWechatSocketTask(host.connectSocket({ url: options.url, protocols: options.protocols }));
    },

    onNetworkStatusChange(listener) {
      const wrapped = (status: NetworkStatus): void => {
        listener({ isConnected: status.isConnected, networkType: status.networkType });
      };
      host.onNetworkStatusChange(wrapped);
      return () => host.offNetworkStatusChange(wrapped);
    },

    getClientInfo() {
      return host.getAppBaseInfo();
    },

    getEnvVersion() {
      const envVersion = host.getAccountInfoSync()?.miniProgram?.envVersion;
      return envVersion === "develop" || envVersion === "trial" ? envVersion : "release";
    }
  };
}

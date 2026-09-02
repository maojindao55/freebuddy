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
  connectSocket(option: { url: string; protocols?: readonly string[] }): SocketTaskLike;
  onNetworkStatusChange(listener: (status: NetworkStatus) => void): void;
  offNetworkStatusChange(listener: (status: NetworkStatus) => void): void;
  getAppBaseInfo(): ClientInfo;
  getAccountInfoSync(): { miniProgram?: { envVersion?: string } };
}

function toError(cause: unknown): Error {
  return new Error(safeMessage(cause));
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
      return host.connectSocket({ url: options.url, protocols: options.protocols });
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

/**
 * Fake `wx` host used to exercise the adapter. It implements the callback-style
 * `WechatLike` surface, not the promise-based `WechatApi`.
 */

import type {
  ClientInfo,
  NetworkStatus,
  SocketTaskLike,
  WechatLike
} from "../../miniprogram/platform/wechatApi";

export interface HostCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeWechatHostOptions {
  readonly loginCode?: string;
  readonly loginError?: { errMsg: string };
  readonly requestResult?: { statusCode: number; data: unknown };
  readonly requestError?: { errMsg: string };
  readonly envVersion?: string;
  readonly storage?: Readonly<Record<string, unknown>>;
}

export interface FakeWechatHost extends WechatLike {
  readonly calls: HostCall[];
  readonly storage: Map<string, unknown>;
  readonly sockets: Array<{ url: string; protocols?: readonly string[] }>;
  readonly sent: string[];
  emitNetworkStatus(status: NetworkStatus): void;
  listenerCount(): number;
}

export function createFakeWechatHost(options: FakeWechatHostOptions = {}): FakeWechatHost {
  const calls: HostCall[] = [];
  const storage = new Map<string, unknown>(Object.entries(options.storage ?? {}));
  const sockets: Array<{ url: string; protocols?: readonly string[] }> = [];
  const sent: string[] = [];
  let listeners: Array<(status: NetworkStatus) => void> = [];

  const record = (method: string, args: readonly unknown[]): void => {
    calls.push({ method, args });
  };

  return {
    calls,
    storage,
    sockets,
    sent,

    login(option) {
      record("login", [option]);
      if (options.loginError) {
        option.fail?.(options.loginError);
        return;
      }
      option.success?.({ code: options.loginCode ?? "fake-login-code" });
    },

    getStorageSync(key) {
      record("getStorageSync", [key]);
      return storage.get(key);
    },

    setStorageSync(key, value) {
      record("setStorageSync", [key, value]);
      storage.set(key, value);
    },

    removeStorageSync(key) {
      record("removeStorageSync", [key]);
      storage.delete(key);
    },

    request(option) {
      record("request", [option]);
      if (options.requestError) {
        option.fail?.(options.requestError);
        return;
      }
      option.success?.(options.requestResult ?? { statusCode: 200, data: { ok: true } });
    },

    connectSocket(option) {
      record("connectSocket", [option]);
      sockets.push({ url: option.url, protocols: option.protocols });
      const task: SocketTaskLike = {
        send: (data) => sent.push(data),
        close: () => undefined,
        onOpen: () => undefined,
        onMessage: () => undefined,
        onError: () => undefined,
        onClose: () => undefined
      };
      return task;
    },

    onNetworkStatusChange(listener) {
      record("onNetworkStatusChange", [listener]);
      listeners.push(listener);
    },

    offNetworkStatusChange(listener) {
      record("offNetworkStatusChange", [listener]);
      listeners = listeners.filter((item) => item !== listener);
    },

    getAppBaseInfo(): ClientInfo {
      record("getAppBaseInfo", []);
      return { SDKVersion: "3.5.0", version: "8.0.0", language: "zh_CN" };
    },

    getAccountInfoSync() {
      record("getAccountInfoSync", []);
      return { miniProgram: { envVersion: options.envVersion ?? "release" } };
    },

    emitNetworkStatus(status) {
      for (const listener of [...listeners]) {
        listener(status);
      }
    },

    listenerCount() {
      return listeners.length;
    }
  };
}

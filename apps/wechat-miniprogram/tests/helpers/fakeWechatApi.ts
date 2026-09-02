/** `WechatApi` test double. Lives under `tests/` so it can never reach a release bundle. */

import type {
  ClientInfo,
  MiniProgramEnvVersion,
  NetworkStatus,
  RequestOptions,
  RequestResult,
  SocketTaskLike,
  WechatApi
} from "../../miniprogram/platform/wechatApi";

export interface FakeWechatApiOptions {
  readonly envVersion?: MiniProgramEnvVersion;
  readonly storage?: Readonly<Record<string, unknown>>;
  readonly failWith?: string;
}

export interface RecordingWechatApi extends WechatApi {
  readonly calls: string[];
  readonly storage: Map<string, unknown>;
}

function boom(message: string): never {
  throw new Error(message);
}

export function createFakeWechatApi(options: FakeWechatApiOptions = {}): RecordingWechatApi {
  const calls: string[] = [];
  const storage = new Map<string, unknown>(Object.entries(options.storage ?? {}));
  const guard = (method: string): void => {
    calls.push(method);
    if (options.failWith) {
      boom(options.failWith);
    }
  };

  return {
    kind: "fake",
    calls,
    storage,

    login() {
      guard("login");
      return Promise.resolve({ code: "fake-code" });
    },

    getStorageSync(key) {
      guard("getStorageSync");
      return storage.get(key);
    },

    setStorageSync(key, value) {
      guard("setStorageSync");
      storage.set(key, value);
    },

    removeStorageSync(key) {
      guard("removeStorageSync");
      storage.delete(key);
    },

    request<T>(_options: RequestOptions): Promise<RequestResult<T>> {
      guard("request");
      return Promise.resolve({ statusCode: 200, data: undefined as T });
    },

    connectSocket(_options: { url: string }): SocketTaskLike {
      guard("connectSocket");
      return {
        send: () => undefined,
        close: () => undefined,
        onOpen: () => undefined,
        onMessage: () => undefined,
        onError: () => undefined,
        onClose: () => undefined
      };
    },

    onNetworkStatusChange(_listener: (status: NetworkStatus) => void) {
      guard("onNetworkStatusChange");
      return () => undefined;
    },

    getClientInfo(): ClientInfo {
      guard("getClientInfo");
      return { SDKVersion: "3.5.0" };
    },

    getEnvVersion(): MiniProgramEnvVersion {
      guard("getEnvVersion");
      return options.envVersion ?? "release";
    }
  };
}

/** Every method throws: proves a caller really does not touch the WeChat API. */
export function createExplodingWechatApi(message = "WeChat API must not be called"): RecordingWechatApi {
  return createFakeWechatApi({ failWith: message });
}

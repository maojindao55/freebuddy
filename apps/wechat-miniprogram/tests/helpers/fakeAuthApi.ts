/**
 * Scripted `WechatApi` for the auth tests.
 *
 * It routes HTTP calls by protocol path, so a test can make `/v1/auth/wechat` succeed while
 * `/v1/auth/refresh` is revoked — the exact combination that proves refresh/replay handling.
 * Every request is recorded verbatim (url, method, header, body) so a test can assert what went on
 * the wire without a real network, and storage can be made to fail to prove the "a session that
 * cannot be persisted is not a session" rule.
 */

import type {
  ClientInfo,
  MiniProgramEnvVersion,
  NetworkStatus,
  RequestOptions,
  RequestResult,
  SocketTaskLike,
  WechatApi
} from "../../miniprogram/platform/wechatApi";

export interface ScriptedResponse {
  readonly statusCode: number;
  readonly data: unknown;
}

export type RouteOutcome = ScriptedResponse | { readonly networkError: string };

export type LoginOutcome = { readonly code: string } | { readonly error: string };

export interface FakeAuthApi extends WechatApi {
  readonly requests: RequestOptions[];
  readonly storage: Map<string, unknown>;
  /** Number of `wx.login` calls; the code value itself is never asserted from here. */
  loginCalls(): number;
  setLoginOutcome(outcome: LoginOutcome): void;
  route(path: string, outcome: RouteOutcome): void;
  /** Make every storage write throw, simulating a platform that refuses to persist. */
  failStorageWrites(value: boolean): void;
  pathsRequested(): readonly string[];
}

export const AUTH_PATHS = {
  wechat: "/v1/auth/wechat",
  refresh: "/v1/auth/refresh",
  logout: "/v1/sessions/logout"
} as const;

export function createFakeAuthApi(
  options: { readonly storage?: Record<string, unknown>; readonly envVersion?: MiniProgramEnvVersion } = {}
): FakeAuthApi {
  const requests: RequestOptions[] = [];
  const storage = new Map<string, unknown>(Object.entries(options.storage ?? {}));
  const routes = new Map<string, RouteOutcome>();
  let loginOutcome: LoginOutcome = { code: "wx-login-code-abcdef" };
  let logins = 0;
  let failWrites = false;

  function pathOf(url: string): string {
    const match = Object.values(AUTH_PATHS).find((path) => url.endsWith(path));
    return match ?? url;
  }

  return {
    kind: "fake-auth",
    requests,
    storage,

    loginCalls() {
      return logins;
    },

    setLoginOutcome(outcome) {
      loginOutcome = outcome;
    },

    route(path, outcome) {
      routes.set(path, outcome);
    },

    failStorageWrites(value) {
      failWrites = value;
    },

    pathsRequested() {
      return requests.map((request) => pathOf(request.url));
    },

    login() {
      logins += 1;
      if ("error" in loginOutcome) {
        return Promise.reject(new Error(loginOutcome.error));
      }
      return Promise.resolve({ code: loginOutcome.code });
    },

    getStorageSync(key) {
      return storage.get(key);
    },

    setStorageSync(key, value) {
      if (failWrites) {
        throw new Error("storage is unavailable");
      }
      storage.set(key, value);
    },

    removeStorageSync(key) {
      storage.delete(key);
    },

    request<T>(request: RequestOptions): Promise<RequestResult<T>> {
      requests.push(request);
      const outcome = routes.get(pathOf(request.url));
      if (outcome === undefined) {
        return Promise.reject(new Error(`no route scripted for ${pathOf(request.url)}`));
      }
      if ("networkError" in outcome) {
        return Promise.reject(new Error(outcome.networkError));
      }
      return Promise.resolve({ statusCode: outcome.statusCode, data: outcome.data as T });
    },

    connectSocket(_options: { url: string }): SocketTaskLike {
      throw new Error("auth tests must not open a socket");
    },

    onNetworkStatusChange(_listener: (status: NetworkStatus) => void) {
      return () => undefined;
    },

    getClientInfo(): ClientInfo {
      return { SDKVersion: "3.5.0", version: "0.9.10" };
    },

    getEnvVersion(): MiniProgramEnvVersion {
      return options.envVersion ?? "develop";
    }
  };
}

/**
 * A protocol-valid token pair (>= 32 chars of `[A-Za-z0-9._~-]`), with values distinctive enough
 * to be grepped for in state, logs or page data.
 */
export function tokenPair(label: string): { accessToken: string; refreshToken: string } {
  return {
    accessToken: `access-token-${label}-0123456789abcdef0123456789abcdef`,
    refreshToken: `refresh-token-${label}-0123456789abcdef0123456789abcdef`
  };
}

export function authResponse(
  label: string,
  expiresIn = 3600,
  refreshExpiresIn = 86_400
): { accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresIn: number } {
  const pair = tokenPair(label);
  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn,
    refreshExpiresIn
  };
}

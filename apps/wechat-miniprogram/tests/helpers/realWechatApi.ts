/**
 * A production-shaped `WechatApi` for the formal-auth integration test.
 *
 * The mini program services depend on the `WechatApi` seam and nothing else. On device that seam
 * is `wx.*`; here it is filled with the real thing each method stands for, so the production
 * `createAuthSession` / `createAuthClient` and the production transport run unmodified:
 *
 * - `request` performs a real HTTP POST to the Relay over loopback (so `/v1/auth/wechat`,
 *   `/v1/auth/refresh` and `/v1/sessions/logout` are the real endpoints);
 * - `connectSocket` opens a real WebSocket (the same seam the W2 integration tests swap);
 * - `login` returns a scripted `wx.login` code the test controls per scenario;
 * - storage is an in-memory map, exactly like `wx.setStorageSync`.
 *
 * It records only non-secret facts: the HTTP probes keep the URL, method and whether an
 * `Authorization` header was present — never the header value — and the socket recorder keeps the
 * outbound frames so the test can prove the formal access token (not a DEV token) was presented.
 */

import { request as httpRequest } from "node:http";

import type {
  ClientInfo,
  LoginTicket,
  MiniProgramEnvVersion,
  NetworkStatus,
  RequestOptions,
  RequestResult,
  SocketTaskLike,
  WechatApi
} from "../../miniprogram/platform/wechatApi";
import { createRealSocketTask } from "./realSocket";

export interface HttpProbe {
  readonly url: string;
  readonly method: string;
  /** Presence only: the header value is a bearer token and is deliberately not kept. */
  readonly hasAuthorization: boolean;
}

export interface RealWechatApiOptions {
  /** Called for every `wx.login`; the test sets the code per scenario. */
  readonly loginCode: () => string;
  readonly envVersion?: MiniProgramEnvVersion;
  readonly clientVersion?: string;
}

export interface RealWechatApi extends WechatApi {
  readonly storage: Map<string, unknown>;
  readonly httpProbes: HttpProbe[];
  readonly socketUrls: string[];
  /** Raw frames the transport put on the wire, in order. */
  readonly sentFrames: string[];
  setLoginCode(code: () => string): void;
}

/** Minimal JSON POST over loopback. `agent: false` closes the socket so the test process can exit. */
export function postJson(
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  timeoutMs = 10_000
): Promise<{ readonly statusCode: number; readonly data: unknown }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = Buffer.from(JSON.stringify(body ?? {}), "utf8");
    const request = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payload.byteLength),
          ...headers
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: unknown = null;
          if (text.length > 0) {
            try {
              data = JSON.parse(text) as unknown;
            } catch {
              data = text;
            }
          }
          resolve({ statusCode: response.statusCode ?? 0, data });
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

export function createRealWechatApi(options: RealWechatApiOptions): RealWechatApi {
  const storage = new Map<string, unknown>();
  const httpProbes: HttpProbe[] = [];
  const socketUrls: string[] = [];
  const sentFrames: string[] = [];
  let loginCode = options.loginCode;

  return {
    kind: "real-wx",
    storage,
    httpProbes,
    socketUrls,
    sentFrames,

    setLoginCode(code) {
      loginCode = code;
    },

    login(): Promise<LoginTicket> {
      // A `wx.login` code is short-lived; the value is scripted so a scenario can choose which
      // fake OpenID the Relay is about to obtain. It is never persisted.
      return Promise.resolve({ code: loginCode() });
    },

    getStorageSync(key) {
      return storage.get(key);
    },

    setStorageSync(key, value) {
      storage.set(key, value);
    },

    removeStorageSync(key) {
      storage.delete(key);
    },

    async request<T>(request: RequestOptions): Promise<RequestResult<T>> {
      httpProbes.push({
        url: request.url,
        method: request.method,
        hasAuthorization:
          typeof request.header?.Authorization === "string" && request.header.Authorization.length > 0
      });
      const result = await postJson(request.url, request.data, request.header, request.timeout);
      return { statusCode: result.statusCode, data: result.data as T };
    },

    connectSocket({ url }): SocketTaskLike {
      socketUrls.push(url);
      const task = createRealSocketTask(url);
      return {
        send(data) {
          sentFrames.push(data);
          task.send(data);
        },
        close(code, reason) {
          task.close(code, reason);
        },
        onOpen(listener) {
          task.onOpen(listener);
        },
        onMessage(listener) {
          task.onMessage(listener);
        },
        onError(listener) {
          task.onError(listener);
        },
        onClose(listener) {
          task.onClose(listener);
        }
      };
    },

    onNetworkStatusChange(_listener: (status: NetworkStatus) => void) {
      // The auth flow does not depend on network events; the App session may register one.
      return () => undefined;
    },

    getClientInfo(): ClientInfo {
      return { SDKVersion: "3.5.0", version: options.clientVersion ?? "0.0.0-auth-e2e" };
    },

    getEnvVersion(): MiniProgramEnvVersion {
      return options.envVersion ?? "develop";
    }
  };
}

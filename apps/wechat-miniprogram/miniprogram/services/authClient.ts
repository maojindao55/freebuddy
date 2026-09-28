/**
 * Companion HTTP client for the WeChat administrator login (`protocol/remote/v1/http.schema.json`).
 *
 * Three endpoints exist before the WebSocket session begins:
 *
 *   POST /v1/auth/wechat        wx.login code  -> access/refresh token pair
 *   POST /v1/auth/refresh       refresh token  -> rotated access/refresh token pair
 *   POST /v1/sessions/logout    access token   -> revoke this session (best effort)
 *
 * Deliberate properties:
 *
 * - **No arbitrary endpoint.** The base URL is a constructor argument taken from the resolved
 *   environment table, with no setter. Neither a QR payload, a deep link nor a storage value can
 *   redirect a credential, and the request target is `<base><fixed path>` with no caller-supplied
 *   path, query or header.
 * - **The body contract is the frozen schema.** Requests are typed by the generated binding and
 *   responses are admitted through `parseHttpBody`, so a response with an unknown field, a
 *   short/oversized token or an out-of-range TTL is rejected instead of being trusted. No wire
 *   field is declared, renamed or extended here.
 * - **No secret is echoed.** Failures carry the server's own `message` run through `safeMessage`,
 *   and never the request body, the login code or a token. Nothing in this file logs.
 * - **Failure is a value, not an exception.** A business error, an unparsable body and a failed
 *   transport all come back as an `AuthFailure`, so callers cannot accidentally treat "no answer"
 *   as "not an admin" (or the reverse).
 */

import { parseEndpoint, type ResolvedEnvironment } from "../config/runtimeConfig";
import { parseHttpBody, type HttpError, type RemoteErrorCode, type WeChatAuthResponse } from "../protocol/index";
import type { WechatApi } from "../platform/wechatApi";
import { safeMessage } from "../utils/redact";

/** Paths fixed by the companion HTTP contract; not assembled from caller input. */
const WECHAT_AUTH_PATH = "/v1/auth/wechat";
const REFRESH_PATH = "/v1/auth/refresh";
const LOGOUT_PATH = "/v1/sessions/logout";

export const AUTH_REQUEST_TIMEOUT_MS = 10_000;

/** Why an auth call failed, in the terms the UI and the state machine need. */
export type AuthFailureKind =
  /** Server said the WeChat account is not the unique administrator. Terminal: do not retry. */
  | "non_admin"
  /** Credential invalid/expired/revoked (or the login code was rejected upstream). */
  | "unauthorized"
  | "unsupported_version"
  | "invalid_request"
  /** The request never produced an answer (offline, DNS, TLS, timeout). */
  | "network"
  /** An answer arrived but did not satisfy the frozen body contract. */
  | "invalid_response"
  | "server_error";

export interface AuthFailure {
  readonly kind: AuthFailureKind;
  /** Protocol error code when the server spoke `StructuredError`; otherwise null. */
  readonly code: RemoteErrorCode | null;
  /** Short, redacted, safe to render. Never contains a token, code or endpoint. */
  readonly message: string;
  readonly retryable: boolean;
  readonly statusCode: number | null;
}

export type AuthOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: AuthFailure };

export interface WeChatAuthRequestInput {
  /** Short-lived `wx.login` code. Sent once, never stored. */
  readonly code: string;
  readonly clientVersion: string;
  /** Optional non-sensitive label; never an identifier derived from the WeChat account. */
  readonly deviceLabel?: string;
}

export interface AuthClient {
  /** Derived from the environment table; exposed for diagnostics, never settable. */
  readonly httpBaseUrl: string;
  requestWeChatAuth(input: WeChatAuthRequestInput): Promise<AuthOutcome<WeChatAuthResponse>>;
  refresh(refreshToken: string): Promise<AuthOutcome<WeChatAuthResponse>>;
  /** Best effort: callers clear local state regardless of the outcome. */
  logout(accessToken: string): Promise<AuthOutcome<Record<string, never>>>;
}

export interface AuthClientOptions {
  readonly api: Pick<WechatApi, "request">;
  readonly environment: ResolvedEnvironment;
  readonly timeoutMs?: number;
}

/** Maps a `StructuredError` code to the reaction the client must take. */
export function kindForErrorCode(code: RemoteErrorCode): AuthFailureKind {
  switch (code) {
    case "forbidden":
      return "non_admin";
    case "unauthorized":
    case "request_expired":
      return "unauthorized";
    case "unsupported_version":
      return "unsupported_version";
    case "invalid_request":
    case "method_not_allowed":
    case "not_found":
      return "invalid_request";
    default:
      // host_offline, rpc_timeout, backpressure, conflict, duplicate_request, internal_error.
      return "server_error";
  }
}

function failure(
  kind: AuthFailureKind,
  message: string,
  options: { readonly code?: RemoteErrorCode | null; readonly retryable?: boolean; readonly statusCode?: number | null } = {}
): AuthFailure {
  return {
    kind,
    code: options.code ?? null,
    message: safeMessage(message),
    retryable: options.retryable ?? false,
    statusCode: options.statusCode ?? null
  };
}

function transportFailure(error: unknown): AuthFailure {
  // Only the redacted, truncated platform message is kept: a failing request may embed the URL
  // or a payload in its error text.
  return failure("network", safeMessage(error), { retryable: true });
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const { api, environment } = options;
  const timeoutMs = options.timeoutMs ?? AUTH_REQUEST_TIMEOUT_MS;

  // Re-prove the endpoint at construction: `<scheme>://<host>` only, and a release/prod build must
  // never talk to a plaintext host. The environment table is validated at boot too; this keeps the
  // client safe when constructed directly (tests, future callers).
  const parsed = parseEndpoint(environment.httpBaseUrl);
  if (parsed.protocol !== "http" && parsed.protocol !== "https") {
    throw new Error(`auth base URL must use http or https, got ${parsed.protocol}`);
  }
  if (environment.name === "prod" && parsed.protocol !== "https") {
    throw new Error("prod auth base URL must use https");
  }
  const httpBaseUrl = environment.httpBaseUrl;

  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<
    | { readonly kind: "response"; readonly statusCode: number; readonly data: unknown }
    | { readonly kind: "transport_failure"; readonly failure: AuthFailure }
  > {
    try {
      const result = await api.request<unknown>({
        url: `${httpBaseUrl}${path}`,
        method: "POST",
        header: { "Content-Type": "application/json", ...headers },
        data: body,
        timeout: timeoutMs
      });
      return { kind: "response", statusCode: result.statusCode, data: result.data };
    } catch (error) {
      return { kind: "transport_failure", failure: transportFailure(error) };
    }
  }

  function parseErrorBody(statusCode: number, data: unknown): AuthFailure {
    const parsed = parseHttpBody("HttpError", data);
    if (!parsed.ok) {
      // A proxy, a captive portal or a drifted server answered. The status code is all we know;
      // the body is not echoed because it is not a contract we validated.
      return failure("invalid_response", `服务端返回了无法识别的响应（HTTP ${statusCode}）`, {
        statusCode,
        retryable: statusCode >= 500
      });
    }
    const error: HttpError = parsed.value;
    return failure(kindForErrorCode(error.code), error.message, {
      code: error.code,
      retryable: error.retryable,
      statusCode
    });
  }

  function parseTokenPair(
    statusCode: number,
    data: unknown
  ): AuthOutcome<WeChatAuthResponse> {
    if (statusCode !== 200) {
      return { ok: false, failure: parseErrorBody(statusCode, data) };
    }
    const parsed = parseHttpBody("WeChatAuthResponse", data);
    if (!parsed.ok) {
      return {
        ok: false,
        failure: failure("invalid_response", "登录响应不符合协议 v1（已拒绝）", {
          statusCode,
          retryable: false
        })
      };
    }
    return { ok: true, value: parsed.value };
  }

  return {
    httpBaseUrl,

    async requestWeChatAuth(input) {
      // The request body is exactly the schema's fields; an empty or overlong code is refused
      // locally rather than being sent as an invalid request.
      if (typeof input.code !== "string" || input.code.length < 1 || input.code.length > 256) {
        return { ok: false, failure: failure("invalid_request", "登录凭证无效，请重试") };
      }
      const body: Record<string, string> = {
        code: input.code,
        clientVersion: input.clientVersion
      };
      if (input.deviceLabel !== undefined && input.deviceLabel.length > 0) {
        body.deviceLabel = input.deviceLabel.slice(0, 64);
      }
      const outcome = await post(WECHAT_AUTH_PATH, body);
      if (outcome.kind === "transport_failure") {
        return { ok: false, failure: outcome.failure };
      }
      return parseTokenPair(outcome.statusCode, outcome.data);
    },

    async refresh(refreshToken) {
      const outcome = await post(REFRESH_PATH, { refreshToken });
      if (outcome.kind === "transport_failure") {
        return { ok: false, failure: outcome.failure };
      }
      return parseTokenPair(outcome.statusCode, outcome.data);
    },

    async logout(accessToken) {
      // The access token is carried in the standard header, never in the body or the URL.
      const outcome = await post(LOGOUT_PATH, {}, { Authorization: `Bearer ${accessToken}` });
      if (outcome.kind === "transport_failure") {
        return { ok: false, failure: outcome.failure };
      }
      if (outcome.statusCode !== 200) {
        return { ok: false, failure: parseErrorBody(outcome.statusCode, outcome.data) };
      }
      return { ok: true, value: {} };
    }
  };
}

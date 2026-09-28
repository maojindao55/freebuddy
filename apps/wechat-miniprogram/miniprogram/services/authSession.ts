/**
 * Administrator authentication session (M4): the single authority on which credential the
 * transport may use.
 *
 * Flow, exactly as `docs/plans/2026-09-01-005-remote-admin-wechat-miniprogram-plan.md` requires:
 *
 * 1. `wx.login` (through the adapter) yields a short-lived code.
 * 2. `POST /v1/auth/wechat` exchanges it; the Relay decides admin-ness by comparing the WeChat
 *    OpenID it obtains itself. This client never learns the OpenID and never claims an identity.
 * 3. The returned opaque access/refresh pair is persisted by `services/tokenStore.ts`.
 * 4. The access token is refreshed before it expires; rotation replaces both tokens atomically.
 * 5. `revoked`/`replay`/`forbidden` clears the local session and returns the operator to login.
 *
 * Why this is one state machine instead of page code:
 *
 * - a mini program can be reclaimed at any moment, so "which credential exists" must be answered
 *   from persisted state after a cold start, not from page data;
 * - refresh must be single-flight: two concurrent rotations would spend a one-time refresh token
 *   twice and the server would (correctly) reject the second as a replay;
 * - the three failure classes must not be confused. A **transient network failure keeps the
 *   session** — signing the only administrator out because a tunnel blipped would be a worse
 *   outcome than a retry — while a **rejected credential clears it**, because keeping a token the
 *   server has refused is how a client ends up stuck in a permission error forever.
 *
 * No credential material is ever recorded in the state this publishes, so a UI or a diagnostic
 * dump cannot leak it.
 */

import type { ResolvedEnvironment } from "../config/runtimeConfig";
import type { RemoteErrorCode } from "../protocol/index";
import type { WechatApi } from "../platform/wechatApi";
import { createStore, type Store } from "../stores/createStore";
import { createWechatAuthTokenStore, recordFromAuthResponse, type AuthSessionRecord, type AuthTokenStore } from "./tokenStore";
import { createAuthClient, type AuthClient, type AuthFailure, type AuthFailureKind } from "./authClient";
import { getOperatorTokenSession, type OperatorTokenSession } from "./adminSession";
/** The credential seam is owned by the transport (`services/adminConnection.ts`). */
import type { AdminCredential } from "./adminConnection";
import { safeMessage } from "../utils/redact";

/** Refresh this long before the access token actually expires, to absorb clock skew and RTT. */
export const REFRESH_SKEW_MS = 60_000;

export type AuthMode = "none" | "dev" | "wechat";

export type AuthStatus =
  | "signedOut"
  | "authenticating"
  | "signedIn"
  | "refreshing"
  | "expired"
  | "rejected"
  | "error";

export interface AuthState {
  readonly mode: AuthMode;
  readonly status: AuthStatus;
  /** A usable credential is available right now. */
  readonly hasCredential: boolean;
  readonly accessExpiresAtMs: number | null;
  readonly refreshExpiresAtMs: number | null;
  readonly accessExpired: boolean;
  readonly refreshExpired: boolean;
  readonly lastErrorKind: AuthFailureKind | null;
  /** Redacted and truncated; safe to render. */
  readonly lastError: string;
}

export interface LoginOutcome {
  readonly ok: boolean;
  readonly kind: AuthFailureKind | null;
  readonly message: string;
}

export interface LogoutOutcome {
  /** Always true: a logout that cannot reach the server still clears this device. */
  readonly localCleared: true;
  readonly revoked: "ok" | "failed" | "skipped";
}

export interface AuthSession {
  readonly credential: AdminCredential;
  /** Derived from the environment table; never operator input. */
  readonly httpBaseUrl: string;
  getState(): AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;
  /** `wx.login` -> `/v1/auth/wechat`. Rejects nothing; every failure is an outcome. */
  loginWithWeChat(): Promise<LoginOutcome>;
  /** True when the access token is expired or close enough that a reconnect should refresh first. */
  needsRefresh(): boolean;
  /** Single-flight rotation. Resolves true when a fresh access token is stored. */
  refreshNow(): Promise<boolean>;
  handleAuthRejected(code: RemoteErrorCode | null): Promise<boolean>;
  logout(): Promise<LogoutOutcome>;
  getAccessToken(): string | null;
  hasCredential(): boolean;
  dispose(): void;
}

export interface AuthSessionOptions {
  readonly api: WechatApi;
  readonly environment: ResolvedEnvironment;
  readonly clientVersion: string;
  readonly tokenStore?: AuthTokenStore;
  readonly authClient?: AuthClient;
  /** In-memory DEV credential (local builds only). Shared with the transport. */
  readonly devSession?: OperatorTokenSession;
  readonly nowMs?: () => number;
  /** Optional non-sensitive device label for the auth request. Never WeChat-derived. */
  readonly deviceLabel?: string;
}

/** `WeChatAuthRequest.clientVersion` is 1..64 chars; the platform value is trimmed to fit. */
function normalizeClientVersion(value: unknown): string {
  if (typeof value !== "string") {
    return "0.0.0";
  }
  const trimmed = value.trim().slice(0, 64);
  return trimmed.length > 0 ? trimmed : "0.0.0";
}

export function createAuthSession(options: AuthSessionOptions): AuthSession {
  const { api, environment } = options;
  const nowMs = options.nowMs ?? (() => Date.now());
  const devSession = options.devSession ?? getOperatorTokenSession();
  const tokenStore = options.tokenStore ?? createWechatAuthTokenStore(api);
  const authClient =
    options.authClient ?? createAuthClient({ api, environment });
  const clientVersion = normalizeClientVersion(options.clientVersion);

  const store: Store<AuthState> = createStore<AuthState>({
    mode: "none",
    status: "signedOut",
    hasCredential: false,
    accessExpiresAtMs: null,
    refreshExpiresAtMs: null,
    accessExpired: false,
    refreshExpired: false,
    lastErrorKind: null,
    lastError: ""
  });

  // Explicit flow status; `mode`/`hasCredential`/expiry flags are derived so they can never
  // disagree with what is actually persisted.
  let status: AuthStatus = "signedOut";
  let lastErrorKind: AuthFailureKind | null = null;
  let lastError = "";

  let refreshInFlight: Promise<boolean> | null = null;
  let loginInFlight: Promise<LoginOutcome> | null = null;

  function record(): AuthSessionRecord | null {
    return tokenStore.read();
  }

  function mode(): AuthMode {
    if (devSession.hasToken()) {
      return "dev";
    }
    return record() !== null ? "wechat" : "none";
  }

  function getAccessToken(): string | null {
    // An explicitly armed DEV credential wins: it only exists inside a local, operator-armed
    // build (`config/devAccess.ts`), and it is memory-only.
    const devToken = devSession.readToken();
    if (devToken) {
      return devToken;
    }
    const current = record();
    if (!current) {
      return null;
    }
    // An expired token is never handed out: the socket would only earn a `forbidden`.
    return nowMs() >= current.accessExpiresAtMs ? null : current.accessToken;
  }

  /**
   * Reads the derived fields from the live sources every time. `mode`/`hasCredential` must not be
   * cached: the DEV operator token can be set through the transport's own DEV panel without this
   * session being told, and a cached mode would then misreport which credential is in force.
   */
  function computeState(): AuthState {
    const current = record();
    const now = nowMs();
    return {
      mode: mode(),
      status,
      hasCredential: getAccessToken() !== null,
      accessExpiresAtMs: current?.accessExpiresAtMs ?? null,
      refreshExpiresAtMs: current?.refreshExpiresAtMs ?? null,
      accessExpired: current !== null && now >= current.accessExpiresAtMs,
      refreshExpired: current !== null && now >= current.refreshExpiresAtMs,
      lastErrorKind,
      lastError
    };
  }

  function publish(): AuthState {
    const next = computeState();
    store.setState(() => next);
    return next;
  }

  function fail(kind: AuthFailureKind, message: string): void {
    status = kind === "non_admin" ? "rejected" : kind === "unauthorized" ? "expired" : "error";
    lastErrorKind = kind;
    lastError = safeMessage(message);
    publish();
  }

  /**
   * Drops the WeChat-issued session. Used when the *server* refused that session or a rotation
   * failed, so a credential the Relay has rejected can never be reused. An unrelated in-memory DEV
   * credential is deliberately left alone here: a refused WeChat login must not knock out a working
   * local DEV connection.
   */
  function clearWechatSession(reason: string, nextStatus: AuthStatus): void {
    tokenStore.clear();
    status = nextStatus;
    lastErrorKind = null;
    lastError = reason.length > 0 ? safeMessage(reason) : "";
    publish();
  }

  /** Drops every local credential (WeChat session and DEV token). Explicit sign-out only. */
  function clearLocal(reason: string, nextStatus: AuthStatus = "signedOut"): void {
    tokenStore.clear();
    devSession.clear();
    status = nextStatus;
    lastErrorKind = null;
    lastError = reason.length > 0 ? safeMessage(reason) : "";
    publish();
  }

  function requestFailureMessage(failure: AuthFailure): string {
    switch (failure.kind) {
      case "non_admin":
        return "该微信账号不是唯一管理员，已拒绝进入。";
      case "unauthorized":
        return failure.code === "request_expired"
          ? "登录凭证已过期，请重新登录。"
          : "登录凭证无效或已被撤销，请重新登录。";
      case "network":
        return "网络不可用，未能完成登录，请检查网络后重试。";
      case "invalid_response":
        return "服务端响应不符合协议 v1，已拒绝。";
      case "unsupported_version":
        return "客户端与服务端协议版本不兼容，请升级后重试。";
      case "invalid_request":
        return "登录请求被服务端拒绝。";
      default:
        return "服务端暂时不可用，请稍后重试。";
    }
  }

  async function login(): Promise<LoginOutcome> {
    status = "authenticating";
    lastErrorKind = null;
    lastError = "";
    publish();

    let code: string;
    try {
      const ticket = await api.login();
      code = ticket.code;
    } catch (error) {
      // The code never leaves this scope, and the platform message is redacted before display.
      fail("network", safeMessage(error));
      return { ok: false, kind: "network", message: lastError };
    }

    const outcome = await authClient.requestWeChatAuth({
      code,
      clientVersion,
      deviceLabel: options.deviceLabel
    });

    if (!outcome.ok) {
      const { failure } = outcome;
      if (failure.kind === "non_admin" || failure.kind === "unauthorized") {
        // A refused login must not inherit a credential from an earlier session.
        clearWechatSession(requestFailureMessage(failure), failure.kind === "non_admin" ? "rejected" : "expired");
        return { ok: false, kind: failure.kind, message: lastError };
      }
      fail(failure.kind, requestFailureMessage(failure));
      return { ok: false, kind: failure.kind, message: lastError };
    }

    const persisted = tokenStore.write(recordFromAuthResponse(outcome.value, nowMs()));
    if (!persisted) {
      // We deliberately keep no in-memory copy, so a session that cannot be persisted is not a
      // session. Retrying is the operator's call.
      fail("invalid_response", "无法在本机保存登录状态，请重试。");
      return { ok: false, kind: "invalid_response", message: lastError };
    }

    // A WeChat session supersedes any DEV credential: exactly one credential may be in force.
    devSession.clear();
    status = "signedIn";
    lastErrorKind = null;
    lastError = "";
    publish();
    return { ok: true, kind: null, message: "" };
  }

  function loginWithWeChat(): Promise<LoginOutcome> {
    // Double-tap protection: a second tap must not spend a second login code.
    if (loginInFlight) {
      return loginInFlight;
    }
    loginInFlight = login().finally(() => {
      loginInFlight = null;
    });
    return loginInFlight;
  }

  function needsRefresh(): boolean {
    if (devSession.hasToken()) {
      return false;
    }
    if (loginInFlight) {
      // A login in flight is already establishing a fresh session; rotating the old one now would
      // spend a token the new session is about to replace.
      return false;
    }
    const current = record();
    if (!current) {
      return false;
    }
    const now = nowMs();
    if (now >= current.refreshExpiresAtMs) {
      // Nothing can refresh this session; going to login is the only path.
      return false;
    }
    return now >= current.accessExpiresAtMs - REFRESH_SKEW_MS;
  }

  async function refresh(): Promise<boolean> {
    if (loginInFlight) {
      // See `needsRefresh`: do not spend the old refresh token while a login is replacing it.
      return false;
    }
    const current = record();
    if (!current) {
      return false;
    }
    const now = nowMs();
    if (now >= current.refreshExpiresAtMs) {
      clearWechatSession("登录状态已过期，请重新登录。", "expired");
      return false;
    }

    status = "refreshing";
    publish();

    const outcome = await authClient.refresh(current.refreshToken);
    if (outcome.ok) {
      const next: AuthSessionRecord = recordFromAuthResponse(outcome.value, nowMs());
      if (!tokenStore.write(next)) {
        // The server has already invalidated the old refresh token, so a rotation that cannot be
        // persisted is unrecoverable: signing out is the only honest outcome.
        clearWechatSession("刷新后无法保存登录状态，请重新登录。", "expired");
        return false;
      }
      status = "signedIn";
      lastErrorKind = null;
      lastError = "";
      publish();
      return true;
    }

    const { failure } = outcome;
    if (failure.kind === "unauthorized" || failure.kind === "non_admin") {
      // Replay of a rotated/revoked refresh token, or a revoked admin: forget it and re-login.
      clearWechatSession(requestFailureMessage(failure), "expired");
      return false;
    }

    // Network or server failure: the stored pair may still be valid, so it is *kept*. Only the
    // error is surfaced; a later attempt (or the next foreground) can rotate normally.
    fail(failure.kind, requestFailureMessage(failure));
    return false;
  }

  function refreshNow(): Promise<boolean> {
    // Single-flight: a one-time refresh token must never be spent twice concurrently.
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = refresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function handleAuthRejected(code: RemoteErrorCode | null): Promise<boolean> {
    if (code === "forbidden") {
      // The server said this caller is not the administrator. No refresh can change that.
      clearLocal("服务器拒绝了当前会话，请重新登录。", "rejected");
      return false;
    }
    if (devSession.hasToken()) {
      // A DEV operator token is static configuration, not a rotatable credential.
      return false;
    }
    return refreshNow();
  }

  async function logout(): Promise<LogoutOutcome> {
    const current = record();
    let revoked: LogoutOutcome["revoked"] = "skipped";
    if (current) {
      const outcome = await authClient.logout(current.accessToken);
      revoked = outcome.ok ? "ok" : "failed";
    }
    // Unconditional: a server that cannot be reached, or a token that is already gone, must not
    // leave a usable session on this device.
    clearLocal("已退出登录。");
    return { localCleared: true, revoked };
  }

  publish();

  return {
    credential: {
      getAccessToken,
      handleAuthRejected,
      clear: () => clearLocal("")
    },
    httpBaseUrl: authClient.httpBaseUrl,
    getState: computeState,
    subscribe: store.subscribe,
    loginWithWeChat,
    needsRefresh,
    refreshNow,
    handleAuthRejected,
    logout,
    getAccessToken,
    hasCredential: () => getAccessToken() !== null,
    dispose() {
      loginInFlight = null;
      refreshInFlight = null;
    }
  };
}

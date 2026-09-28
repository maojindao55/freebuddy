/**
 * Persistence for the WeChat-issued administrator session (M4).
 *
 * This is the *only* place a server-issued credential is written, and it keeps exactly what the
 * Relay's own response declares: an opaque access token, an opaque refresh token and their
 * absolute expiries. It never stores a `session_key`, a login `code`, an OpenID or anything
 * derived from the WeChat account — the client is never told those, and the AppSecret lives only
 * in the Relay.
 *
 * Two properties matter more than convenience here:
 *
 * - **Validation reuses the frozen binding.** Token grammar and expiry shapes are checked with
 *   `parseHttpBody` rather than a copy of the regexp, so a protocol change cannot leave this
 *   store accepting a value the wire contract would reject. A malformed or drifted record is
 *   dropped, never repaired: a hostile storage value must not become a session this client
 *   believes in.
 * - **Rotation is all-or-nothing.** `write` replaces the whole record in a single platform call
 *   and reports whether it was persisted. It reports failure instead of throwing because the
 *   caller must know: after a successful refresh the server has already invalidated the old
 *   refresh token, so a lost write means the session can never be refreshed again and the only
 *   correct reaction is to sign out.
 *
 * WeChat storage is not a hardware keystore; the real protections are the short access TTL and
 * server-side revocation. The size of what is kept here is deliberately minimal for the same
 * reason.
 */

import { parseHttpBody, type WeChatAuthResponse } from "../protocol/index";

/** Storage slot. Versioned so a future shape change is a new key, not a silent reinterpretation. */
export const AUTH_SESSION_STORAGE_KEY = "freebuddy.remote.authSession.v1";

export interface AuthSessionRecord {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Absolute client-clock milliseconds; derived from `expiresIn` at receipt. */
  readonly accessExpiresAtMs: number;
  readonly refreshExpiresAtMs: number;
}

export interface AuthTokenStore {
  /** `null` when nothing was written or the stored value is unusable. */
  read(): AuthSessionRecord | null;
  /** Persists the whole record atomically. Returns false when the platform refused. */
  write(record: AuthSessionRecord): boolean;
  clear(): void;
}

/**
 * Opaque-token grammar, taken from the generated binding (`OpaqueToken`, 32..512 chars of
 * `[A-Za-z0-9._~-]`) instead of being restated here. `RefreshRequest` is the smallest body in the
 * contract that carries exactly one opaque token.
 */
export function isOpaqueToken(value: unknown): value is string {
  return typeof value === "string" && parseHttpBody("RefreshRequest", { refreshToken: value }).ok;
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Keeps only a fully valid record. Anything partial — one missing token, a non-integer expiry, a
 * refresh that expires before the access token — is discarded as a whole.
 */
export function sanitizeAuthSession(value: unknown): AuthSessionRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isOpaqueToken(record.accessToken) || !isOpaqueToken(record.refreshToken)) {
    return null;
  }
  if (!isEpochMs(record.accessExpiresAtMs) || !isEpochMs(record.refreshExpiresAtMs)) {
    return null;
  }
  if (record.refreshExpiresAtMs < record.accessExpiresAtMs) {
    return null;
  }
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    accessExpiresAtMs: record.accessExpiresAtMs,
    refreshExpiresAtMs: record.refreshExpiresAtMs
  };
}

/** Absolute expiry for a relative `expiresIn`/`refreshExpiresIn`, relative to the client clock. */
export function recordFromAuthResponse(
  response: WeChatAuthResponse,
  nowMs: number
): AuthSessionRecord {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    accessExpiresAtMs: nowMs + response.expiresIn * 1_000,
    refreshExpiresAtMs: nowMs + response.refreshExpiresIn * 1_000
  };
}

/** Storage subset the store needs; tests inject a fake `WechatApi` (same seam as cursors). */
export interface AuthTokenStorageApi {
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
}

export function createWechatAuthTokenStore(
  api: AuthTokenStorageApi,
  key: string = AUTH_SESSION_STORAGE_KEY
): AuthTokenStore {
  return {
    read() {
      try {
        const raw = api.getStorageSync(key);
        return raw === null || raw === undefined || raw === "" ? null : sanitizeAuthSession(raw);
      } catch {
        // An unreadable record is simply no session; the operator can log in again.
        return null;
      }
    },

    write(record) {
      const sanitized = sanitizeAuthSession(record);
      if (sanitized === null) {
        return false;
      }
      try {
        api.setStorageSync(key, sanitized);
        return true;
      } catch {
        return false;
      }
    },

    clear() {
      try {
        api.removeStorageSync(key);
      } catch {
        // Best effort: a session that could not be removed can still be overwritten by the next
        // login, and the server-side token remains revocable.
      }
    }
  };
}

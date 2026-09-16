/**
 * Administrator credential sources for this read-only substage.
 *
 * Two sources are conceivable; only one exists today.
 *
 * 1. `wechat_code`: `wx.login` code → Relay `/v1/auth/wechat` → server compares `ADMIN_OPENID`.
 *    **Unavailable.** The Relay ships no such HTTP route, so there is nothing to call. This
 *    client therefore never calls `wx.login`, never exchanges a code and never stores a
 *    server-issued token — inventing the exchange locally would fake an identity the server
 *    never vouched for.
 *
 * 2. `dev_operator_token`: a token the operator already possesses from the Relay's own DEV
 *    configuration, sent verbatim in the existing `admin.auth` frame. It proves nothing about
 *    WeChat identity; the client labels it as what it is.
 *
 * The token is held **in memory for the process lifetime only**. There is no `tokenStore` write
 * yet precisely because the only available credential is a local DEV one: persisting it would
 * put relay-admin material in WeChat storage. Production previously must obtain tokens from
 * `/v1/auth/wechat`, which does not exist yet.
 */

import type { MiniProgramEnvVersion } from "../platform/wechatApi";
import { evaluateDevAccess, WECHAT_AUTH_LIMITATION } from "../config/devAccess";
import type { EnvironmentName } from "../config/environments";
import { maskSecret } from "../utils/view";

export type CredentialSource = "wechat_code" | "dev_operator_token";

export interface SetTokenResult {
  readonly accepted: boolean;
  /** The number of characters accepted; never reflects content. Zero when rejected. */
  readonly length: number;
  readonly reason?: string;
}

export interface OperatorTokenSession {
  /** Validates and stores the token in memory. Returns nothing that echoes the value. */
  setToken(raw: string | null | undefined): SetTokenResult;
  readToken(): string | null;
  hasToken(): boolean;
  clear(): void;
  /** True while a token is present but never yet used, purely for UI hints. */
  readonly storageWrites: number;
}

const MAX_TOKEN_CHARS = 512;

/**
 * Deliberately weak: the client does not adjudicate token format (the Relay is authoritative,
 * and duplicating its regex here would drift from `protocol/remote/v1`). It only rejects values
 * that clearly cannot be a opaque-token field: empty, whitespace-bearing or oversized.
 */
export function isPlausibleToken(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length === 0 || value.length > MAX_TOKEN_CHARS) {
    return false;
  }
  return !/\s/.test(value);
}

export function createOperatorTokenSession(): OperatorTokenSession {
  let token: string | null = null;

  return {
    storageWrites: 0,

    setToken(raw) {
      if (typeof raw !== "string" || raw.length === 0) {
        token = null;
        return { accepted: false, length: 0, reason: "令牌为空" };
      }
      if (!isPlausibleToken(raw)) {
        token = null;
        return { accepted: false, length: 0, reason: "令牌含有空白字符或长度超限（≤512）" };
      }
      token = raw;
      return { accepted: true, length: raw.length };
    },

    readToken() {
      return token;
    },

    hasToken() {
      return token !== null;
    },

    clear() {
      token = null;
    }
  };
}

let session: OperatorTokenSession | null = null;

export function getOperatorTokenSession(): OperatorTokenSession {
  if (!session) {
    session = createOperatorTokenSession();
  }
  return session;
}

export function resetOperatorTokenSession(): void {
  session = null;
}

export interface CredentialSourceView {
  readonly source: CredentialSource;
  readonly title: string;
  readonly detail: string;
  readonly available: boolean;
  readonly actionLabel: string;
  readonly actionEnabled: boolean;
}

export interface CredentialAvailabilityInput {
  readonly envName: EnvironmentName;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly envVersion: MiniProgramEnvVersion;
  readonly devArmed: boolean;
  readonly hasToken: boolean;
}

const WECHAT_VIEW: CredentialSourceView = {
  source: "wechat_code",
  title: "微信管理员登录",
  detail: WECHAT_AUTH_LIMITATION,
  available: false,
  actionLabel: "尚未开放",
  actionEnabled: false
};

export function describeCredentialSources(input: CredentialAvailabilityInput): readonly CredentialSourceView[] {
  const availability = evaluateDevAccess({
    envName: input.envName,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    envVersion: input.envVersion,
    armed: input.devArmed
  });

  const devView: CredentialSourceView = availability.allowed
    ? {
        source: "dev_operator_token",
        title: "本地 DEV 操作令牌",
        detail:
          "仅在 local 环境 literal loopback 下使用 Relay DEV 令牌连接。该令牌不是微信身份，" +
          "不代表真实管理员登录。",
        available: true,
        actionLabel: input.hasToken ? `已就绪 ${maskSecret()}` : "连接本机 Relay",
        actionEnabled: true
      }
    : {
        source: "dev_operator_token",
        title: "本地 DEV 操作令牌",
        detail: availability.message,
        available: false,
        actionLabel: "不可用",
        actionEnabled: false
      };

  return [WECHAT_VIEW, devView];
}

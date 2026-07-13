import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

export type CodexUsageWindow = {
  usedPercent: number;
  leftPercent: number;
  windowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
};

export type CodexResetCredit = {
  status: string;
  expiresAt?: number;
};

export type CodexResetCredits = {
  availableCount: number;
  totalCount: number;
  nextExpiresAt?: number;
  credits: CodexResetCredit[];
};

export type CodexUsageResult =
  | {
      ok: true;
      allowed: boolean;
      limitReached: boolean;
      planType?: string;
      windows: CodexUsageWindow[];
      resetCredits?: CodexResetCredits;
      fetchedAt: string;
    }
  | {
      ok: false;
      reason:
        | "missing_auth"
        | "invalid_auth"
        | "expired_token"
        | "request_failed"
        | "invalid_response";
      error?: string;
      fetchedAt: string;
    };

type FetchLike = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export async function readCodexUsage(options: {
  authPath?: string;
  fetchImpl?: FetchLike;
  nowMs?: number;
} = {}): Promise<CodexUsageResult> {
  const fetchedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const authPath = options.authPath ?? defaultAuthPath();
  const auth = await readCodexAuth(authPath, fetchedAt);
  if (!auth.ok) return auth;

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (auth.expiresAt != null && auth.expiresAt <= nowSeconds) {
    return { ok: false, reason: "expired_token", fetchedAt };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const headers = {
      accept: "*/*",
      authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      "user-agent": "freebuddy/codex-usage"
    };
    const response = await fetchImpl(USAGE_URL, {
      method: "GET",
      headers
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: "request_failed",
        error: `HTTP ${response.status}`,
        fetchedAt
      };
    }
    const result = normalizeUsageResponse(await response.json(), fetchedAt);
    if (!result.ok) return result;

    const resetCredits = await fetchResetCredits(fetchImpl, headers);
    return resetCredits ? { ...result, resetCredits } : result;
  } catch (error) {
    return {
      ok: false,
      reason: "request_failed",
      error: error instanceof Error ? error.message : String(error),
      fetchedAt
    };
  }
}

async function fetchResetCredits(
  fetchImpl: FetchLike,
  headers: Record<string, string>
): Promise<CodexResetCredits | undefined> {
  try {
    const response = await fetchImpl(RESET_CREDITS_URL, {
      method: "GET",
      headers
    });
    if (!response.ok) return undefined;
    return normalizeResetCreditsResponse(await response.json());
  } catch {
    return undefined;
  }
}

function defaultAuthPath(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

async function readCodexAuth(
  authPath: string,
  fetchedAt: string
): Promise<
  | { ok: true; accessToken: string; accountId: string; expiresAt?: number }
  | Extract<CodexUsageResult, { ok: false }>
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(authPath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      reason: code === "ENOENT" ? "missing_auth" : "invalid_auth",
      error: code === "ENOENT" ? undefined : errorMessage(error),
      fetchedAt
    };
  }

  const tokens = objectValue(parsed, "tokens");
  const accessToken = stringValue(tokens, "access_token");
  if (!accessToken) {
    return { ok: false, reason: "invalid_auth", fetchedAt };
  }

  const claims = decodeJwtPayload(accessToken);
  const accountId =
    stringValue(tokens, "account_id") ??
    stringValue(objectValue(claims, "https://api.openai.com/auth"), "chatgpt_account_id");
  if (!accountId) {
    return { ok: false, reason: "invalid_auth", fetchedAt };
  }

  const exp = numberValue(claims, "exp");
  return {
    ok: true,
    accessToken,
    accountId,
    expiresAt: exp
  };
}

function normalizeUsageResponse(
  payload: unknown,
  fetchedAt: string
): CodexUsageResult {
  const rateLimit = objectValue(payload, "rate_limit");
  const windows = [
    normalizeWindow(objectValue(rateLimit, "primary_window")),
    normalizeWindow(objectValue(rateLimit, "secondary_window"))
  ]
    .filter((window): window is CodexUsageWindow => window != null)
    .sort((lhs, rhs) => lhs.windowSeconds - rhs.windowSeconds);
  if (windows.length === 0) {
    return { ok: false, reason: "invalid_response", fetchedAt };
  }
  return {
    ok: true,
    allowed: booleanValue(rateLimit, "allowed") ?? true,
    limitReached: booleanValue(rateLimit, "limit_reached") ?? false,
    planType: stringValue(payload, "plan_type"),
    windows,
    fetchedAt
  };
}

function normalizeWindow(value: unknown): CodexUsageWindow | undefined {
  const usedPercent = numberValue(value, "used_percent");
  const windowSeconds = numberValue(value, "limit_window_seconds");
  const resetAfterSeconds = numberValue(value, "reset_after_seconds");
  const resetAt = numberValue(value, "reset_at");
  if (
    usedPercent == null ||
    windowSeconds == null ||
    resetAfterSeconds == null ||
    resetAt == null
  ) {
    return undefined;
  }
  const clampedUsed = Math.max(0, Math.min(100, Math.round(usedPercent)));
  return {
    usedPercent: clampedUsed,
    leftPercent: Math.max(0, 100 - clampedUsed),
    windowSeconds,
    resetAfterSeconds,
    resetAt
  };
}

function normalizeResetCreditsResponse(
  payload: unknown
): CodexResetCredits | undefined {
  const rawCredits = Array.isArray(payload)
    ? payload
    : arrayValue(objectValue(payload, "credits"));
  if (!rawCredits) return undefined;

  const credits = rawCredits
    .map(normalizeResetCredit)
    .filter((credit): credit is CodexResetCredit => credit != null)
    .sort(sortResetCredits);
  const availableCount =
    Array.isArray(payload) ? undefined : numberValue(payload, "available_count");
  const availableCredits = credits.filter((credit) => credit.status === "available");
  const nextExpiresAt = availableCredits
    .map((credit) => credit.expiresAt)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)[0];

  return {
    availableCount:
      availableCount == null ? availableCredits.length : Math.max(0, Math.round(availableCount)),
    totalCount: credits.length,
    nextExpiresAt,
    credits
  };
}

function normalizeResetCredit(value: unknown): CodexResetCredit | undefined {
  if (!value || typeof value !== "object") return undefined;
  return {
    status: stringValue(value, "status") ?? "unknown",
    expiresAt: epochSecondsValue(value, "expires_at")
  };
}

function sortResetCredits(lhs: CodexResetCredit, rhs: CodexResetCredit): number {
  if (lhs.expiresAt != null && rhs.expiresAt != null) {
    return lhs.expiresAt - rhs.expiresAt;
  }
  if (lhs.expiresAt != null) return -1;
  if (rhs.expiresAt != null) return 1;
  return lhs.status.localeCompare(rhs.status);
}

function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function objectValue(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  return (source as Record<string, unknown>)[key];
}

function arrayValue(source: unknown): unknown[] | undefined {
  return Array.isArray(source) ? source : undefined;
}

function stringValue(source: unknown, key: string): string | undefined {
  const value = objectValue(source, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(source: unknown, key: string): number | undefined {
  const value = objectValue(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function epochSecondsValue(source: unknown, key: string): number | undefined {
  const value = objectValue(source, key);
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value > 1_000_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === "string" && value.length > 0) {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? Math.floor(millis / 1000) : undefined;
  }
  return undefined;
}

function booleanValue(source: unknown, key: string): boolean | undefined {
  const value = objectValue(source, key);
  return typeof value === "boolean" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

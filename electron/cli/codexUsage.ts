import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export type CodexUsageWindow = {
  usedPercent: number;
  leftPercent: number;
  windowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
};

export type CodexUsageResult =
  | {
      ok: true;
      allowed: boolean;
      limitReached: boolean;
      planType?: string;
      primaryWindow: CodexUsageWindow;
      secondaryWindow?: CodexUsageWindow;
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
    const response = await fetchImpl(USAGE_URL, {
      method: "GET",
      headers: {
        accept: "*/*",
        authorization: `Bearer ${auth.accessToken}`,
        "chatgpt-account-id": auth.accountId,
        "user-agent": "freebuddy/codex-usage"
      }
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: "request_failed",
        error: `HTTP ${response.status}`,
        fetchedAt
      };
    }
    return normalizeUsageResponse(await response.json(), fetchedAt);
  } catch (error) {
    return {
      ok: false,
      reason: "request_failed",
      error: error instanceof Error ? error.message : String(error),
      fetchedAt
    };
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
  const primary = normalizeWindow(objectValue(rateLimit, "primary_window"));
  if (!primary) {
    return { ok: false, reason: "invalid_response", fetchedAt };
  }
  return {
    ok: true,
    allowed: booleanValue(rateLimit, "allowed") ?? true,
    limitReached: booleanValue(rateLimit, "limit_reached") ?? false,
    planType: stringValue(payload, "plan_type"),
    primaryWindow: primary,
    secondaryWindow: normalizeWindow(objectValue(rateLimit, "secondary_window")),
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

function stringValue(source: unknown, key: string): string | undefined {
  const value = objectValue(source, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(source: unknown, key: string): number | undefined {
  const value = objectValue(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(source: unknown, key: string): boolean | undefined {
  const value = objectValue(source, key);
  return typeof value === "boolean" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

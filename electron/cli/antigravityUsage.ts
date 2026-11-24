import { readSystemKeyringSecret } from "./systemKeyring.js";

const DEFAULT_CLOUD_CODE_URL = "https://daily-cloudcode-pa.googleapis.com";
const BUSINESS_CLOUD_CODE_URL = "https://cloudcode-pa.googleapis.com";
const USAGE_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";

export type AntigravityQuotaBucket = {
  bucketId: string;
  displayName: string;
  window: string;
  windowSeconds: number;
  remainingFraction: number;
  usedPercent: number;
  leftPercent: number;
  resetTime?: string;
  resetAt?: number;
  description?: string;
};

export type AntigravityQuotaGroup = {
  displayName: string;
  description?: string;
  buckets: AntigravityQuotaBucket[];
};

export type AntigravityUsageResult =
  | {
      ok: true;
      email?: string;
      planType?: string;
      groups: AntigravityQuotaGroup[];
      fetchedAt: string;
    }
  | {
      ok: false;
      reason:
        | "missing_auth"
        | "invalid_auth"
        | "expired_token"
        | "request_failed"
        | "invalid_response"
        | "unsupported_platform";
      error?: string;
      fetchedAt: string;
    };

type FetchLike = (
  url: string,
  init: {
    method: "POST" | "GET";
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ReadAntigravityUsageOptions {
  keyringReader?: () => Promise<string | null>;
  fetchImpl?: FetchLike;
  nowMs?: number;
  cloudCodeUrl?: string;
}

/**
 * Resolves the Cloud Code Assist quota summary endpoint to match `agy` CLI routing:
 * consumer/default logins query `daily-cloudcode-pa.googleapis.com`, while
 * business/enterprise logins query `cloudcode-pa.googleapis.com`.
 */
export function resolveAntigravityUsageUrl(
  authMethod?: string,
  cloudCodeUrl = process.env.CLOUD_CODE_URL
): string {
  const customBase = cloudCodeUrl?.trim().replace(/\/+$/, "");
  if (customBase && /^https?:\/\//i.test(customBase)) {
    return `${customBase}${USAGE_SUMMARY_PATH}`;
  }
  const normalized = authMethod?.trim().toLowerCase();
  const baseUrl =
    normalized === "business" || normalized === "oauth-business"
      ? BUSINESS_CLOUD_CODE_URL
      : DEFAULT_CLOUD_CODE_URL;
  return `${baseUrl}${USAGE_SUMMARY_PATH}`;
}

export function resolveAntigravityUserAgent(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `antigravity/cli/1.4.6 (aidev_client; os_type=${platform}; arch=${arch})`;
}

export async function readAntigravityUsage(
  options: ReadAntigravityUsageOptions = {}
): Promise<AntigravityUsageResult> {
  const fetchedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const auth = await readAntigravityAuth(options.keyringReader, fetchedAt, options.nowMs);
  if (!auth.ok) return auth;

  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json",
      "user-agent": resolveAntigravityUserAgent()
    };

    const usageUrl = resolveAntigravityUsageUrl(auth.authMethod, options.cloudCodeUrl);
    const response = await fetchImpl(usageUrl, {
      method: "POST",
      headers,
      body: "{}"
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: response.status === 401 ? "expired_token" : "request_failed",
        error: `HTTP ${response.status}`,
        fetchedAt
      };
    }

    const payload = await response.json();
    const result = normalizeAntigravityUsageResponse(payload, auth.email, fetchedAt);
    return result;
  } catch (error) {
    return {
      ok: false,
      reason: "request_failed",
      error: error instanceof Error ? error.message : String(error),
      fetchedAt
    };
  }
}

export type ParsedAntigravityKeyringSecret =
  | {
      ok: true;
      accessToken: string;
      email?: string;
      authMethod?: string;
      expired: boolean;
      expiryMs?: number;
    }
  | {
      ok: false;
      reason: "invalid_auth";
      error: string;
    };

export function parseAntigravityKeyringSecret(
  rawSecret: string,
  nowMs?: number
): ParsedAntigravityKeyringSecret {
  let decodedText = rawSecret.trim();
  const base64Prefix = "go-keyring-base64:";
  if (decodedText.startsWith(base64Prefix)) {
    try {
      decodedText = Buffer.from(decodedText.slice(base64Prefix.length), "base64").toString("utf-8");
    } catch {
      return { ok: false, reason: "invalid_auth", error: "Malformed base64 secret" };
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decodedText);
  } catch {
    return { ok: false, reason: "invalid_auth", error: "Invalid JSON in credentials" };
  }

  let tokenObj = parsed.token;
  if (typeof tokenObj === "string" && tokenObj.startsWith("{")) {
    try {
      tokenObj = JSON.parse(tokenObj);
    } catch {
      // ignore
    }
  }

  if (!tokenObj || typeof tokenObj !== "object") {
    return { ok: false, reason: "invalid_auth", error: "No token object found" };
  }

  const tokenRecord = tokenObj as Record<string, unknown>;
  const accessToken = typeof tokenRecord.access_token === "string" ? tokenRecord.access_token : undefined;
  if (!accessToken) {
    return { ok: false, reason: "invalid_auth", error: "Missing access_token" };
  }

  let expired = false;
  let expiryMs: number | undefined;
  const expiry = tokenRecord.expiry;
  if (typeof expiry === "string" || typeof expiry === "number") {
    const parsedExpiryMs = typeof expiry === "number" ? expiry * 1000 : Date.parse(expiry);
    if (Number.isFinite(parsedExpiryMs)) {
      expiryMs = parsedExpiryMs;
      const currentMs = nowMs ?? Date.now();
      if (parsedExpiryMs <= currentMs) {
        expired = true;
      }
    }
  }

  let email: string | undefined =
    typeof parsed.id_token_email === "string" && parsed.id_token_email.trim()
      ? parsed.id_token_email.trim()
      : undefined;
  const idToken = parsed.id_token;
  if (!email && typeof idToken === "string") {
    const claims = decodeJwtPayload(idToken);
    if (claims && typeof claims === "object" && typeof (claims as Record<string, unknown>).email === "string") {
      email = (claims as Record<string, unknown>).email as string;
    }
  }

  const authMethod =
    typeof parsed.auth_method === "string" && parsed.auth_method.trim()
      ? parsed.auth_method.trim()
      : undefined;

  return {
    ok: true,
    accessToken,
    email,
    authMethod,
    expired,
    expiryMs
  };
}

async function readAntigravityAuth(
  keyringReader: (() => Promise<string | null>) | undefined,
  fetchedAt: string,
  nowMs?: number
): Promise<
  | { ok: true; accessToken: string; email?: string; authMethod?: string }
  | Extract<AntigravityUsageResult, { ok: false }>
> {
  let rawSecret: string | null = null;
  try {
    if (keyringReader) {
      rawSecret = await keyringReader();
    } else {
      rawSecret = await readSystemKeyringSecret("gemini", "antigravity");
    }
  } catch (error) {
    const errStr = String(error);
    if (errStr.includes("not found") || errStr.includes("SecKeychainItemCopyAttributesAndData")) {
      return { ok: false, reason: "missing_auth", fetchedAt };
    }
    return {
      ok: false,
      reason: "missing_auth",
      error: error instanceof Error ? error.message : String(error),
      fetchedAt
    };
  }

  if (!rawSecret) {
    return { ok: false, reason: "missing_auth", fetchedAt };
  }

  const parsed = parseAntigravityKeyringSecret(rawSecret, nowMs);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, error: parsed.error, fetchedAt };
  }
  if (parsed.expired) {
    return { ok: false, reason: "expired_token", error: "Access token is expired", fetchedAt };
  }

  return {
    ok: true,
    accessToken: parsed.accessToken,
    email: parsed.email,
    authMethod: parsed.authMethod
  };
}

function normalizeAntigravityUsageResponse(
  payload: unknown,
  email: string | undefined,
  fetchedAt: string
): AntigravityUsageResult {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "invalid_response", error: "Response is not an object", fetchedAt };
  }

  const rawGroups = (payload as Record<string, unknown>).groups;
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
    return { ok: false, reason: "invalid_response", error: "Missing or empty groups array", fetchedAt };
  }

  const groups: AntigravityQuotaGroup[] = [];

  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const g = rawGroup as Record<string, unknown>;
    const displayName = typeof g.displayName === "string" ? g.displayName : "Models";
    const description = typeof g.description === "string" ? g.description : undefined;
    const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];

    const buckets: AntigravityQuotaBucket[] = [];
    for (const rawBucket of rawBuckets) {
      if (!rawBucket || typeof rawBucket !== "object") continue;
      const b = rawBucket as Record<string, unknown>;
      const bucketId = typeof b.bucketId === "string" ? b.bucketId : "";
      const bDisplayName = typeof b.displayName === "string" ? b.displayName : bucketId;
      const windowStr = typeof b.window === "string" ? b.window : "window";
      const disabled = b.disabled === true;
      const remainingFraction =
        typeof b.remainingFraction === "number" && Number.isFinite(b.remainingFraction)
          ? Math.max(0, Math.min(1, b.remainingFraction))
          : disabled
            ? 0
            : 1;

      // Preserve two decimal places like `agy /usage` so values such as 99.59% do not round to 100%.
      const leftPercent = Math.round(remainingFraction * 10_000) / 100;
      const usedPercent = Math.max(0, Math.round((100 - leftPercent) * 100) / 100);

      let windowSeconds = 18_000; // default 5 hours
      if (windowStr.includes("week")) {
        windowSeconds = 604_800;
      } else if (windowStr.includes("day") || windowStr === "24h") {
        windowSeconds = 86_400;
      } else if (windowStr === "5h") {
        windowSeconds = 18_000;
      }

      const resetTime = typeof b.resetTime === "string" ? b.resetTime : undefined;
      let resetAt: number | undefined;
      if (resetTime) {
        const parsedMs = Date.parse(resetTime);
        if (Number.isFinite(parsedMs)) {
          resetAt = Math.floor(parsedMs / 1000);
        }
      }

      const bucketDescription = typeof b.description === "string" ? b.description : undefined;

      buckets.push({
        bucketId,
        displayName: bDisplayName,
        window: windowStr,
        windowSeconds,
        remainingFraction,
        usedPercent,
        leftPercent,
        resetTime,
        resetAt,
        description: bucketDescription
      });
    }

    // Sort buckets within group: 5h window first, then weekly window
    buckets.sort((a, b) => a.windowSeconds - b.windowSeconds);

    if (buckets.length > 0) {
      groups.push({
        displayName,
        description,
        buckets
      });
    }
  }

  // Ensure Gemini Models group always displays first
  groups.sort((a, b) => {
    if (a.displayName === "Gemini Models") return -1;
    if (b.displayName === "Gemini Models") return 1;
    return 0;
  });

  if (groups.length === 0) {
    return { ok: false, reason: "invalid_response", error: "No valid quota buckets parsed", fetchedAt };
  }

  return {
    ok: true,
    email,
    groups,
    fetchedAt
  };
}

function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
}

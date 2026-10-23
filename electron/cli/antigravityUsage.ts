import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveWindowsPowerShell } from "./windowsEnv.js";

const execFileAsync = promisify(execFile);

const USAGE_SUMMARY_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

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

    const response = await fetchImpl(USAGE_SUMMARY_URL, {
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

async function readAntigravityAuth(
  keyringReader: (() => Promise<string | null>) | undefined,
  fetchedAt: string,
  nowMs?: number
): Promise<
  | { ok: true; accessToken: string; email?: string }
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

  let decodedText = rawSecret.trim();
  const base64Prefix = "go-keyring-base64:";
  if (decodedText.startsWith(base64Prefix)) {
    try {
      decodedText = Buffer.from(decodedText.slice(base64Prefix.length), "base64").toString("utf-8");
    } catch {
      return { ok: false, reason: "invalid_auth", error: "Malformed base64 secret", fetchedAt };
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decodedText);
  } catch {
    return { ok: false, reason: "invalid_auth", error: "Invalid JSON in credentials", fetchedAt };
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
    return { ok: false, reason: "invalid_auth", error: "No token object found", fetchedAt };
  }

  const tokenRecord = tokenObj as Record<string, unknown>;
  const accessToken = typeof tokenRecord.access_token === "string" ? tokenRecord.access_token : undefined;
  if (!accessToken) {
    return { ok: false, reason: "invalid_auth", error: "Missing access_token", fetchedAt };
  }

  const expiry = tokenRecord.expiry;
  if (typeof expiry === "string" || typeof expiry === "number") {
    const expiryMs = typeof expiry === "number" ? expiry * 1000 : Date.parse(expiry);
    const currentMs = nowMs ?? Date.now();
    if (Number.isFinite(expiryMs) && expiryMs <= currentMs) {
      return { ok: false, reason: "expired_token", error: "Access token is expired", fetchedAt };
    }
  }

  let email: string | undefined;
  const idToken = parsed.id_token;
  if (typeof idToken === "string") {
    const claims = decodeJwtPayload(idToken);
    if (claims && typeof claims === "object" && typeof (claims as Record<string, unknown>).email === "string") {
      email = (claims as Record<string, unknown>).email as string;
    }
  }

  return {
    ok: true,
    accessToken,
    email
  };
}

async function readSystemKeyringSecret(service: string, account: string): Promise<string | null> {
  const platform = process.platform;
  if (platform === "darwin") {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w"
    ]);
    return stdout;
  }

  if (platform === "linux") {
    const { stdout } = await execFileAsync("secret-tool", [
      "lookup",
      "service",
      service,
      "account",
      account
    ]);
    return stdout;
  }

  if (platform === "win32") {
    // On Windows, zalando/go-keyring uses Windows Credential Manager under the target name `<service>:<account>`
    // using Win32 CredReadW (generic credentials). We invoke CredReadW via PowerShell P/Invoke.
    const target = `${service}:${account}`;
    const psScript = `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCredReader {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    public static string ReadGeneric(string target) {
        IntPtr credPtr = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out credPtr) || credPtr == IntPtr.Zero) {
            return null;
        }
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
            if (cred.CredentialBlobSize == 0 || cred.CredentialBlob == IntPtr.Zero) {
                return string.Empty;
            }
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
            if (bytes.Length >= 2 && bytes[1] == 0 && (bytes.Length < 4 || bytes[3] == 0)) {
                return Encoding.Unicode.GetString(bytes);
            }
            return Encoding.UTF8.GetString(bytes);
        } finally {
            CredFree(credPtr);
        }
    }
}
'@;
Add-Type -TypeDefinition $code;
$secret = [WinCredReader]::ReadGeneric("${target}");
if ($null -eq $secret -and "${service}") {
    $secret = [WinCredReader]::ReadGeneric("${service}");
}
if ($null -ne $secret) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
    [Console]::Out.Write($secret);
} else {
    exit 1;
}
`;
    const encodedCommand = Buffer.from(psScript, "utf16le").toString("base64");
    const pwshPath = resolveWindowsPowerShell(process.env);
    const { stdout } = await execFileAsync(pwshPath, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedCommand
    ]);
    return stdout;
  }

  throw new Error(`Unsupported keyring platform: ${platform}`);
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
      const remainingFraction =
        typeof b.remainingFraction === "number" && Number.isFinite(b.remainingFraction)
          ? Math.max(0, Math.min(1, b.remainingFraction))
          : 1;

      const leftPercent = Math.round(remainingFraction * 100);
      const usedPercent = Math.max(0, 100 - leftPercent);

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

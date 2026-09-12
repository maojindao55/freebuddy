import { FREEBIE_PAGE_URL } from "@/config/freebie";

const DEVICE_ID_STORAGE_KEY = "freebuddy:client_device_id";
const CLIENT_AUTH_SECRET = "fb_sec_v1_8f9c2d1b4e6a0375";

export function getOrCreateDeviceId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && /^[0-9a-fA-F-]{36}$/.test(existing)) {
      return existing;
    }
    const newId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `fb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    globalThis.localStorage?.setItem(DEVICE_ID_STORAGE_KEY, newId);
    return newId;
  } catch {
    return "fb-anon-device";
  }
}

async function computeHmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createAuthHeaders(method: string, path: string): Promise<Record<string, string>> {
  const deviceId = getOrCreateDeviceId();
  const timestamp = Date.now().toString();
  const payload = `${method.toUpperCase()}:${path}:${deviceId}:${timestamp}`;
  const signature = await computeHmacSha256(CLIENT_AUTH_SECRET, payload);

  return {
    "Content-Type": "application/json",
    "X-FreeBuddy-Device-Id": deviceId,
    "X-FreeBuddy-Timestamp": timestamp,
    "X-FreeBuddy-Signature": signature
  };
}

export interface SubmitReviewInput {
  providerId: string;
  rating: number;
  content: string;
  author?: string;
}

export async function submitCommunityReview(
  input: SubmitReviewInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const targetUrl = new URL("/api/reviews", FREEBIE_PAGE_URL).toString();
    const headers = await createAuthHeaders("POST", "/api/reviews");
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      return { ok: false, error: data?.message || data?.error || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SubmitVoteInput {
  providerId: string;
  vote: "working" | "failed";
}

export async function submitCommunityVote(
  input: SubmitVoteInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const targetUrl = new URL("/api/votes", FREEBIE_PAGE_URL).toString();
    const headers = await createAuthHeaders("POST", "/api/votes");
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      return { ok: false, error: data?.message || data?.error || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

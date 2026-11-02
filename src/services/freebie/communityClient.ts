import { FREEBIE_PAGE_URL } from "@/config/freebie";

const DEVICE_ID_STORAGE_KEY = "freebuddy:client_device_id";

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

function createAuthHeaders(): Record<string, string> {
  const deviceId = getOrCreateDeviceId();
  return {
    "Content-Type": "application/json",
    "X-FreeBuddy-Device-Id": deviceId
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
    const headers = createAuthHeaders();
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      if (response.status === 401) {
        return {
          ok: false,
          error: data?.message
            ? `${data.message} (HTTP 401: backend update in progress, please retry shortly)`
            : "HTTP 401: client authentication failed; server may be updating"
        };
      }
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
    const headers = createAuthHeaders();
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      if (response.status === 401) {
        return {
          ok: false,
          error: data?.message
            ? `${data.message} (HTTP 401: backend update in progress, please retry shortly)`
            : "HTTP 401: client authentication failed; server may be updating"
        };
      }
      return { ok: false, error: data?.message || data?.error || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

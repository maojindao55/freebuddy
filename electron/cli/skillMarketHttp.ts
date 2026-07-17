import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { MAX_SKILL_ARCHIVE_BYTES } from "./skillArchive.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1;
/** Search/list/detail JSON payloads — keep well below ZIP limits. */
export const MAX_MARKET_JSON_BYTES = 2 * 1024 * 1024;
/** Error / handoff descriptor bodies. */
export const MAX_MARKET_ERROR_BYTES = 64 * 1024;

export class SkillMarketHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "SkillMarketHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new Error("Skill market request was aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Skill market request was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60_000);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  return undefined;
}

function assertAllowedUrl(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== "https:") {
    throw new Error(`Blocked non-HTTPS market URL: ${url.origin}`);
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new Error(`Blocked market host: ${host}`);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.message === "This operation was aborted" ||
        /was aborted|timed out/i.test(error.message))) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel?.().catch(() => undefined);
}

/** Keep one AbortController alive across headers and body consumption. */
export async function withMarketRequestTimeout<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new Error(`Skill market request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream a response body with a hard byte cap. Prefers Content-Length rejection
 * before allocating, then enforces the limit while reading.
 */
export async function readMarketResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelResponseBody(response);
    throw new Error(`Market response exceeds the ${maxBytes} byte limit`);
  }
  if (signal?.aborted) {
    cancelResponseBody(response);
    throw new Error("Skill market request was aborted");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Skill market request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Market response exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readMarketResponseJson<T>(
  response: Response,
  maxBytes: number = MAX_MARKET_JSON_BYTES,
  signal?: AbortSignal
): Promise<T> {
  const text = await readMarketResponseText(response, maxBytes, signal);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Market returned invalid JSON");
  }
}

async function fetchOnce(
  url: URL,
  init: RequestInit | undefined,
  signal: AbortSignal
): Promise<Response> {
  return await fetch(url, {
    ...init,
    redirect: "manual",
    signal,
    headers: {
      Accept: "application/json, application/zip, */*",
      "User-Agent": "FreeBuddy-SkillMarket/1.0",
      ...(init?.headers ?? {})
    }
  });
}

async function followRedirects(
  startUrl: URL,
  allowedHosts: ReadonlySet<string>,
  init: RequestInit | undefined,
  signal: AbortSignal,
  maxRedirects = 5
): Promise<{ response: Response; finalUrl: URL }> {
  let current = startUrl;
  for (let i = 0; i <= maxRedirects; i += 1) {
    if (signal.aborted) {
      throw new Error("Skill market request was aborted");
    }
    assertAllowedUrl(current, allowedHosts);
    const response = await fetchOnce(current, init, signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new SkillMarketHttpError("Redirect missing Location header", response.status);
      }
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("Too many redirects while contacting the skill market");
}

export async function marketFetch(
  urlString: string,
  allowedHosts: ReadonlySet<string>,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<{ response: Response; finalUrl: URL }> {
  const startUrl = new URL(urlString);
  assertAllowedUrl(startUrl, allowedHosts);

  const run = async (activeSignal: AbortSignal) => {
    let attempt = 0;
    while (true) {
      try {
        const result = await followRedirects(
          startUrl,
          allowedHosts,
          init,
          activeSignal
        );
        if (result.response.status === 429 && attempt < MAX_RETRIES) {
          cancelResponseBody(result.response);
          const wait =
            parseRetryAfterMs(result.response.headers.get("retry-after")) ?? 1_000;
          await sleep(wait, activeSignal);
          attempt += 1;
          continue;
        }
        return result;
      } catch (error) {
        if (
          attempt < MAX_RETRIES &&
          error instanceof Error &&
          (isAbortError(error) ||
            error.name === "AbortError" ||
            /fetch failed|network/i.test(error.message)) &&
          !activeSignal.aborted
        ) {
          await sleep(400, activeSignal);
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  };

  if (signal) {
    return run(signal);
  }
  // Header-only callers: still bound the redirect fetch. Prefer marketFetchJson /
  // marketDownloadToFile so body reads share the same timeout signal.
  return withMarketRequestTimeout(timeoutMs, run);
}

export async function marketFetchJson<T>(
  urlString: string,
  allowedHosts: ReadonlySet<string>,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  return withMarketRequestTimeout(timeoutMs, async (signal) => {
    const { response } = await marketFetch(
      urlString,
      allowedHosts,
      init,
      timeoutMs,
      signal
    );
    const text = await readMarketResponseText(
      response,
      MAX_MARKET_JSON_BYTES,
      signal
    );
    if (!response.ok) {
      throw new SkillMarketHttpError(
        text.trim() || `Market request failed (${response.status})`,
        response.status,
        parseRetryAfterMs(response.headers.get("retry-after"))
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Market returned invalid JSON");
    }
  });
}

async function writeResponseBodyToFile(
  response: Response,
  destination: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<number> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Skill package exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
  }
  if (!response.body) {
    throw new Error("Market download returned an empty body");
  }
  if (signal?.aborted) {
    throw new Error("Skill market download timed out");
  }

  let received = 0;
  const source = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream
  );
  const sink = fs.createWriteStream(destination);
  const onAbort = () => {
    const error = new Error("Skill market download timed out");
    source.destroy(error);
    sink.destroy(error);
    void response.body?.cancel?.().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  source.on("data", (chunk: Buffer | Uint8Array | string) => {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBytes) {
      source.destroy(
        new Error(
          `Skill package exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`
        )
      );
    }
  });
  try {
    await pipeline(source, sink);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return received;
}

export async function marketDownloadToFile(
  urlString: string,
  destination: string,
  allowedHosts: ReadonlySet<string>,
  maxBytes = MAX_SKILL_ARCHIVE_BYTES,
  timeoutMs = 60_000,
  signal?: AbortSignal
): Promise<{ bytes: number; contentType: string | null; finalUrl: string }> {
  const run = async (activeSignal: AbortSignal) => {
    const { response, finalUrl } = await marketFetch(
      urlString,
      allowedHosts,
      undefined,
      timeoutMs,
      activeSignal
    );
    if (!response.ok) {
      const text = await readMarketResponseText(
        response,
        MAX_MARKET_ERROR_BYTES,
        activeSignal
      ).catch(() => "");
      throw new SkillMarketHttpError(
        text.trim() || `Download failed (${response.status})`,
        response.status,
        parseRetryAfterMs(response.headers.get("retry-after"))
      );
    }
    const bytes = await writeResponseBodyToFile(
      response,
      destination,
      maxBytes,
      activeSignal
    );
    return {
      bytes,
      contentType: response.headers.get("content-type"),
      finalUrl: finalUrl.toString()
    };
  };

  if (signal) {
    return run(signal);
  }
  return withMarketRequestTimeout(timeoutMs, run);
}

export async function marketWriteResponseToFile(
  response: Response,
  destination: string,
  maxBytes = MAX_SKILL_ARCHIVE_BYTES,
  signal?: AbortSignal
): Promise<number> {
  return writeResponseBodyToFile(response, destination, maxBytes, signal);
}

import { SpeechError, type SpeechProviderKind } from "../../shared/speechTypes.js";
import type { ResolvedSpeechRuntimeConfig } from "../storage.js";

export type FetchLike = typeof fetch;

export interface AdapterTranscribeInput {
  config: ResolvedSpeechRuntimeConfig;
  audio: Uint8Array;
  mimeType: string;
  language?: string;
  signal: AbortSignal;
  fetchImpl: FetchLike;
}

export interface AdapterTranscribeOutput {
  text: string;
  durationMs?: number;
}

export interface AdapterSynthesizeInput {
  config: ResolvedSpeechRuntimeConfig;
  text: string;
  voice?: string;
  model?: string;
  stripMarkdown?: boolean;
  signal: AbortSignal;
  fetchImpl: FetchLike;
}

export interface AdapterSynthesizeOutput {
  audio: Uint8Array;
  mimeType: string;
}

export interface SpeechAdapter {
  readonly kind: SpeechProviderKind;
  transcribe(input: AdapterTranscribeInput): Promise<AdapterTranscribeOutput>;
  synthesize(input: AdapterSynthesizeInput): Promise<AdapterSynthesizeOutput>;
}

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-(?:sp-)?[A-Za-z0-9_-]{6,}/g, "sk-[REDACTED]");
}

function extractReadableError(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      msg?: unknown;
      detail?: unknown;
      error?: { message?: unknown; code?: unknown } | string;
      header?: { message?: unknown };
    };
    const candidate =
      (typeof parsed?.error === "string"
        ? parsed.error
        : parsed?.error?.message) ??
      parsed?.message ??
      parsed?.msg ??
      parsed?.detail ??
      parsed?.header?.message;
    if (typeof candidate === "string" && candidate.trim()) {
      return redactSecrets(candidate.trim()).slice(0, 240);
    }
  } catch {
    // Plain text response body
  }
  return redactSecrets(trimmed).slice(0, 240);
}

export function mapHttpError(
  provider: SpeechProviderKind,
  status: number,
  bodyText: string,
  extraHint?: string | null
): SpeechError {
  const detail = extractReadableError(bodyText);
  const baseMessage = detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
  const fullMessage = extraHint ? `${baseMessage}（${extraHint}）` : baseMessage;

  if (status === 401 || status === 403) {
    return new SpeechError("UNAUTHORIZED", fullMessage, { provider, status, retryable: false });
  }
  if (status === 429) {
    return new SpeechError("RATE_LIMITED", fullMessage, { provider, status, retryable: true });
  }
  if (status === 413) {
    return new SpeechError("AUDIO_TOO_LARGE", fullMessage, { provider, status, retryable: false });
  }
  if (status === 400 || status === 422) {
    return new SpeechError("INVALID_INPUT", fullMessage, { provider, status, retryable: false });
  }
  return new SpeechError("PROVIDER_ERROR", fullMessage, {
    provider,
    status,
    retryable: status >= 500,
  });
}

export function createRequestSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  didCancel: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;

  const onParentAbort = () => {
    cancelled = true;
    controller.abort(parentSignal?.reason ?? new Error("cancelled"));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      cancelled = true;
      controller.abort(parentSignal.reason ?? new Error("cancelled"));
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    didCancel: () => cancelled,
    cleanup: () => {
      clearTimeout(timer);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", onParentAbort);
      }
    },
  };
}

export function normalizeThrownSpeechError(
  provider: SpeechProviderKind,
  err: unknown,
  state: { didTimeout: () => boolean; didCancel: () => boolean }
): SpeechError {
  if (err instanceof SpeechError) return err;
  if (state.didCancel()) {
    return new SpeechError("CANCELLED", "Speech request cancelled", { provider, retryable: false, cause: err });
  }
  if (state.didTimeout() || (err instanceof Error && err.name === "AbortError")) {
    return new SpeechError("TIMEOUT", "语音服务请求超时", { provider, retryable: true, cause: err });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new SpeechError("NETWORK_ERROR", redactSecrets(msg).slice(0, 240) || "网络请求失败", {
    provider,
    retryable: true,
    cause: err,
  });
}

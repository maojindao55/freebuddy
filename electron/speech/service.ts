import crypto from "node:crypto";
import {
  SpeechError,
  type SpeechProviderKind,
  type SpeechSynthesizeRequest,
  type SpeechSynthesizeResult,
  type SpeechTestRequest,
  type SpeechTestResult,
  type SpeechTranscribeRequest,
  type SpeechTranscribeResult,
} from "../shared/speechTypes.js";
import { buildSilentWav, cleanTextForSpeech, inspectPcm16Wav } from "../shared/speechText.js";
import { logMain } from "../debugLog.js";
import {
  getSpeechPreferences,
  recordSpeechProviderHealth,
  resolveSpeechRuntimeConfig,
  type ResolvedSpeechRuntimeConfig,
} from "./storage.js";
import { dashscopeSpeechAdapter } from "./providers/dashscope.js";
import { deepseekSpeechAdapter } from "./providers/deepseek.js";
import {
  createRequestSignal,
  normalizeThrownSpeechError,
  type FetchLike,
  type SpeechAdapter,
} from "./providers/types.js";
import { volcengineSpeechAdapter } from "./providers/volcengine.js";

const DEFAULT_ASR_TIMEOUT_MS = 45_000;
const DEFAULT_TTS_TIMEOUT_MS = 45_000;
const MAX_TTS_CACHE_ENTRIES = 20;
const MAX_TTS_CACHE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TEST_SAMPLE_TEXT = "你好，我是 FreeBuddy 语音助手。";

const ADAPTERS: Record<SpeechProviderKind, SpeechAdapter> = {
  deepseek: deepseekSpeechAdapter,
  dashscope: dashscopeSpeechAdapter,
  volcengine: volcengineSpeechAdapter,
};

interface TtsCacheEntry {
  audio: Uint8Array;
  mimeType: string;
  provider: SpeechProviderKind;
  bytes: number;
}

export interface SpeechService {
  transcribeSpeech(req: SpeechTranscribeRequest): Promise<SpeechTranscribeResult>;
  synthesizeSpeech(req: SpeechSynthesizeRequest): Promise<SpeechSynthesizeResult>;
  testSpeechProvider(req: SpeechTestRequest): Promise<SpeechTestResult>;
  cancelSpeechRequest(requestId: string): boolean;
  clearTtsCache(): void;
}

function hasDraftSecretOverride(req: SpeechTestRequest): boolean {
  const d = req.draft;
  if (!d) return false;
  return Boolean(
    d.apiKey?.trim() ||
      d.clearApiKey ||
      d.volcAccessToken?.trim() ||
      d.clearVolcAccessToken ||
      d.credentialMode !== undefined ||
      d.linkedProviderId !== undefined ||
      d.baseUrl !== undefined ||
      d.dashscopeEndpointPreset !== undefined ||
      d.volcAuthMode !== undefined ||
      d.volcAppId !== undefined ||
      d.volcAsrResourceId !== undefined ||
      d.volcTtsResourceId !== undefined ||
      d.asrModel !== undefined ||
      d.ttsModel !== undefined ||
      d.ttsVoice !== undefined
  );
}

function buildTtsCacheKey(
  config: ResolvedSpeechRuntimeConfig,
  cleanedText: string,
  voiceOverride?: string,
  modelOverride?: string
): string {
  const parts = [
    config.kind,
    config.baseUrl ?? "",
    config.dashscopeEndpointPreset ?? "",
    config.linkedProviderBaseUrl ?? "",
    config.volcTtsResourceId ?? "",
    modelOverride || config.ttsModel || "",
    voiceOverride || config.ttsVoice || "",
    config.ttsFormat || "",
    String(config.ttsSampleRate ?? ""),
    cleanedText,
  ].join("|");
  return crypto.createHash("sha256").update(parts).digest("hex");
}

export function createSpeechService(options?: {
  fetchImpl?: FetchLike;
  asrTimeoutMs?: number;
  ttsTimeoutMs?: number;
}): SpeechService {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const asrTimeoutMs = options?.asrTimeoutMs ?? DEFAULT_ASR_TIMEOUT_MS;
  const ttsTimeoutMs = options?.ttsTimeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;

  const activeRequests = new Map<string, AbortController>();
  const ttsCache = new Map<string, TtsCacheEntry>();
  let ttsCacheBytes = 0;

  function setCacheEntry(key: string, entry: TtsCacheEntry): void {
    if (entry.bytes > MAX_TTS_CACHE_BYTES) return;
    const existing = ttsCache.get(key);
    if (existing) {
      ttsCacheBytes -= existing.bytes;
      ttsCache.delete(key);
    }
    while (
      ttsCache.size >= MAX_TTS_CACHE_ENTRIES ||
      ttsCacheBytes + entry.bytes > MAX_TTS_CACHE_BYTES
    ) {
      const oldestKey = ttsCache.keys().next().value;
      if (!oldestKey) break;
      const oldest = ttsCache.get(oldestKey)!;
      ttsCacheBytes -= oldest.bytes;
      ttsCache.delete(oldestKey);
    }
    ttsCache.set(key, entry);
    ttsCacheBytes += entry.bytes;
  }

  function getCacheEntry(key: string): TtsCacheEntry | undefined {
    const entry = ttsCache.get(key);
    if (!entry) return undefined;
    // Refresh LRU order
    ttsCache.delete(key);
    ttsCache.set(key, entry);
    return entry;
  }

  function registerController(requestId?: string): {
    controller: AbortController;
    unregister: () => void;
  } {
    const controller = new AbortController();
    if (requestId) {
      const prev = activeRequests.get(requestId);
      if (prev) prev.abort(new Error("superseded"));
      activeRequests.set(requestId, controller);
    }
    return {
      controller,
      unregister: () => {
        if (requestId && activeRequests.get(requestId) === controller) {
          activeRequests.delete(requestId);
        }
      },
    };
  }

  async function runTranscribe(
    config: ResolvedSpeechRuntimeConfig,
    audioInput: Uint8Array,
    mimeType: string,
    language: string | undefined,
    requestId?: string
  ): Promise<SpeechTranscribeResult> {
    const audio =
      audioInput instanceof Uint8Array ? audioInput : new Uint8Array(audioInput);
    if (!audio.byteLength) {
      throw new SpeechError("INVALID_INPUT", "未采集到有效音频数据", {
        provider: config.kind,
      });
    }

    const wavStats = inspectPcm16Wav(audio);
    const adapter = ADAPTERS[config.kind];
    const { controller, unregister } = registerController(requestId);
    const sig = createRequestSignal(controller.signal, asrTimeoutMs);
    const started = Date.now();
    try {
      const out = await adapter.transcribe({
        config,
        audio,
        mimeType,
        language,
        signal: sig.signal,
        fetchImpl,
      });
      const latencyMs = Date.now() - started;
      const trimmedText = out.text.trim();
      if (!trimmedText) {
        logMain().warn("speech", "asr returned empty transcript", {
          provider: config.kind,
          mimeType,
          audioBytes: audio.byteLength,
          wavValid: wavStats.valid,
          sampleRate: wavStats.sampleRate,
          channels: wavStats.channels,
          durationMs: wavStats.durationMs,
          peak: Number(wavStats.peak.toFixed(4)),
          rms: Number(wavStats.rms.toFixed(4)),
          latencyMs,
        });
      } else {
        logMain().info("speech", "asr completed", {
          provider: config.kind,
          audioBytes: audio.byteLength,
          durationMs: wavStats.durationMs,
          peak: Number(wavStats.peak.toFixed(4)),
          textLength: trimmedText.length,
          latencyMs,
        });
      }
      return {
        text: trimmedText,
        ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
        provider: config.kind,
        latencyMs,
      };
    } catch (err) {
      const normalized = normalizeThrownSpeechError(config.kind, err, sig);
      logMain().error("speech", "asr failed", {
        provider: config.kind,
        code: normalized.code,
        status: normalized.status,
        audioBytes: audio.byteLength,
        wavValid: wavStats.valid,
        peak: Number(wavStats.peak.toFixed(4)),
        error: normalized.message,
      });
      throw normalized;
    } finally {
      sig.cleanup();
      unregister();
    }
  }

  async function runSynthesize(
    config: ResolvedSpeechRuntimeConfig,
    req: SpeechSynthesizeRequest
  ): Promise<SpeechSynthesizeResult> {
    const prefs = getSpeechPreferences();
    const stripCodeBlocks = req.stripCodeBlocks ?? prefs.ttsStripCodeBlocks;
    const stripMarkdown = req.stripMarkdown ?? prefs.ttsStripMarkdown;
    const cleanedText = cleanTextForSpeech(req.text, {
      stripCodeBlocks,
      stripMarkdown,
    });
    if (!cleanedText) {
      throw new SpeechError("INVALID_INPUT", "没有可用于朗读的文本内容", {
        provider: config.kind,
      });
    }

    const cacheKey = buildTtsCacheKey(config, cleanedText, req.voice, req.model);
    if (!req.skipCache) {
      const cached = getCacheEntry(cacheKey);
      if (cached) {
        return {
          audio: cached.audio,
          mimeType: cached.mimeType,
          provider: cached.provider,
          latencyMs: 0,
          cached: true,
        };
      }
    }

    const adapter = ADAPTERS[config.kind];
    const { controller, unregister } = registerController(req.requestId);
    const sig = createRequestSignal(controller.signal, ttsTimeoutMs);
    const started = Date.now();
    try {
      const out = await adapter.synthesize({
        config,
        text: cleanedText,
        voice: req.voice,
        model: req.model,
        stripMarkdown,
        signal: sig.signal,
        fetchImpl,
      });
      const result: SpeechSynthesizeResult = {
        audio: out.audio,
        mimeType: out.mimeType,
        provider: config.kind,
        latencyMs: Date.now() - started,
        cached: false,
      };
      logMain().info("speech", "tts completed", {
        provider: config.kind,
        audioBytes: out.audio.byteLength,
        mimeType: out.mimeType,
        latencyMs: result.latencyMs,
        cached: false,
      });
      if (!req.skipCache) {
        setCacheEntry(cacheKey, {
          audio: out.audio,
          mimeType: out.mimeType,
          provider: config.kind,
          bytes: out.audio.byteLength,
        });
      }
      return result;
    } catch (err) {
      const normalized = normalizeThrownSpeechError(config.kind, err, sig);
      logMain().error("speech", "tts failed", {
        provider: config.kind,
        code: normalized.code,
        status: normalized.status,
        error: normalized.message,
      });
      throw normalized;
    } finally {
      sig.cleanup();
      unregister();
    }
  }

  return {
    async transcribeSpeech(req) {
      const prefs = getSpeechPreferences();
      const targetKind = req.provider ?? prefs.activeAsrProvider;
      if (!targetKind) {
        throw new SpeechError("NOT_CONFIGURED", "尚未选择默认语音识别 (ASR) 引擎");
      }
      const config = resolveSpeechRuntimeConfig(targetKind);
      return runTranscribe(
        config,
        req.audio,
        req.mimeType || "audio/wav",
        req.language,
        req.requestId
      );
    },

    async synthesizeSpeech(req) {
      const prefs = getSpeechPreferences();
      const targetKind = req.provider ?? prefs.activeTtsProvider;
      if (!targetKind) {
        throw new SpeechError("NOT_CONFIGURED", "尚未选择默认语音合成 (TTS) 引擎");
      }
      const config = resolveSpeechRuntimeConfig(targetKind);
      return runSynthesize(config, req);
    },

    async testSpeechProvider(req) {
      const checkedAt = new Date().toISOString();
      const started = Date.now();
      let config: ResolvedSpeechRuntimeConfig;
      try {
        config = resolveSpeechRuntimeConfig(req.kind, req.draft);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!hasDraftSecretOverride(req)) {
          recordSpeechProviderHealth(req.kind, {
            ok: false,
            latencyMs: Date.now() - started,
            error: message,
          });
        }
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: message,
          checkedAt,
        };
      }

      const details: NonNullable<SpeechTestResult["details"]> = {};
      let previewAudio: Uint8Array | undefined;
      let previewMimeType: string | undefined;

      if (req.target === "tts" || req.target === "both") {
        const ttsStart = Date.now();
        try {
          const ttsRes = await runSynthesize(config, {
            text: req.sampleText?.trim() || DEFAULT_TEST_SAMPLE_TEXT,
            skipCache: true,
            stripCodeBlocks: false,
            stripMarkdown: false,
          });
          previewAudio = ttsRes.audio;
          previewMimeType = ttsRes.mimeType;
          details.tts = { ok: true, latencyMs: Date.now() - ttsStart };
        } catch (err) {
          details.tts = {
            ok: false,
            latencyMs: Date.now() - ttsStart,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      if (req.target === "asr" || req.target === "both") {
        const asrStart = Date.now();
        try {
          const silentWav = buildSilentWav(600, 16000);
          await runTranscribe(config, silentWav, "audio/wav", undefined);
          details.asr = { ok: true, latencyMs: Date.now() - asrStart };
        } catch (err) {
          details.asr = {
            ok: false,
            latencyMs: Date.now() - asrStart,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      const outcomes = [details.tts, details.asr].filter(
        (d): d is NonNullable<typeof d> => Boolean(d)
      );
      const ok = outcomes.length > 0 && outcomes.every((d) => d.ok);
      const error = ok
        ? undefined
        : outcomes
            .filter((d) => !d.ok)
            .map((d) => d.error || "连接失败")
            .join("；");
      const latencyMs = Date.now() - started;

      if (!hasDraftSecretOverride(req)) {
        recordSpeechProviderHealth(req.kind, { ok, latencyMs, error });
      }

      return {
        ok,
        latencyMs,
        ...(error ? { error } : {}),
        checkedAt,
        ...(previewAudio ? { audio: previewAudio, mimeType: previewMimeType } : {}),
        details,
      };
    },

    cancelSpeechRequest(requestId) {
      const controller = activeRequests.get(requestId);
      if (!controller) return false;
      activeRequests.delete(requestId);
      controller.abort(new Error("cancelled"));
      return true;
    },

    clearTtsCache() {
      ttsCache.clear();
      ttsCacheBytes = 0;
    },
  };
}

const defaultService = createSpeechService();

export const transcribeSpeech = defaultService.transcribeSpeech;
export const synthesizeSpeech = defaultService.synthesizeSpeech;
export const testSpeechProvider = defaultService.testSpeechProvider;
export const cancelSpeechRequest = defaultService.cancelSpeechRequest;

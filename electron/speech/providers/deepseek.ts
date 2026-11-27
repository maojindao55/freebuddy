import { SpeechError } from "../../shared/speechTypes.js";
import { mapHttpError, type SpeechAdapter } from "./types.js";

const DEEPSEEK_DEFAULT_ORIGIN = "https://api.deepseek.com";
const DEEPSEEK_MAX_ASR_BYTES = 8 * 1024 * 1024; // 8 MiB
const DEEPSEEK_MAX_TTS_BODY_BYTES = 64 * 1024; // 64 KiB

export function normalizeDeepSeekOrigin(rawBaseUrl?: string): string {
  const clean = (rawBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!clean) return DEEPSEEK_DEFAULT_ORIGIN;
  return clean.replace(/\/v1$/i, "") || DEEPSEEK_DEFAULT_ORIGIN;
}

export const deepseekSpeechAdapter: SpeechAdapter = {
  kind: "deepseek",

  async transcribe({ config, audio, mimeType, signal, fetchImpl }) {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new SpeechError("NOT_CONFIGURED", "缺少 DeepSeek API Key", { provider: "deepseek" });
    }
    if (audio.byteLength > DEEPSEEK_MAX_ASR_BYTES) {
      throw new SpeechError(
        "AUDIO_TOO_LARGE",
        "音频超过 DeepSeek 单次识别限制（最大 8 MiB / 120 秒）",
        { provider: "deepseek" }
      );
    }

    const origin = normalizeDeepSeekOrigin(config.baseUrl ?? config.linkedProviderBaseUrl);
    const isOgg = mimeType.toLowerCase().includes("ogg");
    const filename = isOgg ? "speech.ogg" : "speech.wav";
    const blob = new Blob([Buffer.from(audio)], {
      type: mimeType || (isOgg ? "audio/ogg" : "audio/wav"),
    });
    const formData = new FormData();
    formData.append("file", blob, filename);

    const res = await fetchImpl(`${origin}/v1/tools/asr`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw mapHttpError("deepseek", res.status, bodyText);
    }

    const data = (await res.json()) as {
      text?: unknown;
      duration_ms?: unknown;
      data?: { text?: unknown; duration_ms?: unknown };
      result?: { text?: unknown; duration_ms?: unknown };
    };
    const rawText =
      [data?.text, data?.data?.text, data?.result?.text].find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim().length > 0,
      ) ?? (typeof data?.text === "string" ? data.text : "");
    const rawDuration =
      typeof data?.duration_ms === "number"
        ? data.duration_ms
        : typeof data?.data?.duration_ms === "number"
          ? data.data.duration_ms
          : typeof data?.result?.duration_ms === "number"
            ? data.result.duration_ms
            : undefined;
    return {
      text: rawText.trim(),
      ...(typeof rawDuration === "number" ? { durationMs: rawDuration } : {}),
    };
  },

  async synthesize({ config, text, voice, stripMarkdown, signal, fetchImpl }) {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new SpeechError("NOT_CONFIGURED", "缺少 DeepSeek API Key", { provider: "deepseek" });
    }

    const origin = normalizeDeepSeekOrigin(config.baseUrl ?? config.linkedProviderBaseUrl);
    const format = config.ttsFormat === "pcm" ? "pcm" : "wav";
    const payload = {
      text,
      voice_id: (voice || config.ttsVoice || "stella").trim(),
      format,
      filter_markdown: stripMarkdown !== false,
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > DEEPSEEK_MAX_TTS_BODY_BYTES) {
      throw new SpeechError(
        "TEXT_TOO_LONG",
        "单次文本超过 DeepSeek TTS 请求体上限（64 KiB）",
        { provider: "deepseek" }
      );
    }

    const res = await fetchImpl(`${origin}/v1/tools/tts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: serialized,
      signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw mapHttpError("deepseek", res.status, bodyText);
    }

    const buf = await res.arrayBuffer();
    if (!buf.byteLength) {
      throw new SpeechError("PROVIDER_ERROR", "DeepSeek TTS 未返回有效音频数据", {
        provider: "deepseek",
      });
    }
    const respType = res.headers.get("content-type")?.split(";")[0]?.trim();
    return {
      audio: new Uint8Array(buf),
      mimeType: respType && respType.startsWith("audio/") ? respType : "audio/wav",
    };
  },
};

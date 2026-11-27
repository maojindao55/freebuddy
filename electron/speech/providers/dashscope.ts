import {
  detectDashScopeKeyEndpointMismatch,
  resolveDashScopeOrigin,
} from "../../shared/speechCatalog.js";
import { SpeechError } from "../../shared/speechTypes.js";
import { mapHttpError, type SpeechAdapter } from "./types.js";

const DASHSCOPE_MAX_ASR_BYTES = 10 * 1024 * 1024; // 10 MiB before Base64 expansion

function dashScopeMismatchHint(apiKey: string, origin: string): string | null {
  const mismatch = detectDashScopeKeyEndpointMismatch(apiKey, origin);
  if (mismatch === "token_plan_key_on_payg") {
    return "检测到 sk-sp- 开头的 Token Plan 专用 Key，但当前接入点是按量付费域名，请切换为 Token Plan 接入点";
  }
  if (mismatch === "payg_key_on_token_plan") {
    return "当前接入点为 Token Plan 专用域名，需使用 sk-sp- 开头的 Token Plan 专用 Key";
  }
  return null;
}

function extractDashScopeTranscript(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as {
    output?: {
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: unknown }>;
        };
      }>;
    };
    choices?: Array<{
      message?: {
        content?: string | Array<{ text?: unknown }>;
      };
    }>;
  };
  const content =
    obj.output?.choices?.[0]?.message?.content ??
    obj.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("")
      .trim();
  }
  return "";
}

function inferMimeTypeFromUrl(url: string, fallback: string): string {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".wav")) return "audio/wav";
  if (clean.endsWith(".mp3")) return "audio/mpeg";
  if (clean.endsWith(".opus") || clean.endsWith(".ogg")) return "audio/ogg";
  return fallback;
}

export const dashscopeSpeechAdapter: SpeechAdapter = {
  kind: "dashscope",

  async transcribe({ config, audio, mimeType, signal, fetchImpl }) {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new SpeechError("NOT_CONFIGURED", "缺少阿里云百炼 API Key", {
        provider: "dashscope",
      });
    }
    if (audio.byteLength > DASHSCOPE_MAX_ASR_BYTES) {
      throw new SpeechError(
        "AUDIO_TOO_LARGE",
        "音频超过同步识别建议大小上限（10 MiB）",
        { provider: "dashscope" }
      );
    }

    const origin = resolveDashScopeOrigin({
      preset: config.dashscopeEndpointPreset,
      customBaseUrl: config.baseUrl,
      linkedProviderBaseUrl: config.linkedProviderBaseUrl,
    });
    const model = (config.asrModel || "qwen3-asr-flash").trim();
    const audioMime = mimeType || "audio/wav";
    const dataUri = `data:${audioMime};base64,${Buffer.from(audio).toString("base64")}`;

    const res = await fetchImpl(
      `${origin}/api/v1/services/aigc/multimodal-generation/generation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: {
            messages: [
              { role: "system", content: [{ text: "" }] },
              { role: "user", content: [{ audio: dataUri }] },
            ],
          },
          parameters: {
            asr_options: {
              enable_itn: true,
            },
          },
        }),
        signal,
      }
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const hint =
        res.status === 401 || res.status === 403
          ? dashScopeMismatchHint(apiKey, origin)
          : null;
      throw mapHttpError("dashscope", res.status, bodyText, hint);
    }

    const data = (await res.json()) as {
      code?: unknown;
      message?: unknown;
      output?: unknown;
    };
    if (typeof data?.code === "string" && data.code && !data.output) {
      throw new SpeechError(
        "PROVIDER_ERROR",
        typeof data.message === "string" ? data.message : `百炼识别异常 (${data.code})`,
        { provider: "dashscope" }
      );
    }

    return {
      text: extractDashScopeTranscript(data),
    };
  },

  async synthesize({ config, text, voice, model: modelOverride, signal, fetchImpl }) {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new SpeechError("NOT_CONFIGURED", "缺少阿里云百炼 API Key", {
        provider: "dashscope",
      });
    }

    const origin = resolveDashScopeOrigin({
      preset: config.dashscopeEndpointPreset,
      customBaseUrl: config.baseUrl,
      linkedProviderBaseUrl: config.linkedProviderBaseUrl,
    });
    const model = (modelOverride || config.ttsModel || "qwen3-tts-flash").trim();
    const selectedVoice = (voice || config.ttsVoice || "Cherry").trim();
    const format = config.ttsFormat === "wav" ? "wav" : "mp3";
    const sampleRate = config.ttsSampleRate || 24000;

    // qwen-audio-* series uses SpeechSynthesizer endpoint, while qwen3-tts-* uses multimodal-generation.
    const usesSpeechSynthesizer = /^qwen-audio-/i.test(model);
    const endpoint = usesSpeechSynthesizer
      ? `${origin}/api/v1/services/audio/tts/SpeechSynthesizer`
      : `${origin}/api/v1/services/aigc/multimodal-generation/generation`;

    const payload = usesSpeechSynthesizer
      ? {
          model,
          input: {
            text,
            voice: selectedVoice,
            format,
            sample_rate: sampleRate,
          },
        }
      : {
          model,
          input: {
            text,
            voice: selectedVoice,
          },
        };

    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const hint =
        res.status === 401 || res.status === 403
          ? dashScopeMismatchHint(apiKey, origin)
          : null;
      throw mapHttpError("dashscope", res.status, bodyText, hint);
    }

    const respType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (respType.startsWith("audio/")) {
      const buf = await res.arrayBuffer();
      return { audio: new Uint8Array(buf), mimeType: respType };
    }

    const data = (await res.json()) as {
      code?: unknown;
      message?: unknown;
      output?: {
        audio?: {
          url?: unknown;
          data?: unknown;
        };
      };
    };

    if (typeof data?.code === "string" && data.code && !data.output) {
      throw new SpeechError(
        "PROVIDER_ERROR",
        typeof data.message === "string" ? data.message : `百炼合成异常 (${data.code})`,
        { provider: "dashscope" }
      );
    }

    const inlineBase64 = data?.output?.audio?.data;
    if (typeof inlineBase64 === "string" && inlineBase64.trim()) {
      const bytes = Buffer.from(inlineBase64.trim(), "base64");
      return {
        audio: new Uint8Array(bytes),
        mimeType: format === "wav" ? "audio/wav" : "audio/mpeg",
      };
    }

    const audioUrl = data?.output?.audio?.url;
    if (typeof audioUrl !== "string" || !audioUrl.trim()) {
      throw new SpeechError("PROVIDER_ERROR", "百炼 TTS 响应中未包含音频地址或数据", {
        provider: "dashscope",
      });
    }

    // Download the temporary OSS URL inside main process without forwarding DashScope auth headers.
    const audioRes = await fetchImpl(audioUrl.trim(), { signal });
    if (!audioRes.ok) {
      throw new SpeechError(
        "PROVIDER_ERROR",
        `下载百炼合成音频失败 (HTTP ${audioRes.status})`,
        { provider: "dashscope", status: audioRes.status }
      );
    }
    const audioBuf = await audioRes.arrayBuffer();
    if (!audioBuf.byteLength) {
      throw new SpeechError("PROVIDER_ERROR", "下载到的百炼音频文件为空", {
        provider: "dashscope",
      });
    }

    const downloadedType = audioRes.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const resolvedMime = downloadedType.startsWith("audio/")
      ? downloadedType
      : inferMimeTypeFromUrl(audioUrl, format === "wav" ? "audio/wav" : "audio/mpeg");

    return {
      audio: new Uint8Array(audioBuf),
      mimeType: resolvedMime,
    };
  },
};

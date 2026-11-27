import crypto from "node:crypto";
import { SpeechError } from "../../shared/speechTypes.js";
import type { ResolvedSpeechRuntimeConfig } from "../storage.js";
import { mapHttpError, type SpeechAdapter } from "./types.js";

const VOLC_DEFAULT_ORIGIN = "https://openspeech.bytedance.com";

function buildVolcAuthHeaders(
  config: ResolvedSpeechRuntimeConfig,
  resourceId: string,
  requestId: string
): Record<string, string> {
  if (config.volcAuthMode === "api_key") {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      throw new SpeechError("NOT_CONFIGURED", "缺少火山引擎语音 API Key", {
        provider: "volcengine",
      });
    }
    return {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": requestId,
    };
  }

  const appId = config.volcAppId?.trim();
  const accessToken = config.volcAccessToken?.trim();
  if (!appId || !accessToken) {
    throw new SpeechError(
      "NOT_CONFIGURED",
      "缺少火山引擎智能语音控制台 App ID 或 Access Token",
      { provider: "volcengine" }
    );
  }
  return {
    "X-Api-App-Key": appId,
    "X-Api-Access-Key": accessToken,
    "X-Api-Resource-Id": resourceId,
    "X-Api-Request-Id": requestId,
  };
}

interface VolcTtsChunkJson {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

function consumeNdjsonLine(
  line: string,
  chunks: Buffer[]
): { done: boolean } {
  const trimmed = line.trim();
  if (!trimmed) return { done: false };
  let parsed: VolcTtsChunkJson;
  try {
    parsed = JSON.parse(trimmed) as VolcTtsChunkJson;
  } catch (err) {
    throw new SpeechError("PROVIDER_ERROR", "解析火山引擎 TTS 流式响应失败", {
      provider: "volcengine",
      cause: err,
    });
  }

  if (parsed.code === 20000000) {
    return { done: true };
  }
  if (typeof parsed.code === "number" && parsed.code !== 0) {
    const msg =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : `火山引擎 TTS 错误 (${parsed.code})`;
    const isAuth = parsed.code === 45000010 || /auth|unauthorized|key|token/i.test(msg);
    throw new SpeechError(isAuth ? "UNAUTHORIZED" : "PROVIDER_ERROR", msg, {
      provider: "volcengine",
    });
  }
  if (typeof parsed.data === "string" && parsed.data.length > 0) {
    chunks.push(Buffer.from(parsed.data, "base64"));
  }
  return { done: false };
}

/**
 * Parses Volcengine V3 HTTP unidirectional TTS NDJSON stream into a single audio buffer.
 */
export async function parseVolcTtsNdjsonResponse(res: Response): Promise<Uint8Array> {
  const audioChunks: Buffer[] = [];

  if (!res.body) {
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      const { done } = consumeNdjsonLine(line, audioChunks);
      if (done) break;
    }
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finished = false;

    try {
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          const step = consumeNdjsonLine(line, audioChunks);
          if (step.done) {
            finished = true;
            break;
          }
          newlineIdx = buffer.indexOf("\n");
        }
      }
      if (!finished) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          consumeNdjsonLine(buffer, audioChunks);
        }
      }
    } finally {
      if (finished) {
        await reader.cancel().catch(() => {});
      }
    }
  }

  if (audioChunks.length === 0) {
    throw new SpeechError("PROVIDER_ERROR", "火山引擎 TTS 未返回有效音频数据", {
      provider: "volcengine",
    });
  }
  return new Uint8Array(Buffer.concat(audioChunks));
}

export const volcengineSpeechAdapter: SpeechAdapter = {
  kind: "volcengine",

  async transcribe({ config, audio, signal, fetchImpl }) {
    const origin = (config.baseUrl || VOLC_DEFAULT_ORIGIN).replace(/\/+$/, "");
    const resourceId = (config.volcAsrResourceId || "volc.bigasr.auc_turbo").trim();
    const requestId = crypto.randomUUID();
    const authHeaders = buildVolcAuthHeaders(config, resourceId, requestId);

    const res = await fetchImpl(`${origin}/api/v3/auc/bigmodel/recognize/flash`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "X-Api-Sequence": "-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user: { uid: "freebuddy" },
        audio: { data: Buffer.from(audio).toString("base64") },
        request: {
          model_name: (config.asrModel || "bigmodel").trim(),
        },
      }),
      signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw mapHttpError("volcengine", res.status, bodyText);
    }

    const headerCode = res.headers.get("x-api-status-code");
    const headerMsg = res.headers.get("x-api-message");
    if (headerCode && headerCode !== "20000000") {
      // 20000003 indicates silent audio with no recognized speech on Volcengine ASR.
      if (headerCode === "20000003") {
        return { text: "" };
      }
      throw new SpeechError(
        headerCode === "45000010" ? "UNAUTHORIZED" : "PROVIDER_ERROR",
        headerMsg?.trim() || `火山引擎 ASR 错误 (${headerCode})`,
        { provider: "volcengine" }
      );
    }

    const data = (await res.json()) as {
      code?: unknown;
      message?: unknown;
      result?: { text?: unknown };
      audio_info?: { duration?: unknown };
    };
    if (typeof data?.code === "number" && data.code !== 0 && data.code !== 20000000) {
      if (data.code === 20000003) return { text: "" };
      throw new SpeechError(
        "PROVIDER_ERROR",
        typeof data.message === "string" ? data.message : `火山引擎 ASR 错误 (${data.code})`,
        { provider: "volcengine" }
      );
    }

    return {
      text: typeof data?.result?.text === "string" ? data.result.text.trim() : "",
      ...(typeof data?.audio_info?.duration === "number"
        ? { durationMs: data.audio_info.duration }
        : {}),
    };
  },

  async synthesize({ config, text, voice, signal, fetchImpl }) {
    const origin = (config.baseUrl || VOLC_DEFAULT_ORIGIN).replace(/\/+$/, "");
    const resourceId = (config.volcTtsResourceId || "seed-tts-2.0").trim();
    const requestId = crypto.randomUUID();
    const authHeaders = buildVolcAuthHeaders(config, resourceId, requestId);
    const format = config.ttsFormat === "wav" ? "wav" : "mp3";
    const sampleRate = config.ttsSampleRate || 24000;

    const res = await fetchImpl(`${origin}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user: { uid: "freebuddy" },
        req_params: {
          text,
          speaker: (voice || config.ttsVoice || "zh_female_vv_uranus_bigtts").trim(),
          audio_params: {
            format,
            sample_rate: sampleRate,
          },
        },
      }),
      signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw mapHttpError("volcengine", res.status, bodyText);
    }

    const audio = await parseVolcTtsNdjsonResponse(res);
    return {
      audio,
      mimeType: format === "wav" ? "audio/wav" : "audio/mpeg",
    };
  },
};

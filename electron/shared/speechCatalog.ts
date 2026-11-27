import type {
  DashScopeEndpointPreset,
  SpeechPreferences,
  SpeechProviderConfig,
  SpeechProviderKind,
} from "./speechTypes.js";

export const SPEECH_PROVIDER_KINDS: readonly SpeechProviderKind[] = [
  "deepseek",
  "dashscope",
  "volcengine",
] as const;

export const DASHSCOPE_ENDPOINT_ORIGINS: Record<
  Exclude<DashScopeEndpointPreset, "custom">,
  string
> = {
  "payg-cn": "https://dashscope.aliyuncs.com",
  "payg-intl": "https://dashscope-intl.aliyuncs.com",
  "token-plan-cn": "https://token-plan.cn-beijing.maas.aliyuncs.com",
  "token-plan-intl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
};

export interface SpeechVoicePreset {
  id: string;
  label: string;
  resourceId?: string;
}

export interface SpeechModelPreset {
  id: string;
  label: string;
}

export interface SpeechProviderCatalogEntry {
  kind: SpeechProviderKind;
  defaultBaseUrl: string;
  supportsLinkedProvider: boolean;
  consoleUrl: string;
  docsUrl: string;
  asrModels: readonly SpeechModelPreset[];
  ttsModels: readonly SpeechModelPreset[];
  ttsVoices: readonly SpeechVoicePreset[];
  volcAsrResourceIds?: readonly SpeechModelPreset[];
  volcTtsResourceIds?: readonly SpeechModelPreset[];
}

export const SPEECH_CATALOG: Record<SpeechProviderKind, SpeechProviderCatalogEntry> = {
  deepseek: {
    kind: "deepseek",
    defaultBaseUrl: "https://api.deepseek.com",
    supportsLinkedProvider: true,
    consoleUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/",
    asrModels: [{ id: "deepseek-asr", label: "DeepSeek ASR (/v1/tools/asr)" }],
    ttsModels: [{ id: "deepseek-tts", label: "DeepSeek TTS (/v1/tools/tts)" }],
    ttsVoices: [
      { id: "stella", label: "Stella (海星 · 女声)" },
      { id: "tide", label: "Tide (暗潮 · 男声)" },
    ],
  },
  dashscope: {
    kind: "dashscope",
    defaultBaseUrl: DASHSCOPE_ENDPOINT_ORIGINS["payg-cn"],
    supportsLinkedProvider: true,
    consoleUrl: "https://bailian.console.aliyun.com/",
    docsUrl: "https://help.aliyun.com/zh/model-studio/",
    asrModels: [
      { id: "qwen3-asr-flash", label: "qwen3-asr-flash (推荐 · 同步识别)" },
      { id: "qwen-audio-3.0-asr-flash", label: "qwen-audio-3.0-asr-flash" },
    ],
    ttsModels: [
      { id: "qwen3-tts-flash", label: "qwen3-tts-flash (推荐)" },
      { id: "qwen-audio-3.0-tts-flash", label: "qwen-audio-3.0-tts-flash" },
      { id: "qwen-audio-3.0-tts-plus", label: "qwen-audio-3.0-tts-plus" },
    ],
    ttsVoices: [
      { id: "Cherry", label: "Cherry (芊悦 · 亲切女声)" },
      { id: "Ethan", label: "Ethan (晨煦 · 阳光男声)" },
      { id: "Serena", label: "Serena (苏瑶 · 温柔女声)" },
      { id: "Chelsie", label: "Chelsie (千雪 · 二次元)" },
      { id: "Nofish", label: "Nofish (不吃鱼 · 设计师)" },
      { id: "Jennifer", label: "Jennifer (詹妮弗 · 电影女声)" },
      { id: "Ryan", label: "Ryan (甜茶 · 活力男声)" },
      { id: "Katerina", label: "Katerina (卡捷琳娜 · 御姐)" },
      { id: "Elias", label: "Elias (墨讲师 · 学术)" },
      { id: "Jada", label: "Jada (上海话 · 阿珍)" },
      { id: "Dylan", label: "Dylan (北京话 · 晓东)" },
      { id: "Sunny", label: "Sunny (四川话 · 晴儿)" },
      { id: "Li", label: "Li (南京话 · 老李)" },
      { id: "Marcus", label: "Marcus (陕西话 · 秦川)" },
      { id: "Roy", label: "Roy (闽南语 · 阿杰)" },
      { id: "Peter", label: "Peter (天津话 · 李彼得)" },
      { id: "Rocky", label: "Rocky (粤语 · 阿强)" },
      { id: "Kiki", label: "Kiki (粤语 · 阿清)" },
      { id: "Eric", label: "Eric (四川话 · 程川)" },
    ],
  },
  volcengine: {
    kind: "volcengine",
    defaultBaseUrl: "https://openspeech.bytedance.com",
    supportsLinkedProvider: false,
    consoleUrl: "https://console.volcengine.com/speech/app",
    docsUrl: "https://www.volcengine.com/docs/6561",
    asrModels: [{ id: "bigmodel", label: "豆包录音文件识别极速版 (bigmodel)" }],
    ttsModels: [
      { id: "seed-tts-2.0", label: "豆包语音合成大模型 2.0 (seed-tts-2.0)" },
      { id: "seed-tts-1.0", label: "豆包语音合成大模型 1.0 (seed-tts-1.0)" },
    ],
    volcAsrResourceIds: [
      { id: "volc.bigasr.auc_turbo", label: "volc.bigasr.auc_turbo (录音极速版)" },
    ],
    volcTtsResourceIds: [
      { id: "seed-tts-2.0", label: "seed-tts-2.0 (豆包语音合成 2.0)" },
      { id: "seed-tts-1.0", label: "seed-tts-1.0 (豆包语音合成 1.0)" },
    ],
    ttsVoices: [
      { id: "zh_female_vv_uranus_bigtts", label: "Vivi 2.0 (通用女声 · 2.0)", resourceId: "seed-tts-2.0" },
      { id: "zh_female_xiaohe_uranus_bigtts", label: "小何 2.0 (自然女声 · 2.0)", resourceId: "seed-tts-2.0" },
      { id: "zh_male_m191_uranus_bigtts", label: "云舟 2.0 (沉稳男声 · 2.0)", resourceId: "seed-tts-2.0" },
      { id: "zh_male_taocheng_uranus_bigtts", label: "小天 2.0 (活力男声 · 2.0)", resourceId: "seed-tts-2.0" },
      { id: "zh_female_shuangkuaisisi_moon_bigtts", label: "爽快思思 (1.0)", resourceId: "seed-tts-1.0" },
      { id: "zh_male_wennuanahu_moon_bigtts", label: "温暖阿虎 (1.0)", resourceId: "seed-tts-1.0" },
      { id: "zh_female_tianmeixiaoyuan_moon_bigtts", label: "甜美小媛 (1.0)", resourceId: "seed-tts-1.0" },
      { id: "zh_male_shaonianzixin_moon_bigtts", label: "少年梓辛 (1.0)", resourceId: "seed-tts-1.0" },
    ],
  },
};

export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = {
  activeAsrProvider: null,
  activeTtsProvider: null,
  asrAfterTranscribe: "insert",
  asrInputDeviceId: "",
  ttsPlaybackRate: 1.0,
  ttsStripCodeBlocks: true,
  ttsStripMarkdown: true,
  ttsMaxChunkChars: 500,
};

export function defaultSpeechProviderConfig(kind: SpeechProviderKind): SpeechProviderConfig {
  switch (kind) {
    case "deepseek":
      return {
        kind: "deepseek",
        enabled: false,
        credentialMode: "custom",
        hasApiKey: false,
        baseUrl: SPEECH_CATALOG.deepseek.defaultBaseUrl,
        asrModel: "deepseek-asr",
        ttsModel: "deepseek-tts",
        ttsVoice: "stella",
        ttsFormat: "wav",
        ttsSampleRate: 24000,
        lastHealth: "unknown",
      };
    case "dashscope":
      return {
        kind: "dashscope",
        enabled: false,
        credentialMode: "custom",
        hasApiKey: false,
        baseUrl: DASHSCOPE_ENDPOINT_ORIGINS["payg-cn"],
        dashscopeEndpointPreset: "payg-cn",
        asrModel: "qwen3-asr-flash",
        ttsModel: "qwen3-tts-flash",
        ttsVoice: "Cherry",
        ttsFormat: "mp3",
        ttsSampleRate: 24000,
        lastHealth: "unknown",
      };
    case "volcengine":
      return {
        kind: "volcengine",
        enabled: false,
        credentialMode: "custom",
        hasApiKey: false,
        hasVolcAccessToken: false,
        baseUrl: SPEECH_CATALOG.volcengine.defaultBaseUrl,
        volcAuthMode: "app_token",
        volcAsrResourceId: "volc.bigasr.auc_turbo",
        volcTtsResourceId: "seed-tts-2.0",
        asrModel: "bigmodel",
        ttsModel: "seed-tts-2.0",
        ttsVoice: "zh_female_vv_uranus_bigtts",
        ttsFormat: "mp3",
        ttsSampleRate: 24000,
        lastHealth: "unknown",
      };
  }
}

function normalizeOriginCandidate(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // Strip standard DashScope suffixes if user pasted a full compatible-mode or API path.
    const cleanPath = parsed.pathname
      .replace(/\/+$/, "")
      .replace(/\/compatible-mode\/v1$/i, "")
      .replace(/\/apps\/anthropic$/i, "")
      .replace(/\/api\/v1.*$/i, "");
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return null;
  }
}

export function inferDashScopePresetFromUrl(rawUrl: string | undefined): DashScopeEndpointPreset | null {
  const normalized = normalizeOriginCandidate(rawUrl);
  if (!normalized) return null;
  let host = "";
  try {
    host = new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "dashscope.aliyuncs.com") return "payg-cn";
  if (host === "dashscope-intl.aliyuncs.com") return "payg-intl";
  if (host === "token-plan.cn-beijing.maas.aliyuncs.com") return "token-plan-cn";
  if (host === "token-plan.ap-southeast-1.maas.aliyuncs.com") return "token-plan-intl";
  if (host.endsWith(".maas.aliyuncs.com") || host.endsWith(".aliyuncs.com")) return "custom";
  return null;
}

export function resolveDashScopeOrigin(options: {
  preset?: DashScopeEndpointPreset;
  customBaseUrl?: string;
  linkedProviderBaseUrl?: string;
}): string {
  if (options.preset === "custom") {
    return (
      normalizeOriginCandidate(options.customBaseUrl) ??
      normalizeOriginCandidate(options.linkedProviderBaseUrl) ??
      DASHSCOPE_ENDPOINT_ORIGINS["payg-cn"]
    );
  }
  if (options.preset && options.preset in DASHSCOPE_ENDPOINT_ORIGINS) {
    return DASHSCOPE_ENDPOINT_ORIGINS[options.preset];
  }
  if (options.linkedProviderBaseUrl) {
    const inferred = inferDashScopePresetFromUrl(options.linkedProviderBaseUrl);
    if (inferred && inferred !== "custom") {
      return DASHSCOPE_ENDPOINT_ORIGINS[inferred];
    }
    if (inferred === "custom") {
      const normalized = normalizeOriginCandidate(options.linkedProviderBaseUrl);
      if (normalized) return normalized;
    }
  }
  return normalizeOriginCandidate(options.customBaseUrl) ?? DASHSCOPE_ENDPOINT_ORIGINS["payg-cn"];
}

export type DashScopeKeyMismatch = "token_plan_key_on_payg" | "payg_key_on_token_plan" | null;

export function detectDashScopeKeyEndpointMismatch(
  apiKey: string | undefined,
  origin: string
): DashScopeKeyMismatch {
  const key = (apiKey ?? "").trim();
  if (!key) return null;
  let host = "";
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const isTokenPlanKey = key.startsWith("sk-sp-");
  const isTokenPlanHost = host.startsWith("token-plan.") && host.endsWith(".maas.aliyuncs.com");
  const isPaygHost = host === "dashscope.aliyuncs.com" || host === "dashscope-intl.aliyuncs.com";

  if (isTokenPlanKey && isPaygHost) return "token_plan_key_on_payg";
  if (!isTokenPlanKey && isTokenPlanHost) return "payg_key_on_token_plan";
  return null;
}

import type { ProviderModel } from "./types";

export interface ModelBrandMeta {
  name: string;
  badge: string;
  color: string;
  bg: string;
  border: string;
  lobeIconId?: string;
}

export interface ModelCapabilities {
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  code: boolean;
}

export function getModelBrand(modelId: string): ModelBrandMeta {
  const lower = modelId.toLowerCase();
  if (/(gpt|o1|o3|openai|chatgpt|text-embedding)/i.test(lower)) {
    return {
      name: "OpenAI",
      badge: "OAI",
      color: "#10a37f",
      bg: "rgba(16, 163, 127, 0.12)",
      border: "rgba(16, 163, 127, 0.28)",
      lobeIconId: "openai",
    };
  }
  if (/claude|anthropic/i.test(lower)) {
    return {
      name: "Anthropic",
      badge: "Claude",
      color: "#d97757",
      bg: "rgba(217, 119, 87, 0.12)",
      border: "rgba(217, 119, 87, 0.28)",
      lobeIconId: "anthropic",
    };
  }
  if (/deepseek|\u6df1\u5ea6\u6c42\u7d22/i.test(lower)) {
    return {
      name: "DeepSeek",
      badge: "DS",
      color: "#4d6bfe",
      bg: "rgba(77, 107, 254, 0.12)",
      border: "rgba(77, 107, 254, 0.28)",
      lobeIconId: "deepseek",
    };
  }
  if (/gemini|google/i.test(lower)) {
    return {
      name: "Google",
      badge: "Gemini",
      color: "#1a73e8",
      bg: "rgba(26, 115, 232, 0.12)",
      border: "rgba(26, 115, 232, 0.28)",
      lobeIconId: "gemini",
    };
  }
  if (/qwen|tongyi|aliyun|bailian|\u5343\u95ee|\u901a\u4e49/i.test(lower)) {
    return {
      name: "Qwen",
      badge: "Qwen",
      color: "#615ced",
      bg: "rgba(97, 92, 237, 0.12)",
      border: "rgba(97, 92, 237, 0.28)",
      lobeIconId: "qwen",
    };
  }
  if (/llama|meta/i.test(lower)) {
    return {
      name: "Meta",
      badge: "Llama",
      color: "#0668e1",
      bg: "rgba(6, 104, 225, 0.12)",
      border: "rgba(6, 104, 225, 0.28)",
      lobeIconId: "meta",
    };
  }
  if (/mistral|codestral|pixtral|mixtral/i.test(lower)) {
    return {
      name: "Mistral",
      badge: "Mistral",
      color: "#f75700",
      bg: "rgba(247, 87, 0, 0.12)",
      border: "rgba(247, 87, 0, 0.28)",
      lobeIconId: "mistral",
    };
  }
  if (/kimi|moonshot|\u6708\u4e4b\u6697\u9762/i.test(lower)) {
    return {
      name: "Moonshot",
      badge: "Kimi",
      color: "#0f62fe",
      bg: "rgba(15, 98, 254, 0.12)",
      border: "rgba(15, 98, 254, 0.28)",
      lobeIconId: "moonshot",
    };
  }
  if (/glm|zhipu|chatglm|bigmodel|\u667a\u8c31/i.test(lower)) {
    return {
      name: "Zhipu",
      badge: "GLM",
      color: "#325ab4",
      bg: "rgba(50, 90, 180, 0.12)",
      border: "rgba(50, 90, 180, 0.28)",
      lobeIconId: "zhipu",
    };
  }
  if (/minimax|abab|\u6d77\u87ba/i.test(lower)) {
    return {
      name: "MiniMax",
      badge: "MM",
      color: "#e11d48",
      bg: "rgba(225, 29, 72, 0.12)",
      border: "rgba(225, 29, 72, 0.28)",
      lobeIconId: "minimax",
    };
  }
  if (/doubao|skylark|bytedance|volcengine|\u8c46\u5305|\u706b\u5c71/i.test(lower)) {
    return {
      name: "Doubao",
      badge: "DB",
      color: "#3b82f6",
      bg: "rgba(59, 130, 246, 0.12)",
      border: "rgba(59, 130, 246, 0.28)",
      lobeIconId: "doubao",
    };
  }
  if (/sense|sensenova|senseaudio|\u5546\u6c64/i.test(lower)) {
    return {
      name: "SenseNova",
      badge: "Sense",
      color: "#6366f1",
      bg: "rgba(99, 102, 241, 0.12)",
      border: "rgba(99, 102, 241, 0.28)",
      lobeIconId: "sensenova",
    };
  }
  if (/silicon|siliconcloud|siliconflow|\u7845\u57fa/i.test(lower)) {
    return {
      name: "SiliconCloud",
      badge: "SF",
      color: "#7c3aed",
      bg: "rgba(124, 58, 237, 0.12)",
      border: "rgba(124, 58, 237, 0.28)",
      lobeIconId: "siliconcloud",
    };
  }
  if (/ollama/i.test(lower)) {
    return {
      name: "Ollama",
      badge: "OLL",
      color: "#ffffff",
      bg: "rgba(255, 255, 255, 0.12)",
      border: "rgba(255, 255, 255, 0.28)",
      lobeIconId: "ollama",
    };
  }
  if (/groq/i.test(lower)) {
    return {
      name: "Groq",
      badge: "Groq",
      color: "#f55036",
      bg: "rgba(245, 80, 54, 0.12)",
      border: "rgba(245, 80, 54, 0.28)",
      lobeIconId: "groq",
    };
  }
  if (/stepfun|step|\u9636\u8dc3/i.test(lower)) {
    return {
      name: "Stepfun",
      badge: "Step",
      color: "#0284c7",
      bg: "rgba(2, 132, 199, 0.12)",
      border: "rgba(2, 132, 199, 0.28)",
      lobeIconId: "stepfun",
    };
  }
  if (/baichuan|\u767e\u5ddd/i.test(lower)) {
    return {
      name: "Baichuan",
      badge: "BC",
      color: "#ea580c",
      bg: "rgba(234, 88, 12, 0.12)",
      border: "rgba(234, 88, 12, 0.28)",
      lobeIconId: "baichuan",
    };
  }
  if (/openrouter/i.test(lower)) {
    return {
      name: "OpenRouter",
      badge: "OR",
      color: "#6366f1",
      bg: "rgba(99, 102, 241, 0.12)",
      border: "rgba(99, 102, 241, 0.28)",
      lobeIconId: "openrouter",
    };
  }
  if (/together/i.test(lower)) {
    return {
      name: "Together",
      badge: "TOG",
      color: "#0f766e",
      bg: "rgba(15, 118, 110, 0.12)",
      border: "rgba(15, 118, 110, 0.28)",
      lobeIconId: "together",
    };
  }
  if (/perplexity/i.test(lower)) {
    return {
      name: "Perplexity",
      badge: "PPLX",
      color: "#22b8cf",
      bg: "rgba(34, 184, 207, 0.12)",
      border: "rgba(34, 184, 207, 0.28)",
      lobeIconId: "perplexity",
    };
  }
  if (/zeroone|01|\u96f6\u4e00/i.test(lower)) {
    return {
      name: "ZeroOne",
      badge: "01",
      color: "#059669",
      bg: "rgba(5, 150, 105, 0.12)",
      border: "rgba(5, 150, 105, 0.28)",
      lobeIconId: "zeroone",
    };
  }
  if (/xai|grok/i.test(lower)) {
    return {
      name: "xAI",
      badge: "xAI",
      color: "#ffffff",
      bg: "rgba(255, 255, 255, 0.12)",
      border: "rgba(255, 255, 255, 0.28)",
      lobeIconId: "xai",
    };
  }
  if (/wenxin|ernie|baidu|\u767e\u5ea6|\u6587\u5fc3/i.test(lower)) {
    return {
      name: "Wenxin",
      badge: "ERN",
      color: "#2932e1",
      bg: "rgba(41, 50, 225, 0.12)",
      border: "rgba(41, 50, 225, 0.28)",
      lobeIconId: "wenxin",
    };
  }
  if (/hunyuan|tencent|\u817e\u8baf|\u6df7\u5143/i.test(lower)) {
    return {
      name: "Hunyuan",
      badge: "HY",
      color: "#0052d9",
      bg: "rgba(0, 82, 217, 0.12)",
      border: "rgba(0, 82, 217, 0.28)",
      lobeIconId: "hunyuan",
    };
  }
  if (/spark|iflytek|xfyun|\u8baf\u98de|\u661f\u706b/i.test(lower)) {
    return {
      name: "Spark",
      badge: "XF",
      color: "#0070f0",
      bg: "rgba(0, 112, 240, 0.12)",
      border: "rgba(0, 112, 240, 0.28)",
      lobeIconId: "spark",
    };
  }
  if (/internlm|shanghaiai|\u4e66\u751f/i.test(lower)) {
    return {
      name: "InternLM",
      badge: "IN",
      color: "#1d4ed8",
      bg: "rgba(29, 78, 216, 0.12)",
      border: "rgba(29, 78, 216, 0.28)",
      lobeIconId: "internlm",
    };
  }
  if (/cohere/i.test(lower)) {
    return {
      name: "Cohere",
      badge: "CO",
      color: "#39594d",
      bg: "rgba(57, 89, 77, 0.12)",
      border: "rgba(57, 89, 77, 0.28)",
      lobeIconId: "cohere",
    };
  }
  // Fallback
  const initials = modelId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "AI";
  return {
    name: "Model",
    badge: initials,
    color: "var(--fb-text-secondary, #94a3b8)",
    bg: "var(--fb-surface-2, rgba(255, 255, 255, 0.06))",
    border: "var(--fb-border, rgba(255, 255, 255, 0.12))",
  };
}

export function inferModelCapabilities(
  modelId: string,
  overrides?: {
    supportsReasoning?: boolean;
    supportsTools?: boolean;
    supportsVision?: boolean;
  },
): ModelCapabilities {
  const lower = modelId.toLowerCase();

  // Non-chat special models (embedding, audio, moderation, tts, rerank)
  const isNonChat = /(embedding|embed|rerank|tts|whisper|dall-e|moderation|voice|speech)/i.test(
    lower,
  );

  const defaultReasoning = /(o1|o3|r1|reasoner|thinking|reasoning)/i.test(lower);
  const defaultVision =
    /(4o|vision|vl|sonnet|gemini|omni|pixtral|qwen-vl|glm-4v|internvl|v4\.1|v41)/i.test(
      lower,
    );
  const defaultCode = /(code|coder|codestral|starcoder|deepseek-coder)/i.test(
    lower,
  );

  // Tools: almost all general chat/code models support tool-calling, except pure R1 or non-chat models
  let defaultTools = !isNonChat;
  if (/deepseek-reasoner/i.test(lower)) {
    defaultTools = false;
  }

  return {
    reasoning: overrides?.supportsReasoning ?? defaultReasoning,
    vision: overrides?.supportsVision ?? defaultVision,
    tools: overrides?.supportsTools ?? defaultTools,
    code: defaultCode,
  };
}

export function inferContextWindow(
  _modelId: string,
  configured?: number,
): number | undefined {
  if (configured && configured > 0) return configured;
  return undefined;
}

export function inferModelGroup(modelId: string, customGroup?: string): string {
  if (customGroup && customGroup.trim()) return customGroup.trim();
  const lower = modelId.toLowerCase();
  if (/(gpt|o1|o3|chatgpt)/i.test(lower)) return "OpenAI";
  if (/claude/i.test(lower)) return "Claude";
  if (/deepseek/i.test(lower)) return "DeepSeek";
  if (/gemini|google/i.test(lower)) return "Gemini";
  if (/qwen/i.test(lower)) return "Qwen";
  if (/(llama|meta)/i.test(lower)) return "Llama";
  if (/(mistral|codestral|pixtral|mixtral)/i.test(lower)) return "Mistral";
  if (/(kimi|moonshot)/i.test(lower)) return "Moonshot";
  if (/(glm|zhipu)/i.test(lower)) return "GLM";
  if (/minimax|abab/i.test(lower)) return "MiniMax";
  if (/baichuan/i.test(lower)) return "Baichuan";
  if (/doubao|skylark/i.test(lower)) return "Doubao";
  if (/senseaudio/i.test(lower)) return "SenseAudio";

  // Check prefix before "-" or "/" or ":"
  const match = modelId.match(/^([a-zA-Z0-9]+)[-_/:]/);
  if (match && match[1] && match[1].length >= 3 && match[1].toLowerCase() !== "text") {
    const prefix = match[1];
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }

  return "Other";
}

export function formatTokenCount(tokens?: number): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1000000) {
    const m = (tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1);
    return `${m}M`;
  }
  if (tokens >= 1000) {
    const k = (tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 0);
    return `${k}K`;
  }
  return String(tokens);
}

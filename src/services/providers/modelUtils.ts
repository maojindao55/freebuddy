import type { ProviderModel } from "./types";

export interface ModelBrandMeta {
  name: string;
  badge: string;
  color: string;
  bg: string;
  border: string;
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
    };
  }
  if (/claude|anthropic/i.test(lower)) {
    return {
      name: "Anthropic",
      badge: "Claude",
      color: "#d97757",
      bg: "rgba(217, 119, 87, 0.12)",
      border: "rgba(217, 119, 87, 0.28)",
    };
  }
  if (/deepseek/i.test(lower)) {
    return {
      name: "DeepSeek",
      badge: "DS",
      color: "#4d6bfe",
      bg: "rgba(77, 107, 254, 0.12)",
      border: "rgba(77, 107, 254, 0.28)",
    };
  }
  if (/gemini|google/i.test(lower)) {
    return {
      name: "Google",
      badge: "Gemini",
      color: "#1a73e8",
      bg: "rgba(26, 115, 232, 0.12)",
      border: "rgba(26, 115, 232, 0.28)",
    };
  }
  if (/qwen/i.test(lower)) {
    return {
      name: "Qwen",
      badge: "Qwen",
      color: "#615ced",
      bg: "rgba(97, 92, 237, 0.12)",
      border: "rgba(97, 92, 237, 0.28)",
    };
  }
  if (/llama|meta/i.test(lower)) {
    return {
      name: "Meta",
      badge: "Llama",
      color: "#0668e1",
      bg: "rgba(6, 104, 225, 0.12)",
      border: "rgba(6, 104, 225, 0.28)",
    };
  }
  if (/mistral|codestral|pixtral|mixtral/i.test(lower)) {
    return {
      name: "Mistral",
      badge: "Mistral",
      color: "#f75700",
      bg: "rgba(247, 87, 0, 0.12)",
      border: "rgba(247, 87, 0, 0.28)",
    };
  }
  if (/kimi|moonshot/i.test(lower)) {
    return {
      name: "Moonshot",
      badge: "Kimi",
      color: "#0f62fe",
      bg: "rgba(15, 98, 254, 0.12)",
      border: "rgba(15, 98, 254, 0.28)",
    };
  }
  if (/glm|zhipu|chatglm/i.test(lower)) {
    return {
      name: "Zhipu",
      badge: "GLM",
      color: "#325ab4",
      bg: "rgba(50, 90, 180, 0.12)",
      border: "rgba(50, 90, 180, 0.28)",
    };
  }
  if (/minimax|abab/i.test(lower)) {
    return {
      name: "MiniMax",
      badge: "MM",
      color: "#e11d48",
      bg: "rgba(225, 29, 72, 0.12)",
      border: "rgba(225, 29, 72, 0.28)",
    };
  }
  if (/doubao|skylark|bytedance/i.test(lower)) {
    return {
      name: "Doubao",
      badge: "DB",
      color: "#3b82f6",
      bg: "rgba(59, 130, 246, 0.12)",
      border: "rgba(59, 130, 246, 0.28)",
    };
  }
  if (/senseaudio/i.test(lower)) {
    return {
      name: "SenseAudio",
      badge: "Sense",
      color: "#6366f1",
      bg: "rgba(99, 102, 241, 0.12)",
      border: "rgba(99, 102, 241, 0.28)",
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
    /(4o|vision|vl|sonnet|gemini|omni|pixtral|qwen-vl|glm-4v|internvl)/i.test(
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
  modelId: string,
  configured?: number,
): number | undefined {
  if (configured && configured > 0) return configured;
  const lower = modelId.toLowerCase();
  if (/gemini-(1\.5|2\.0)/i.test(lower)) return 1000000;
  if (/claude-(3|3-5|3-7)/i.test(lower)) return 200000;
  if (/(gpt-4o|o1|o3|deepseek|qwen|glm-4|moonshot)/i.test(lower)) return 128000;
  if (/gpt-4-turbo/i.test(lower)) return 128000;
  if (/gpt-4/i.test(lower)) return 32768;
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

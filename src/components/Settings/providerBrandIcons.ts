import type { IconType } from "@lobehub/icons/es/types";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Color";
import Gemini from "@lobehub/icons/es/Gemini/components/Color";
import Qwen from "@lobehub/icons/es/Qwen/components/Color";
import Meta from "@lobehub/icons/es/Meta/components/Color";
import Mistral from "@lobehub/icons/es/Mistral/components/Color";
import Moonshot from "@lobehub/icons/es/Moonshot/components/Mono";
import Zhipu from "@lobehub/icons/es/Zhipu/components/Color";
import Minimax from "@lobehub/icons/es/Minimax/components/Color";
import Doubao from "@lobehub/icons/es/Doubao/components/Color";
import SenseNova from "@lobehub/icons/es/SenseNova/components/Color";
import SiliconCloud from "@lobehub/icons/es/SiliconCloud/components/Color";
import Ollama from "@lobehub/icons/es/Ollama/components/Mono";
import Groq from "@lobehub/icons/es/Groq/components/Mono";
import Stepfun from "@lobehub/icons/es/Stepfun/components/Color";
import Baichuan from "@lobehub/icons/es/Baichuan/components/Color";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Mono";
import Together from "@lobehub/icons/es/Together/components/Color";
import Perplexity from "@lobehub/icons/es/Perplexity/components/Color";
import ZeroOne from "@lobehub/icons/es/ZeroOne/components/Color";
import XAI from "@lobehub/icons/es/XAI/components/Mono";
import Wenxin from "@lobehub/icons/es/Wenxin/components/Color";
import Hunyuan from "@lobehub/icons/es/Hunyuan/components/Color";
import Spark from "@lobehub/icons/es/Spark/components/Color";
import InternLM from "@lobehub/icons/es/InternLM/components/Color";
import Cohere from "@lobehub/icons/es/Cohere/components/Color";
import ModelScope from "@lobehub/icons/es/ModelScope/components/Color";
import Cerebras from "@lobehub/icons/es/Cerebras/components/Color";

// Import the small SVG components directly: no CDN requests or avatar/UI runtime.
const providerBrandIcons: Record<string, IconType> = {
  openai: OpenAI,
  anthropic: Anthropic,
  deepseek: DeepSeek,
  gemini: Gemini,
  qwen: Qwen,
  meta: Meta,
  mistral: Mistral,
  moonshot: Moonshot,
  zhipu: Zhipu,
  minimax: Minimax,
  doubao: Doubao,
  sensenova: SenseNova,
  siliconcloud: SiliconCloud,
  ollama: Ollama,
  groq: Groq,
  stepfun: Stepfun,
  baichuan: Baichuan,
  openrouter: OpenRouter,
  together: Together,
  perplexity: Perplexity,
  zeroone: ZeroOne,
  xai: XAI,
  wenxin: Wenxin,
  hunyuan: Hunyuan,
  spark: Spark,
  internlm: InternLM,
  cohere: Cohere,
  modelscope: ModelScope,
  cerebras: Cerebras,
};

export function getProviderBrandIcon(id: string): IconType | undefined {
  return Object.hasOwn(providerBrandIcons, id) ? providerBrandIcons[id] : undefined;
}

/** Catalogs use both avatar IDs and SVG IDs, e.g. deepseek-color. */
export function normalizeProviderIconId(value: string): string {
  return value.trim().toLowerCase().replace(/^lobehub:/, "").replace(/[-.](color|mono)$/, "").replace(/[\s._-]/g, "");
}

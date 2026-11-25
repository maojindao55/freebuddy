import {
  getProvider,
  getProviderApiKey,
  listProviders,
  type ProviderProtocol,
  type ProviderRecord
} from "./providers.js";
import { getLanguage } from "./settings.js";
import type {
  ConversationDigestConfig,
  ConversationTopic,
  ConversationTopicStatus
} from "../shared/conversationDigestTypes.js";

const LIGHT_MODEL_RE =
  /(mini|flash|haiku|small|lite|deepseek-chat|turbo|nano)/i;
const LLM_TIMEOUT_MS = 30_000;

export interface ResolvedDigestProvider {
  provider: ProviderRecord;
  apiKey: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
}

export interface DigestTurnInput {
  turnIndex: number;
  userMessageId: string;
  assistantMessageId?: string;
  userText: string;
  assistantText: string;
  status: ConversationTopicStatus;
  files: string[];
  createdAt: string;
}

export interface RawDigestTopicOutput {
  id?: string;
  title?: string;
  summary?: string;
  status?: string;
  startMessageId?: string;
  endMessageId?: string;
  turnCount?: number;
  keywords?: unknown[];
  files?: unknown[];
}

export interface DigestLlmResult {
  overallSummary?: string;
  topics: RawDigestTopicOutput[];
}

function pickProtocolAndUrl(
  provider: ProviderRecord
): { protocol: ProviderProtocol; baseUrl: string } | null {
  const protocols = provider.protocols?.length
    ? provider.protocols
    : [provider.protocol];
  const openAiUrl = provider.baseUrl?.trim();
  const anthropicUrl =
    provider.anthropicBaseUrl?.trim() || provider.baseUrl?.trim();

  // Prefer OpenAI Chat Completions / DeepSeek over Responses API because
  // third-party relays more universally support /chat/completions.
  if (openAiUrl) {
    const chatProto = protocols.find(
      (p) => p === "openai-chat" || p === "deepseek"
    );
    if (chatProto) {
      return { protocol: chatProto, baseUrl: openAiUrl };
    }
    if (protocols.includes("openai-responses")) {
      return { protocol: "openai-responses", baseUrl: openAiUrl };
    }
  }
  if (protocols.includes("anthropic") && anthropicUrl) {
    return { protocol: "anthropic", baseUrl: anthropicUrl };
  }
  if (openAiUrl) {
    return { protocol: provider.protocol, baseUrl: openAiUrl };
  }
  return null;
}

function defaultModelForProtocol(protocol: ProviderProtocol): string {
  if (protocol === "anthropic") return "claude-3-5-haiku-latest";
  if (protocol === "deepseek") return "deepseek-chat";
  return "gpt-4o-mini";
}

function pickLightModel(
  provider: ProviderRecord,
  protocol: ProviderProtocol,
  configuredModel: string
): string {
  const explicit = configuredModel.trim();
  if (explicit) return explicit;
  const enabledModels = provider.models.filter((m) => m.enabled !== false);
  const light = enabledModels.find((m) => LIGHT_MODEL_RE.test(m.id));
  if (light) return light.id;
  if (enabledModels[0]?.id) return enabledModels[0].id;
  if (provider.models[0]?.id) return provider.models[0].id;
  return defaultModelForProtocol(protocol);
}

/** Resolve all enabled BYOK providers with keys (explicit config or priority fallback list). */
export function resolveDigestProviders(
  config: ConversationDigestConfig
): ResolvedDigestProvider[] {
  const candidates: ProviderRecord[] = [];
  const configuredId = config.providerId.trim();
  if (configuredId) {
    const specific = getProvider(configuredId);
    if (specific && specific.enabled && specific.hasKey) {
      candidates.push(specific);
    }
  } else {
    for (const provider of listProviders()) {
      if (provider.enabled && provider.hasKey) {
        candidates.push(provider);
      }
    }
  }

  const resolved: ResolvedDigestProvider[] = [];
  for (const provider of candidates) {
    const apiKey = getProviderApiKey(provider.id)?.trim();
    if (!apiKey) continue;
    const endpoint = pickProtocolAndUrl(provider);
    if (!endpoint) continue;
    const model = pickLightModel(provider, endpoint.protocol, config.model);
    resolved.push({
      provider,
      apiKey,
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      model
    });
  }
  return resolved;
}

/** Resolve the primary BYOK provider + key + light model for background digests. */
export function resolveDigestProvider(
  config: ConversationDigestConfig
): ResolvedDigestProvider | null {
  return resolveDigestProviders(config)[0] ?? null;
}

function buildDigestPrompts(input: {
  conversationTitle: string;
  existingOverallSummary?: string;
  existingTopics: ConversationTopic[];
  newTurns: DigestTurnInput[];
}): { systemPrompt: string; userPrompt: string } {
  const chinese = getLanguage() === "zh-CN";
  const systemPrompt = chinese
    ? [
        "你是 ButlerBuddy，负责把一个长对话里的多个用户需求整理成清晰、可搜索的结构化目录。",
        "你会收到：[已有需求列表] 与 [新增对话轮次]。",
        "规则：",
        "1. 若新轮次是对已有需求的追问、修改、调试或确认，请合并更新对应已有需求（保留其 id 与最早 startMessageId，更新 endMessageId、turnCount、summary、status、files、keywords）。",
        "2. 若新轮次提出了独立的新需求/新任务，请新增一条需求卡片（id 设为 new-1、new-2…）。",
        "3. status 只能是 open（进行中/待继续）、done（已完成）、blocked（失败/阻塞）、abandoned（明确放弃）。",
        "4. startMessageId 与 endMessageId 必须原样使用输入中的真实 messageId，严禁编造。",
        "5. 只输出合法 JSON，不要包含 Markdown 代码块之外的多余解释。",
        '输出格式：{"overallSummary":"不超过120字的总览","topics":[{"id":"...","title":"不超过30字的需求标题","summary":"一句话结果或状态(<=140字)","status":"open|done|blocked|abandoned","startMessageId":"...","endMessageId":"...","turnCount":1,"keywords":["关键词"],"files":["路径"]}]}'
      ].join("\n")
    : [
        "You are ButlerBuddy, organizing multi-requirement conversations into a concise, searchable requirement outline.",
        "You receive [Existing topics] and [New turns].",
        "Rules:",
        "1. If a new turn is follow-up, refinement, or debugging for an existing topic, merge and update that topic (keep its id and earliest startMessageId; update endMessageId, turnCount, summary, status, files, keywords).",
        "2. If a new turn introduces a distinct requirement or task, add a new topic (id: new-1, new-2, ...).",
        "3. status must be one of: open, done, blocked, abandoned.",
        "4. startMessageId and endMessageId must come verbatim from the input messageIds.",
        "5. Return valid JSON only, with no prose outside the JSON object.",
        'Schema: {"overallSummary":"<=120 chars","topics":[{"id":"...","title":"<=30 chars","summary":"1-sentence status/result (<=140 chars)","status":"open|done|blocked|abandoned","startMessageId":"...","endMessageId":"...","turnCount":1,"keywords":["..."],"files":["..."]}]}'
      ].join("\n");

  const payload = {
    conversationTitle: input.conversationTitle,
    existingOverallSummary: input.existingOverallSummary ?? "",
    existingTopics: input.existingTopics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      summary: topic.summary,
      status: topic.status,
      startMessageId: topic.startMessageId,
      endMessageId: topic.endMessageId,
      turnCount: topic.turnCount,
      keywords: topic.keywords,
      files: topic.files
    })),
    newTurns: input.newTurns.map((turn) => ({
      turnIndex: turn.turnIndex,
      userMessageId: turn.userMessageId,
      ...(turn.assistantMessageId
        ? { assistantMessageId: turn.assistantMessageId }
        : {}),
      status: turn.status,
      userText: turn.userText,
      assistantText: turn.assistantText,
      files: turn.files,
      createdAt: turn.createdAt
    }))
  };

  return {
    systemPrompt,
    userPrompt: JSON.stringify(payload)
  };
}

function buildCandidateUrls(
  baseUrl: string,
  protocol: ProviderProtocol
): string[] {
  const clean = baseUrl.replace(/\/+$/, "");
  if (!clean) return [];
  const suffix =
    protocol === "anthropic"
      ? "/messages"
      : protocol === "openai-responses"
        ? "/responses"
        : "/chat/completions";
  if (clean.endsWith(suffix)) return [clean];
  if (clean.endsWith("/v1")) return [`${clean}${suffix}`];

  let pathname = "";
  try {
    pathname = new URL(clean).pathname;
  } catch {
    // Keep empty pathname when baseUrl cannot be parsed as URL.
  }
  // Respect already-versioned base URLs such as /v2/tokenplan/personal before appending /v1.
  if (/\/v\d+(?:[a-z0-9._-]*)?(?:\/|$)/i.test(pathname)) {
    return [`${clean}${suffix}`, `${clean}/v1${suffix}`];
  }
  return [`${clean}/v1${suffix}`, `${clean}${suffix}`];
}

function buildEndpointAttempts(
  resolved: ResolvedDigestProvider
): Array<{ protocol: ProviderProtocol; url: string }> {
  const attempts: Array<{ protocol: ProviderProtocol; url: string }> = [];
  const seen = new Set<string>();
  const add = (protocol: ProviderProtocol, baseUrl: string) => {
    for (const url of buildCandidateUrls(baseUrl, protocol)) {
      const key = `${protocol}:${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attempts.push({ protocol, url });
    }
  };

  add(resolved.protocol, resolved.baseUrl);
  if (resolved.protocol === "openai-responses") {
    add("openai-chat", resolved.baseUrl);
  }
  const anthropicUrl = resolved.provider.anthropicBaseUrl?.trim();
  if (
    resolved.protocol !== "anthropic" &&
    resolved.provider.protocols?.includes("anthropic") &&
    anthropicUrl
  ) {
    add("anthropic", anthropicUrl);
  }
  return attempts;
}

function isModelNotFound404(detail: string): boolean {
  if (!detail.trim()) return false;
  try {
    const parsed = JSON.parse(detail) as {
      error?: { code?: unknown; type?: unknown; message?: unknown } | string;
      message?: unknown;
    };
    if (!parsed || typeof parsed !== "object") return false;
    const errStr =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error && typeof parsed.error === "object"
          ? [parsed.error.code, parsed.error.type, parsed.error.message]
              .filter((v): v is string => typeof v === "string")
              .join(" ")
          : typeof parsed.message === "string"
            ? parsed.message
            : "";
    return /model[_\s-]*not[_\s-]*found|unknown[_\s-]*model|does not exist|unsupported[_\s-]*model/i.test(
      errStr
    );
  } catch {
    return false;
  }
}

function formatUpstreamHttpError(status: number, rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) return `Digest upstream HTTP ${status}`;
  if (/^<!doctype|^<html|^<head|^<body/i.test(trimmed) || trimmed.startsWith("<")) {
    const titleMatch = trimmed.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim();
    return `Digest upstream HTTP ${status}${title ? `: ${title}` : ""}`;
  }
  const clean = trimmed.replace(/\s+/g, " ").slice(0, 180);
  return `Digest upstream HTTP ${status}${clean ? `: ${clean}` : ""}`;
}

function buildRequest(
  protocol: ProviderProtocol,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): { headers: Record<string, string>; body: Record<string, unknown> } {
  const headers: Record<string, string> =
    protocol === "anthropic"
      ? {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        }
      : {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        };

  let body: Record<string, unknown>;
  if (protocol === "anthropic") {
    body = {
      model,
      max_tokens: 1800,
      temperature: 0.1,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    };
  } else if (protocol === "openai-responses") {
    body = {
      model,
      instructions: systemPrompt,
      input: userPrompt,
      max_output_tokens: 1800
    };
  } else {
    body = {
      model,
      temperature: 0.1,
      max_tokens: 1800,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    };
  }
  return { headers, body };
}

function extractTextFromResponse(
  protocol: ProviderProtocol,
  data: any
): string {
  if (!data || typeof data !== "object") return "";
  if (protocol === "anthropic") {
    if (Array.isArray(data.content)) {
      return data.content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("");
    }
    return "";
  }
  if (protocol === "openai-responses") {
    if (typeof data.output_text === "string") return data.output_text;
    if (Array.isArray(data.output)) {
      const pieces: string[] = [];
      for (const item of data.output) {
        if (Array.isArray(item?.content)) {
          for (const part of item.content) {
            if (typeof part?.text === "string") pieces.push(part.text);
          }
        }
      }
      return pieces.join("");
    }
    return "";
  }
  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export function parseDigestJson(raw: string): DigestLlmResult {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = (fenced ? fenced[1] : trimmed).trim();
  if (!candidate.startsWith("{")) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      candidate = candidate.slice(start, end + 1);
    }
  }
  const parsed = JSON.parse(candidate) as {
    overallSummary?: unknown;
    topics?: unknown;
  };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.topics)) {
    throw new Error("Digest response JSON missing topics array.");
  }
  return {
    ...(typeof parsed.overallSummary === "string"
      ? { overallSummary: parsed.overallSummary }
      : {}),
    topics: parsed.topics.filter(
      (entry): entry is RawDigestTopicOutput =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry))
    )
  };
}

/** Single-shot stateless LLM call for incremental conversation requirement digesting. */
export async function callDigestLlm(input: {
  resolved: ResolvedDigestProvider;
  conversationTitle: string;
  existingOverallSummary?: string;
  existingTopics: ConversationTopic[];
  newTurns: DigestTurnInput[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DigestLlmResult> {
  const { resolved, signal, fetchImpl = fetch } = input;
  const { systemPrompt, userPrompt } = buildDigestPrompts({
    conversationTitle: input.conversationTitle,
    existingOverallSummary: input.existingOverallSummary,
    existingTopics: input.existingTopics,
    newTurns: input.newTurns
  });

  const attempts = buildEndpointAttempts(resolved);
  if (attempts.length === 0) {
    throw new Error("Digest upstream URL is empty.");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i];
      const hasMoreAttempts = i < attempts.length - 1;
      const { headers, body } = buildRequest(
        attempt.protocol,
        resolved.apiKey,
        resolved.model,
        systemPrompt,
        userPrompt
      );
      const res = await fetchImpl(attempt.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const rawDetail = await res.text().catch(() => "");
        if (
          (res.status === 404 || res.status === 405) &&
          hasMoreAttempts &&
          !(res.status === 404 && isModelNotFound404(rawDetail))
        ) {
          continue;
        }
        throw new Error(formatUpstreamHttpError(res.status, rawDetail));
      }
      const json = await res.json();
      const rawText = extractTextFromResponse(attempt.protocol, json);
      if (!rawText.trim()) {
        throw new Error("Digest upstream returned empty text.");
      }
      return parseDigestJson(rawText);
    }
    throw new Error("Digest upstream request exhausted all endpoint attempts.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

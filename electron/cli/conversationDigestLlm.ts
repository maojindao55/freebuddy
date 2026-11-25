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
const LLM_IDLE_TIMEOUT_MS = 60_000;
const LLM_TOTAL_TIMEOUT_MS = 120_000;
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

let timeoutMsOverride: number | null = null;

export function setDigestTimeoutMsForTest(ms: number | null): void {
  timeoutMsOverride =
    typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : null;
}

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

function resolveAnthropicMaxTokens(
  provider: ProviderRecord,
  modelId: string
): number {
  const matched = provider.models.find((m) => m.id === modelId);
  const configured = matched?.maxTokens;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(1024, Math.floor(configured)), ANTHROPIC_DEFAULT_MAX_TOKENS);
  }
  return ANTHROPIC_DEFAULT_MAX_TOKENS;
}

function buildRequest(
  provider: ProviderRecord,
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
      max_tokens: resolveAnthropicMaxTokens(provider, model),
      temperature: 0.1,
      stream: true,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    };
  } else if (protocol === "openai-responses") {
    body = {
      model,
      instructions: systemPrompt,
      input: userPrompt,
      stream: true
    };
  } else {
    body = {
      model,
      temperature: 0.1,
      stream: true,
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

function formatSseError(payload: any): string {
  const errObj = payload?.error ?? payload;
  const msg =
    typeof errObj?.message === "string"
      ? errObj.message
      : typeof errObj === "string"
        ? errObj
        : JSON.stringify(errObj ?? {});
  const clean = msg.replace(/\s+/g, " ").trim().slice(0, 180);
  return clean ? `Digest upstream error: ${clean}` : "Digest upstream stream error.";
}

function createSseAccumulator(protocol: ProviderProtocol) {
  const chunks: string[] = [];
  let fallbackText = "";
  let finishReason: string | undefined;

  const consumeEventData = (rawData: string) => {
    const trimmed = rawData.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.error || parsed.type === "error") {
      throw new Error(formatSseError(parsed));
    }

    if (protocol === "anthropic") {
      if (
        parsed.type === "content_block_delta" &&
        typeof parsed.delta?.text === "string" &&
        parsed.delta?.type !== "thinking_delta"
      ) {
        chunks.push(parsed.delta.text);
      } else if (
        parsed.type === "message_delta" &&
        typeof parsed.delta?.stop_reason === "string"
      ) {
        finishReason = parsed.delta.stop_reason;
      } else if (parsed.type === "message_stop" && chunks.length === 0 && parsed.message) {
        const msgText = extractTextFromResponse("anthropic", parsed.message);
        if (msgText) fallbackText = msgText;
      }
      return;
    }

    if (protocol === "openai-responses") {
      if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
        chunks.push(parsed.delta);
      } else if (
        parsed.type === "response.output_text.done" &&
        chunks.length === 0 &&
        typeof parsed.text === "string"
      ) {
        fallbackText = parsed.text;
      } else if (
        (parsed.type === "response.completed" || parsed.type === "response.incomplete") &&
        parsed.response
      ) {
        const completed = extractTextFromResponse("openai-responses", parsed.response);
        if (completed) fallbackText = completed;
        if (typeof parsed.response?.incomplete_details?.reason === "string") {
          finishReason = parsed.response.incomplete_details.reason;
        }
      } else if (parsed.type === "response.failed") {
        throw new Error(formatSseError(parsed.response ?? parsed));
      }
      return;
    }

    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const deltaContent = choice?.delta?.content;
    if (typeof deltaContent === "string") {
      chunks.push(deltaContent);
    } else if (Array.isArray(deltaContent)) {
      for (const part of deltaContent) {
        if (typeof part?.text === "string") chunks.push(part.text);
      }
    } else if (chunks.length === 0) {
      const msgText = extractTextFromResponse(protocol, parsed);
      if (msgText) fallbackText = msgText;
    }
  };

  let lineBuffer = "";
  let eventDataLines: string[] = [];

  const flushEvent = () => {
    if (eventDataLines.length === 0) return;
    const joined = eventDataLines.join("\n");
    eventDataLines = [];
    consumeEventData(joined);
  };

  const pushText = (chunkText: string, flush = false) => {
    lineBuffer += chunkText;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim() === "") {
        flushEvent();
      } else if (line.startsWith("data:")) {
        eventDataLines.push(line.slice(5).trimStart());
      }
    }
    if (flush) {
      if (lineBuffer.startsWith("data:")) {
        eventDataLines.push(lineBuffer.slice(5).trimStart());
      }
      lineBuffer = "";
      flushEvent();
    }
  };

  return {
    pushText,
    result(): { text: string; finishReason?: string } {
      return {
        text: chunks.length > 0 ? chunks.join("") : fallbackText,
        finishReason
      };
    }
  };
}

async function readResponseText(
  res: Response,
  protocol: ProviderProtocol,
  resetIdleTimeout: () => void
): Promise<{ text: string; finishReason?: string }> {
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    const acc = createSseAccumulator(protocol);
    if (!res.body) {
      const text = await res.text();
      resetIdleTimeout();
      acc.pushText(text, true);
      return acc.result();
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdleTimeout();
        if (value && value.byteLength > 0) {
          acc.pushText(decoder.decode(value, { stream: true }), false);
        }
      }
      const tail = decoder.decode();
      acc.pushText(tail, true);
    } finally {
      reader.releaseLock();
    }
    return acc.result();
  }

  const rawBody = await res.text();
  resetIdleTimeout();
  const trimmedStart = rawBody.trimStart();
  if (trimmedStart.startsWith("data:") || trimmedStart.startsWith("event:")) {
    const acc = createSseAccumulator(protocol);
    acc.pushText(rawBody, true);
    return acc.result();
  }
  const json = JSON.parse(rawBody);
  const finishReason =
    json?.choices?.[0]?.finish_reason ??
    json?.incomplete_details?.reason ??
    json?.stop_reason;
  return {
    text: extractTextFromResponse(protocol, json),
    ...(typeof finishReason === "string" && finishReason ? { finishReason } : {})
  };
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
  if (signal?.aborted) {
    const abortErr = new Error("Digest aborted");
    abortErr.name = "AbortError";
    throw abortErr;
  }

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

  const idleMs = timeoutMsOverride ?? LLM_IDLE_TIMEOUT_MS;
  const totalMs = timeoutMsOverride
    ? Math.max(timeoutMsOverride * 2, timeoutMsOverride)
    : LLM_TOTAL_TIMEOUT_MS;
  const startedAt = Date.now();
  const ctrl = new AbortController();
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const resetIdleTimeout = () => {
    clearIdle();
    if (ctrl.signal.aborted) return;
    idleTimer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, idleMs);
    idleTimer.unref?.();
  };
  const totalTimer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, totalMs);
  totalTimer.unref?.();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  resetIdleTimeout();

  try {
    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i];
      const hasMoreAttempts = i < attempts.length - 1;
      const { headers, body } = buildRequest(
        resolved.provider,
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
      resetIdleTimeout();
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
      const { text: rawText, finishReason } = await readResponseText(
        res,
        attempt.protocol,
        resetIdleTimeout
      );
      if (!rawText.trim()) {
        if (hasMoreAttempts) {
          continue;
        }
        if (finishReason === "length" || finishReason === "max_output_tokens") {
          throw new Error(
            `Digest upstream truncated output before completing JSON (finish_reason=${finishReason}).`
          );
        }
        throw new Error("Digest upstream returned empty text.");
      }
      try {
        return parseDigestJson(rawText);
      } catch (parseErr) {
        if (hasMoreAttempts && !rawText.includes("{")) {
          continue;
        }
        throw parseErr;
      }
    }
    throw new Error("Digest upstream request exhausted all endpoint attempts.");
  } catch (err) {
    if (signal?.aborted) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      const abortErr = new Error("Digest aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    if (timedOut) {
      const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      throw new Error(`Digest upstream timed out after ${elapsedSec}s.`);
    }
    throw err;
  } finally {
    clearIdle();
    clearTimeout(totalTimer);
    signal?.removeEventListener("abort", onAbort);
  }
}

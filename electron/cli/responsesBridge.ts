/**
 * Local Responses ↔ chat/completions protocol bridge for Codex BYOK.
 *
 * codex >= 0.146 removed `wire_api = "chat"` from ModelProviderInfo, so the
 * codex binary only speaks the OpenAI Responses API. Most third-party BYOK
 * providers (DeepSeek, Kimi, …) only serve `POST /chat/completions`. codex-acp
 * cannot translate (model HTTP calls are made by the codex binary itself), so
 * FreeBuddy hosts this tiny localhost bridge instead:
 *
 *   codex --wire_api responses --> bridge (/v1/<route>/responses)
 *     --> upstream provider (/chat/completions)
 *
 * `resolveCodexByokEnv` points `model_providers.<id>.base_url` at the bridge
 * route when the saved BYOK config selects `wireApi: "chat"`. The bridge is
 * stateless: API keys are forwarded from the inbound request headers.
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

type JsonObject = Record<string, unknown>;

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_ROUTES = 64;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

export function normalizeUpstreamBaseUrl(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Responses API request → chat/completions request
// ---------------------------------------------------------------------------

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<JsonObject> | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

function responsesContentToChatContent(
  content: unknown
): string | Array<JsonObject> {
  if (typeof content === "string") return content;
  const parts: Array<JsonObject> = [];
  for (const raw of asArray(content)) {
    const part = asObject(raw);
    if (!part) {
      if (typeof raw === "string" && raw) {
        parts.push({ type: "text", text: raw });
      }
      continue;
    }
    const text = typeof part.text === "string" ? part.text : undefined;
    if (
      (part.type === "input_text" ||
        part.type === "output_text" ||
        part.type === "text" ||
        part.type === "summary_text") &&
      text !== undefined
    ) {
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (part.type === "input_image" || part.type === "image_url") {
      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : asObject(part.image_url)?.url;
      if (typeof url === "string" && url) {
        parts.push({ type: "image_url", image_url: { url } });
      }
      continue;
    }
    if (text !== undefined && text) {
      parts.push({ type: "text", text });
    }
  }
  if (parts.length === 1 && parts[0].type === "text") {
    return String(parts[0].text);
  }
  return parts;
}

export function responsesInputToChatMessages(
  body: JsonObject
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  let items: unknown[];
  if (typeof body.input === "string") {
    items = [
      { type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }
    ];
  } else if (Array.isArray(body.input)) {
    items = body.input;
  } else {
    items = [];
  }

  let pendingToolCalls: ChatToolCall[] = [];
  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls
    });
    pendingToolCalls = [];
  };

  for (const raw of items) {
    const item = asObject(raw);
    if (!item) continue;
    if (item.type === "function_call") {
      const args =
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {});
      pendingToolCalls.push({
        id: typeof item.call_id === "string" && item.call_id
          ? item.call_id
          : genId("call"),
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "",
          arguments: args
        }
      });
      continue;
    }
    if (item.type === "function_call_output") {
      flushToolCalls();
      const output =
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? "");
      messages.push({
        role: "tool",
        tool_call_id:
          typeof item.call_id === "string" ? item.call_id : "",
        content: output
      });
      continue;
    }
    if (item.type === "reasoning") {
      continue;
    }
    if (item.type === "message" || (item.type === undefined && typeof item.role === "string")) {
      flushToolCalls();
      const role =
        item.role === "developer"
          ? "system"
          : item.role === "assistant"
            ? "assistant"
            : item.role === "system"
              ? "system"
              : "user";
      messages.push({
        role,
        content: responsesContentToChatContent(item.content)
      });
      continue;
    }
  }
  flushToolCalls();
  return messages;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: unknown;
    parameters?: unknown;
    strict?: unknown;
  };
}

export function responsesToolsToChatTools(
  tools: unknown
): { tools: ChatTool[]; customToolNames: string[] } {
  const out: ChatTool[] = [];
  const customToolNames: string[] = [];
  for (const raw of asArray(tools)) {
    const tool = asObject(raw);
    if (!tool) continue;
    if (tool.type === "function") {
      if (typeof tool.name !== "string" || !tool.name) continue;
      out.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.strict !== undefined ? { strict: tool.strict } : {})
        }
      });
      continue;
    }
    // Responses "custom" (freeform) tools have no chat equivalent. Map them to
    // a single-string function and unwrap `{"input": …}` on the way back so
    // apply_patch keeps working through chat-only providers.
    if (tool.type === "custom" && typeof tool.name === "string" && tool.name) {
      customToolNames.push(tool.name);
      out.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"]
          }
        }
      });
    }
  }
  return { tools: out, customToolNames };
}

export function mapToolChoice(
  toolChoice: unknown
): unknown {
  if (typeof toolChoice === "string") return toolChoice;
  const obj = asObject(toolChoice);
  if (obj?.type === "function" && typeof obj.name === "string") {
    return { type: "function", function: { name: obj.name } };
  }
  return undefined;
}

export interface ResponsesToChatResult {
  chat: JsonObject;
  customToolNames: string[];
  stream: boolean;
}

export function translateResponsesRequestToChat(
  body: unknown
): ResponsesToChatResult | undefined {
  const obj = asObject(body);
  if (!obj || typeof obj.model !== "string" || !obj.model) return undefined;

  const messages = responsesInputToChatMessages(obj);
  const { tools, customToolNames } = responsesToolsToChatTools(obj.tools);

  const chat: JsonObject = {
    model: obj.model,
    messages,
    stream: obj.stream !== false
  };
  if (tools.length) chat.tools = tools;
  const toolChoice = mapToolChoice(obj.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  if (typeof obj.parallel_tool_calls === "boolean") {
    chat.parallel_tool_calls = obj.parallel_tool_calls;
  }
  if (num(obj.temperature) !== undefined) chat.temperature = obj.temperature;
  if (num(obj.top_p) !== undefined) chat.top_p = obj.top_p;
  const maxOutputTokens = num(obj.max_output_tokens);
  if (maxOutputTokens !== undefined && maxOutputTokens > 0) {
    chat.max_tokens = Math.floor(maxOutputTokens);
  }
  const reasoning = asObject(obj.reasoning);
  const effort = reasoning?.effort;
  if (typeof effort === "string" && ["low", "medium", "high"].includes(effort)) {
    chat.reasoning_effort = effort;
  }
  if (chat.stream === true) {
    chat.stream_options = { include_usage: true };
  }
  return { chat, customToolNames, stream: chat.stream === true };
}

/** Best-effort fallback when a provider rejects optional chat extensions. */
export function stripOptionalChatFields(chat: JsonObject): JsonObject {
  const stripped: JsonObject = { ...chat };
  delete stripped.reasoning_effort;
  delete stripped.stream_options;
  delete stripped.parallel_tool_calls;
  if (Array.isArray(stripped.tools)) {
    stripped.tools = (stripped.tools as unknown[]).map((raw) => {
      const tool = asObject(raw);
      const fn = asObject(tool?.function);
      if (!tool || !fn) return raw;
      const { strict: _strict, ...restFn } = fn;
      return { ...tool, function: restFn };
    });
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// chat/completions SSE → Responses API SSE
// ---------------------------------------------------------------------------

export function normalizeResponsesUsage(usage: unknown): JsonObject {
  const obj = asObject(usage);
  const prompt = num(asObject(obj?.prompt_tokens_details)?.cached_tokens) ?? 0;
  const reasoning =
    num(asObject(obj?.completion_tokens_details)?.reasoning_tokens) ?? 0;
  const input = num(obj?.prompt_tokens) ?? 0;
  const output = num(obj?.completion_tokens) ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: prompt },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: num(obj?.total_tokens) ?? input + output
  };
}

function serializeSse(event: JsonObject): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export class ChatToResponsesStream {
  readonly responseId = genId("resp");
  private readonly model: string;
  private readonly customToolNames: Set<string>;
  private outputIndex = 0;
  private usage: JsonObject | undefined;
  private finished = false;

  private reasoning: { id: string; text: string } | null = null;
  private message: { id: string; text: string } | null = null;
  private upstreamError: string | undefined;
  private readonly toolCalls = new Map<
    number,
    { id?: string; name?: string; arguments: string }
  >();

  constructor(model: string, customToolNames: string[] = []) {
    this.model = model;
    this.customToolNames = new Set(customToolNames);
  }

  hasUpstreamError(): boolean {
    return this.upstreamError !== undefined;
  }

  /** Stream-level provider error (`data: {"error": …}` before/instead of chunks). */
  getUpstreamError(): string | undefined {
    return this.upstreamError;
  }

  begin(): string[] {
    return [
      serializeSse({
        type: "response.created",
        response: {
          id: this.responseId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model: this.model,
          status: "in_progress",
          output: [],
          usage: null
        }
      })
    ];
  }

  handleChatChunk(chunk: unknown): string[] {
    if (this.finished) return [];
    const events: string[] = [];
    const obj = asObject(chunk);
    if (asObject(obj?.usage)) {
      this.usage = normalizeResponsesUsage(obj?.usage);
    }
    if (obj && !asArray(obj.choices).length) {
      const message = extractUpstreamErrorMessage(obj);
      if (message !== undefined && this.upstreamError === undefined) {
        this.upstreamError = message;
      }
      return events;
    }
    const choice = asObject(asArray(obj?.choices)[0]);
    const delta = asObject(choice?.delta);
    if (!delta) return events;

    const reasoningDelta =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (reasoningDelta) {
      events.push(...this.pushReasoningDelta(reasoningDelta));
    }

    if (typeof delta.content === "string" && delta.content) {
      events.push(...this.pushTextDelta(delta.content));
    } else if (Array.isArray(delta.content)) {
      for (const raw of delta.content) {
        const text = asObject(raw)?.text;
        if (typeof text === "string" && text) {
          events.push(...this.pushTextDelta(text));
        }
      }
    }

    for (const raw of asArray(delta.tool_calls)) {
      const call = asObject(raw);
      if (!call) continue;
      const index =
        num(call.index) ?? (this.toolCalls.size ? Math.max(...this.toolCalls.keys()) + 1 : 0);
      const entry = this.toolCalls.get(index) ?? { arguments: "" };
      if (typeof call.id === "string" && call.id) entry.id = call.id;
      const fn = asObject(call.function);
      if (typeof fn?.name === "string" && fn.name) {
        entry.name =
          entry.name === undefined ? fn.name : entry.name + fn.name;
      }
      if (typeof fn?.arguments === "string" && fn.arguments) {
        entry.arguments += fn.arguments;
      }
      this.toolCalls.set(index, entry);
    }
    return events;
  }

  finish(): string[] {
    if (this.finished) return [];
    this.finished = true;
    const events: string[] = [];
    events.push(...this.closeReasoning());
    events.push(...this.closeMessage());
    const sorted = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, call] of sorted) {
      if (!call.name) continue;
      const itemId = genId("fc");
      const callId = call.id ?? genId("call");
      const args = this.unwrapCustomArguments(call.name, call.arguments);
      const item = {
        id: itemId,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: call.name,
        arguments: args
      };
      events.push(
        serializeSse({
          type: "response.output_item.added",
          output_index: this.outputIndex,
          item: { ...item, status: "in_progress" }
        })
      );
      events.push(
        serializeSse({
          type: "response.output_item.done",
          output_index: this.outputIndex,
          item
        })
      );
      this.outputIndex += 1;
    }
    events.push(
      serializeSse({
        type: "response.completed",
        response: {
          id: this.responseId,
          object: "response",
          model: this.model,
          status: "completed",
          output: [],
          usage: this.usage ?? {
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 0
          }
        }
      }),
      "data: [DONE]\n\n"
    );
    return events;
  }

  fail(message: string): string[] {
    this.finished = true;
    return [
      serializeSse({
        type: "response.failed",
        response: {
          id: this.responseId,
          object: "response",
          model: this.model,
          status: "failed",
          error: { code: "upstream_error", message }
        }
      }),
      "data: [DONE]\n\n"
    ];
  }

  private pushReasoningDelta(text: string): string[] {
    if (!this.reasoning) {
      this.reasoning = { id: genId("rs"), text: "" };
      return [
        serializeSse({
          type: "response.output_item.added",
          output_index: this.outputIndex,
          item: {
            id: this.reasoning.id,
            type: "reasoning",
            summary: [],
            content: null,
            status: "in_progress"
          }
        }),
        serializeSse({
          type: "response.reasoning_summary_text.delta",
          item_id: this.reasoning.id,
          output_index: this.outputIndex,
          summary_index: 0,
          delta: text
        })
      ];
    }
    return [
      serializeSse({
        type: "response.reasoning_summary_text.delta",
        item_id: this.reasoning.id,
        output_index: this.outputIndex,
        summary_index: 0,
        delta: text
      })
    ];
  }

  private closeReasoning(): string[] {
    if (!this.reasoning) return [];
    const { id, text } = this.reasoning;
    this.reasoning = null;
    const done = [
      serializeSse({
        type: "response.output_item.done",
        output_index: this.outputIndex,
        item: {
          id,
          type: "reasoning",
          summary: [{ type: "summary_text", text }],
          content: null,
          status: "completed"
        }
      })
    ];
    this.outputIndex += 1;
    return done;
  }

  private pushTextDelta(text: string): string[] {
    const events: string[] = [];
    if (this.reasoning) events.push(...this.closeReasoning());
    if (!this.message) {
      this.message = { id: genId("msg"), text: "" };
      events.push(
        serializeSse({
          type: "response.output_item.added",
          output_index: this.outputIndex,
          item: {
            id: this.message.id,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: []
          }
        })
      );
    }
    this.message.text += text;
    events.push(
      serializeSse({
        type: "response.output_text.delta",
        item_id: this.message.id,
        output_index: this.outputIndex,
        content_index: 0,
        delta: text
      })
    );
    return events;
  }

  private closeMessage(): string[] {
    if (!this.message) return [];
    const { id, text } = this.message;
    this.message = null;
    const done = [
      serializeSse({
        type: "response.output_text.done",
        item_id: id,
        output_index: this.outputIndex,
        content_index: 0,
        text
      }),
      serializeSse({
        type: "response.output_item.done",
        output_index: this.outputIndex,
        item: {
          id,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }]
        }
      })
    ];
    this.outputIndex += 1;
    return done;
  }

  private unwrapCustomArguments(name: string, args: string): string {
    if (!this.customToolNames.has(name)) return args;
    try {
      const parsed = JSON.parse(args);
      if (
        asObject(parsed) &&
        Object.keys(parsed as JsonObject).length === 1 &&
        typeof (parsed as JsonObject).input === "string"
      ) {
        return (parsed as JsonObject).input as string;
      }
    } catch {
      /* keep raw arguments */
    }
    return args;
  }
}

/** Non-stream chat JSON → Responses response object. */
export function translateChatResponseToResponses(
  chat: unknown,
  fallbackModel?: string
): JsonObject | undefined {
  const obj = asObject(chat);
  const choice = asObject(asArray(obj?.choices)[0]);
  const message = asObject(choice?.message);
  if (!obj || !message) return undefined;

  const output: JsonObject[] = [];
  const reasoning = message.reasoning_content ?? message.reasoning;
  if (typeof reasoning === "string" && reasoning) {
    output.push({
      id: genId("rs"),
      type: "reasoning",
      summary: [{ type: "summary_text", text: reasoning }],
      content: null,
      status: "completed"
    });
  }
  if (typeof message.content === "string" && message.content) {
    output.push({
      id: genId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", text: message.content, annotations: [] }
      ]
    });
  }
  for (const raw of asArray(message.tool_calls)) {
    const call = asObject(raw);
    const fn = asObject(call?.function);
    if (!call || !fn || typeof fn.name !== "string") continue;
    output.push({
      id: genId("fc"),
      type: "function_call",
      status: "completed",
      call_id: typeof call.id === "string" ? call.id : genId("call"),
      name: fn.name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : ""
    });
  }

  return {
    id: typeof obj.id === "string" ? obj.id : genId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: typeof obj.model === "string" ? obj.model : fallbackModel,
    status: "completed",
    output,
    usage: normalizeResponsesUsage(obj.usage)
  };
}

// ---------------------------------------------------------------------------
// Incremental SSE parser (upstream side)
// ---------------------------------------------------------------------------

export interface SseFrame {
  event?: string;
  data: string;
}

export class SseParser {
  private buffer = "";

  push(text: string): SseFrame[] {
    this.buffer += text;
    const frames: SseFrame[] = [];
    for (;;) {
      const boundary = SseParser.findBoundary(this.buffer);
      if (boundary === -1) break;
      const raw = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const frame = SseParser.parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  flush(): SseFrame[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const frame = SseParser.parseFrame(this.buffer);
    this.buffer = "";
    return frame ? [frame] : [];
  }

  private static findBoundary(
    buffer: string
  ): { index: number; length: number } | -1 {
    const lf = buffer.indexOf("\n\n");
    const crlf = buffer.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return -1;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) {
      return { index: crlf, length: 4 };
    }
    return { index: lf, length: 2 };
  }

  private static parseFrame(raw: string): SseFrame | undefined {
    let data: string | undefined;
    let event: string | undefined;
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        const value = line.slice(5).trimStart();
        data = data === undefined ? value : `${data}\n${value}`;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      }
    }
    if (data === undefined) return undefined;
    return { event, data };
  }
}

// ---------------------------------------------------------------------------
// Local HTTP server
// ---------------------------------------------------------------------------

interface BridgeState {
  server: http.Server;
  port: number;
  routes: Map<string, BridgeRoute>;
}

let bridgeState: BridgeState | undefined;
let bridgeStarting: Promise<number | undefined> | undefined;

export function isResponsesBridgeRunning(): boolean {
  return bridgeState !== undefined;
}

export function getResponsesBridgePort(): number | undefined {
  return bridgeState?.port;
}

export interface BridgeRoute {
  /** Normalized provider base URL, e.g. https://cli.example.com */
  base: string;
  /** Chat endpoint path under base; auto-upgraded to /v1/… for gateways. */
  chatPath: string;
}

export function registerCodexChatBridgeRoute(
  upstreamBaseUrl: string
): { port: number; routeId: string } | undefined {
  const base = normalizeUpstreamBaseUrl(upstreamBaseUrl);
  if (!base || !bridgeState) return undefined;
  const routeId = `chat${crypto
    .createHash("sha256")
    .update(base)
    .digest("hex")
    .slice(0, 12)}`;
  if (!bridgeState.routes.has(routeId) && bridgeState.routes.size >= MAX_ROUTES) {
    const oldest = bridgeState.routes.keys().next().value;
    if (oldest !== undefined) bridgeState.routes.delete(oldest);
  }
  const existing = bridgeState.routes.get(routeId);
  bridgeState.routes.set(routeId, existing ?? { base, chatPath: "/chat/completions" });
  return { port: bridgeState.port, routeId };
}

export function startResponsesBridge(): Promise<number | undefined> {
  if (bridgeState) return Promise.resolve(bridgeState.port);
  if (bridgeStarting) return bridgeStarting;
  const starting: Promise<number | undefined> = new Promise((resolve) => {
    let settled = false;
    const done = (value: number | undefined) => {
      if (settled) return;
      settled = true;
      if (bridgeStarting === starting) bridgeStarting = undefined;
      resolve(value);
    };
    const routes = new Map<string, BridgeRoute>();
    const server = http.createServer((req, res) => {
      void handleBridgeRequest(req, res, routes).catch(() => {
        try {
          res.destroy();
        } catch {
          /* socket already gone */
        }
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.timeout = 0;
    server.keepAliveTimeout = 65_000;
    server.on("error", () => done(undefined));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address !== null && typeof address === "object" ? address.port : undefined;
      if (!port) {
        server.close();
        done(undefined);
        return;
      }
      bridgeState = { server, port, routes };
      done(port);
    });
  });
  bridgeStarting = starting;
  return starting;
}

export function closeResponsesBridge(): Promise<void> {
  const state = bridgeState;
  bridgeState = undefined;
  bridgeStarting = undefined;
  if (!state) return Promise.resolve();
  const server = state.server as http.Server & {
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
  };
  // Tear connections down before close(): on Windows libuv asserts when
  // keep-alive sockets outlive a closing server handle.
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  if (res.destroyed || res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function handleBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Map<string, BridgeRoute>
): Promise<void> {
  res.on("error", () => {});
  req.on("error", () => {});
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/v1/healthz")) {
    sendJson(res, 200, { ok: true, routes: routes.size });
    return;
  }

  const match =
    req.method === "POST"
      ? /^\/v1\/([A-Za-z0-9]+)\/responses$/.exec(url.pathname)
      : null;
  if (!match) {
    sendJson(res, 404, { error: { message: "unknown bridge endpoint" } });
    return;
  }
  const route = routes.get(match[1]);
  if (!route) {
    sendJson(res, 404, {
      error: { message: "unknown bridge route (BYOK provider not registered)" }
    });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    sendJson(res, 413, {
      error: { message: `bridge read failed: ${(error as Error).message}` }
    });
    return;
  }

  let responsesBody: unknown;
  try {
    responsesBody = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { error: { message: "invalid JSON body" } });
    return;
  }

  const translated = translateResponsesRequestToChat(responsesBody);
  if (!translated) {
    sendJson(res, 400, {
      error: { message: "unsupported Responses request (missing model)" }
    });
    return;
  }

  const authorization = req.headers.authorization;
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const requestModel =
    typeof asObject(responsesBody)?.model === "string"
      ? (asObject(responsesBody)?.model as string)
      : undefined;

  let upstream: IncomingMessage;
  try {
    upstream = await requestChatCompletions(
      route,
      translated.chat,
      authorization,
      controller.signal
    );
  } catch (error) {
    sendJson(res, 502, {
      error: { message: `bridge upstream failed: ${(error as Error).message}` }
    });
    return;
  }

  // Some relay gateways host their API under /v1 while serving the web UI
  // (200 text/html) or a 404 at the bare /chat/completions path. Retry once
  // under /v1 and remember the working path on the route.
  let status = upstream.statusCode ?? 0;
  let contentType = String(upstream.headers["content-type"] ?? "");
  if (
    route.chatPath === "/chat/completions" &&
    !basePathHasVersionSegment(route.base) &&
    (status === 404 || (status < 400 && contentType.includes("text/html")))
  ) {
    upstream.resume();
    try {
      const fallback: BridgeRoute = {
        base: route.base,
        chatPath: "/v1/chat/completions"
      };
      const retried = await requestChatCompletions(
        fallback,
        translated.chat,
        authorization,
        controller.signal
      );
      const retriedStatus = retried.statusCode ?? 0;
      const retriedType = String(retried.headers["content-type"] ?? "");
      if (retriedStatus !== 404 && !(retriedStatus < 400 && retriedType.includes("text/html"))) {
        route.chatPath = "/v1/chat/completions";
        upstream = retried;
        status = retriedStatus;
        contentType = retriedType;
      } else {
        retried.resume();
      }
    } catch {
      /* keep the original response for error handling below */
    }
  }

  if (status >= 400) {
    const text = await readUpstreamBody(upstream);
    const stripped = stripOptionalChatFields(translated.chat);
    if (
      looksLikeUnknownFieldError(status, text) &&
      JSON.stringify(stripped) !== JSON.stringify(translated.chat)
    ) {
      try {
        upstream = await requestChatCompletions(
          route,
          stripped,
          authorization,
          controller.signal
        );
      } catch (error) {
        sendJson(res, 502, {
          error: {
            message: `bridge upstream failed: ${(error as Error).message}`
          }
        });
        return;
      }
      status = upstream.statusCode ?? 0;
      if (status >= 400) {
        sendJson(res, status, safeErrorBody(await readUpstreamBody(upstream)));
        return;
      }
    } else {
      sendJson(res, status, safeErrorBody(text));
      return;
    }
  }
  contentType = String(upstream.headers["content-type"] ?? "");

  if (translated.stream && contentType.includes("text/event-stream")) {
    await pipeUpstreamSse(upstream, res, translated, requestModel);
    return;
  }

  const bodyText = await readUpstreamBody(upstream);

  // A few gateways stream SSE but label it application/json; sniff it.
  if (translated.stream && bodyText.trimStart().startsWith("data:")) {
    writeSseHead(res);
    for (const event of synthesizeSseFromChatText(
      bodyText,
      requestModel ?? translated.chat.model as string,
      translated.customToolNames
    )) {
      res.write(event);
    }
    res.end();
    return;
  }

  const chatJson = parseJsonObject(bodyText);
  const upstreamError = chatJson
    ? extractUpstreamErrorMessage(chatJson)
    : undefined;
  if (!chatJson || upstreamError !== undefined || !asArray(chatJson.choices).length) {
    const message =
      upstreamError ??
      `bridge could not parse upstream chat response (status ${status}, content-type ${contentType || "unknown"}, body: ${bodySnippet(bodyText)})`;
    sendJson(res, 502, { error: { message } });
    return;
  }
  const responseObj = translateChatResponseToResponses(chatJson, requestModel);
  if (!responseObj) {
    sendJson(res, 502, {
      error: {
        message: `bridge could not parse upstream chat response (status ${status}, content-type ${contentType || "unknown"}, body: ${bodySnippet(bodyText)})`
      }
    });
    return;
  }
  if (translated.stream) {
    writeSseHead(res);
    for (const event of responsesObjectToSseEvents(responseObj)) {
      res.write(event);
    }
    res.end();
    return;
  }
  sendJson(res, 200, responseObj);
}

function basePathHasVersionSegment(base: string): boolean {
  try {
    const pathname = new URL(base).pathname.replace(/\/+$/, "");
    return /\/v\d+$/.test(pathname);
  } catch {
    return false;
  }
}

/** Replay a full chat SSE payload (possibly mislabeled) as Responses SSE events. */
function synthesizeSseFromChatText(
  text: string,
  model: string,
  customToolNames: string[]
): string[] {
  const stream = new ChatToResponsesStream(model, customToolNames);
  const parser = new SseParser();
  const events = [...stream.begin()];
  const feed = (frames: SseFrame[]) => {
    for (const frame of frames) {
      if (frame.data === "[DONE]") return;
      const chunk = parseJsonObject(frame.data);
      if (chunk) events.push(...stream.handleChatChunk(chunk));
    }
  };
  feed(parser.push(text));
  feed(parser.flush());
  if (stream.hasUpstreamError()) {
    return [...events, ...stream.fail(stream.getUpstreamError() ?? "upstream error")];
  }
  return [...events, ...stream.finish()];
}

function requestChatCompletions(
  route: BridgeRoute,
  chatBody: JsonObject,
  authorization: string | undefined,
  signal: AbortSignal
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(`${route.base}${route.chatPath}`);
    } catch (error) {
      reject(error as Error);
      return;
    }
    const transport = url.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(chatBody), "utf8");
    const request = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          accept: "text/event-stream, application/json",
          ...(authorization ? { authorization } : {})
        }
      },
      (response) => resolve(response)
    );
    request.on("error", reject);
    signal.addEventListener(
      "abort",
      () => request.destroy(new Error("client connection closed")),
      { once: true }
    );
    request.end(payload);
  });
}

function readUpstreamBody(upstream: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    upstream.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstream.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8"))
    );
    upstream.on("error", reject);
  });
}

async function pipeUpstreamSse(
  upstream: IncomingMessage,
  res: ServerResponse,
  translated: ResponsesToChatResult,
  requestModel: string | undefined
): Promise<void> {
  writeSseHead(res);
  const stream = new ChatToResponsesStream(
    requestModel ?? translated.chat.model as string,
    translated.customToolNames
  );
  for (const event of stream.begin()) res.write(event);

  const parser = new SseParser();
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, KEEPALIVE_INTERVAL_MS);

  const drainToClient = (text: string): boolean => {
    for (const frame of parser.push(text)) {
      if (frame.data === "[DONE]") return false;
      const chunk = parseJsonObject(frame.data);
      if (!chunk) continue;
      for (const event of stream.handleChatChunk(chunk)) {
        res.write(event);
      }
    }
    return true;
  };

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearInterval(keepalive);
      if (!res.writableEnded) {
        const failure = stream.getUpstreamError();
        const closing =
          failure !== undefined
            ? stream.fail(failure)
            : stream.finish();
        for (const event of closing) res.write(event);
        res.end();
      }
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(keepalive);
      if (!res.writableEnded) {
        for (const event of stream.fail(error.message)) res.write(event);
        res.end();
      }
      resolve();
    };

    upstream.setEncoding("utf8");
    upstream.on("data", (text: string) => {
      if (!drainToClient(text)) done();
    });
    upstream.on("end", () => {
      for (const frame of parser.flush()) {
        if (frame.data === "[DONE]") break;
        const chunk = parseJsonObject(frame.data);
        if (chunk) {
          for (const event of stream.handleChatChunk(chunk)) res.write(event);
        }
      }
      done();
    });
    upstream.on("error", (error: Error) => fail(error));
  });
}

function looksLikeUnknownFieldError(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /unknown|unrecognized|unexpected|unsupported|extra_forbidden|invalid_request/i.test(
    body
  );
}

/**
 * Pull a human-readable message out of standard and gateway-specific error
 * bodies: {"error":{"message":…}}, {"message":…}, {"msg":…}, {"detail":…}.
 */
function extractUpstreamErrorMessage(obj: JsonObject | undefined): string | undefined {
  if (!obj) return undefined;
  const err = asObject(obj.error);
  if (err) {
    if (typeof err.message === "string" && err.message) return err.message;
    return JSON.stringify(err).slice(0, 500);
  }
  for (const key of ["message", "msg", "detail"]) {
    const value = obj[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function bodySnippet(text: string, max = 300): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function safeErrorBody(text: string): unknown {
  const parsed = parseJsonObject(text);
  if (asObject(parsed?.error) || asObject(parsed)?.detail !== undefined) {
    return parsed;
  }
  return {
    error: { message: (text || "upstream request failed").slice(0, 2000) }
  };
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(text);
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as unknown as { flushHeaders: () => void }).flushHeaders();
  }
}

function responsesObjectToSseEvents(responseObj: JsonObject): string[] {
  const events: string[] = [];
  events.push(
    serializeSse({
      type: "response.created",
      response: { ...responseObj, status: "in_progress", output: [] }
    })
  );
  const output = asArray(responseObj.output);
  output.forEach((item, index) => {
    const obj = asObject(item);
    if (!obj) return;
    events.push(
      serializeSse({
        type: "response.output_item.added",
        output_index: index,
        item: { ...obj, status: "in_progress" }
      })
    );
    events.push(
      serializeSse({
        type: "response.output_item.done",
        output_index: index,
        item: obj
      })
    );
  });
  events.push(
    serializeSse({ type: "response.completed", response: responseObj }),
    "data: [DONE]\n\n"
  );
  return events;
}

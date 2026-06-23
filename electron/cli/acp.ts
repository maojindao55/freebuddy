export type AcpRequestId = number | string | null;

export interface AcpMessage {
  jsonrpc: "2.0";
  id?: AcpRequestId;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

/** An ACP authentication method advertised by an agent in `initialize`.
 *  FreeBuddy does not drive the auth flow; it only reads these to detect that
 *  authentication is required and surface a clear error. */
export interface AcpAuthMethod {
  id: string;
  type?: "agent" | "env_var" | "terminal";
  name?: string;
  description?: string;
}

export type AcpStreamItem =
  | {
      kind: "text";
      role: "assistant" | "user" | "system";
      content: string;
      append?: boolean;
    }
  | { kind: "thinking"; content: string; append?: boolean }
  | { kind: "tool-call"; tool: string; input?: unknown; id?: string }
  | {
      kind: "tool-result";
      tool: string;
      id?: string;
      content: string;
      isError?: boolean;
    }
  | { kind: "command"; command: string; cwd?: string }
  | {
      kind: "command-output";
      content: string;
      stream?: "stdout" | "stderr";
    }
  | {
      kind: "file-edit";
      path: string;
      action: "create" | "update" | "delete";
      patch?: string;
    }
  | { kind: "session"; sessionId: string; title?: string }
  | {
      kind: "plan";
      entries: {
        content: string;
        priority: "high" | "medium" | "low";
        status: "pending" | "in_progress" | "completed";
      }[];
    }
  | {
      kind: "usage";
      inputTokens?: number;
      outputTokens?: number;
      totalCost?: number;
      contextUsed?: number;
      contextSize?: number;
      costAmount?: number;
      costCurrency?: string;
    }
  | {
      kind: "content-block";
      blockType: "image" | "audio" | "resource_link" | "resource";
      mimeType?: string;
      data?: string;
      uri?: string;
      name?: string;
      title?: string;
      description?: string;
      size?: number;
      text?: string;
    }
  | { kind: "error"; message: string; details?: string[] }
  | { kind: "done"; exitCode?: number }
  | { kind: "raw"; content: string };

type AcpPlanEntry = Extract<AcpStreamItem, { kind: "plan" }>["entries"][number];

export function buildInitializeRequest(id: AcpRequestId): AcpMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        // Opt in to receive terminal-type auth methods so we can detect when
        // an agent requires authentication and surface a clear error. We do not
        // drive the login flow; the user logs in via the agent's own CLI.
        auth: { terminal: true }
      },
      clientInfo: {
        name: "freebuddy",
        title: "FreeBuddy",
        version: "0.1.0"
      }
    }
  };
}

export function buildSessionNewRequest(
  id: AcpRequestId,
  cwd?: string
): AcpMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/new",
    params: {
      cwd: cwd || process.cwd(),
      mcpServers: []
    }
  };
}

export function buildSessionResumeRequest(
  id: AcpRequestId,
  sessionId: string,
  cwd?: string
): AcpMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/resume",
    params: {
      sessionId,
      cwd: cwd || process.cwd(),
      mcpServers: []
    }
  };
}

export function buildSessionPromptRequest(
  id: AcpRequestId,
  sessionId: string,
  prompt: string
): AcpMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: prompt }]
    }
  };
}

export function buildSessionCancelNotification(sessionId: string): AcpMessage {
  return {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId }
  };
}

export function buildSessionCloseRequest(
  id: AcpRequestId,
  sessionId: string
): AcpMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/close",
    params: { sessionId }
  };
}

export function parseAcpLine(line: string): AcpMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.jsonrpc !== "2.0") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolOutputText(value: unknown): string {
  if (value == null || typeof value === "string") return stringifyValue(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const direct = record.output ?? record.content ?? record.text;
    if (direct != null) return stringifyValue(direct);
  }
  return stringifyValue(value);
}

function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (content?.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  if (typeof content?.text === "string") return content.text;
  return stringifyValue(content);
}

export type ContentBlockRole = "assistant" | "user" | "system";

export interface ContentBlockOptions {
  role?: ContentBlockRole;
  append?: boolean;
  asThinking?: boolean;
}

/** Map an ACP ContentBlock to normalized stream items. */
export function contentBlockToItems(
  block: any,
  options: ContentBlockOptions = {}
): AcpStreamItem[] {
  if (!block || typeof block !== "object") return [];
  const type = String(block.type ?? "");

  switch (type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      if (!text) return [];
      if (options.asThinking) {
        return [{ kind: "thinking", content: text, append: options.append }];
      }
      return [
        {
          kind: "text",
          role: options.role ?? "assistant",
          content: text,
          append: options.append
        }
      ];
    }
    case "image": {
      const data = typeof block.data === "string" ? block.data : "";
      if (!data) return [];
      return [
        {
          kind: "content-block",
          blockType: "image",
          data,
          mimeType:
            typeof block.mimeType === "string" ? block.mimeType : "image/png"
        }
      ];
    }
    case "audio": {
      const data = typeof block.data === "string" ? block.data : "";
      if (!data) return [];
      return [
        {
          kind: "content-block",
          blockType: "audio",
          data,
          mimeType:
            typeof block.mimeType === "string" ? block.mimeType : "audio/wav"
        }
      ];
    }
    case "resource_link": {
      const uri = typeof block.uri === "string" ? block.uri : "";
      if (!uri) return [];
      return [
        {
          kind: "content-block",
          blockType: "resource_link",
          uri,
          ...(typeof block.name === "string" ? { name: block.name } : {}),
          ...(typeof block.title === "string" ? { title: block.title } : {}),
          ...(typeof block.description === "string"
            ? { description: block.description }
            : {}),
          ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
          ...(typeof block.size === "number" ? { size: block.size } : {})
        }
      ];
    }
    case "resource": {
      const resource = block.resource;
      if (!resource || typeof resource !== "object") return [];
      const uri = typeof resource.uri === "string" ? resource.uri : undefined;
      const text = typeof resource.text === "string" ? resource.text : undefined;
      const data = typeof resource.blob === "string" ? resource.blob : undefined;
      if (!uri && !text && !data) return [];
      return [
        {
          kind: "content-block",
          blockType: "resource",
          ...(uri ? { uri } : {}),
          ...(text ? { text } : {}),
          ...(data ? { data } : {}),
          ...(typeof resource.mimeType === "string"
            ? { mimeType: resource.mimeType }
            : {})
        }
      ];
    }
    default:
      return [{ kind: "raw", content: stringifyValue(block) }];
  }
}

function toolCallContentToItems(entries: any[]): AcpStreamItem[] {
  const out: AcpStreamItem[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "content" && entry.content) {
      out.push(...contentBlockToItems(entry.content));
    }
  }
  return out;
}

function actionFromToolKind(kind: unknown): "create" | "update" | "delete" {
  return kind === "delete" ? "delete" : "update";
}

function num(update: any, key: string): number | undefined {
  const v = update?.[key];
  return typeof v === "number" ? v : undefined;
}

function planPriority(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "low" ? value : "medium";
}

function planStatus(
  value: unknown
): "pending" | "in_progress" | "completed" {
  return value === "in_progress" || value === "completed"
    ? value
    : "pending";
}

function planEntries(update: any): AcpPlanEntry[] {
  if (!Array.isArray(update?.entries)) return [];
  return normalizePlanEntries(update.entries);
}

function todoEntries(update: any): AcpPlanEntry[] {
  const todos =
    update?.rawInput?.todos ??
    update?.rawOutput?.metadata?.todos ??
    update?.rawOutput?.todos;
  return Array.isArray(todos) ? normalizePlanEntries(todos) : [];
}

function normalizePlanEntries(entries: any[]): AcpPlanEntry[] {
  return entries
    .map((entry: any) => ({
      content: typeof entry?.content === "string" ? entry.content.trim() : "",
      priority: planPriority(entry?.priority),
      status: planStatus(entry?.status)
    }))
    .filter((entry: AcpPlanEntry) => entry.content.length > 0);
}

export function acpUpdateToItems(
  update: any,
  fallbackSessionId?: string
): AcpStreamItem[] {
  const type = String(update?.sessionUpdate ?? "");
  switch (type) {
    case "user_message_chunk":
      return [];
    case "agent_message_chunk":
      return contentBlockToItems(update.content, {
        role: "assistant",
        append: true
      });
    case "agent_thought_chunk":
      return contentBlockToItems(update.content, {
        append: true,
        asThinking: true
      });
    case "tool_call": {
      const entries = todoEntries(update);
      if (entries.length) {
        return [{ kind: "plan", entries }];
      }
      return [
        {
          kind: "tool-call",
          id: update.toolCallId,
          tool: String(update.title ?? update.kind ?? "tool"),
          input: update.rawInput ?? update.content
        }
      ];
    }
    case "tool_call_update": {
      const entries = todoEntries(update);
      if (entries.length) {
        return [{ kind: "plan", entries }];
      }
      if (Array.isArray(update.content) && update.content.length) {
        const fromContent = toolCallContentToItems(update.content);
        if (fromContent.length) return fromContent;
      }
      if (update.kind === "execute" && update.rawInput?.command) {
        return [
          {
            kind: "command",
            command: String(update.rawInput.command),
            cwd: update.rawInput.cwd
          }
        ];
      }
      if (update.kind === "edit" && update.locations?.[0]?.path) {
        return [
          {
            kind: "file-edit",
            path: String(update.locations[0].path),
            action: actionFromToolKind(update.kind),
            patch: stringifyValue(update.rawOutput)
          }
        ];
      }
      return [
        {
          kind: "tool-result",
          id: update.toolCallId,
          tool: String(update.title ?? update.kind ?? "tool"),
          content: toolOutputText(update.rawOutput ?? update.content),
          ...(update.status === "failed" ? { isError: true } : {})
        }
      ];
    }
    case "session_info_update": {
      const sessionId = update.sessionId ?? fallbackSessionId;
      return sessionId
        ? [
            {
              kind: "session",
              sessionId: String(sessionId),
              title: update.title
            }
          ]
        : [];
    }
    case "usage_update":
      return [
        {
          kind: "usage",
          ...(num(update, "used") != null
            ? { contextUsed: num(update, "used") }
            : {}),
          ...(num(update, "size") != null
            ? { contextSize: num(update, "size") }
            : {}),
          ...(typeof update?.cost?.amount === "number"
            ? {
                costAmount: update.cost.amount,
                costCurrency: typeof update.cost.currency === "string" ? update.cost.currency : undefined
              }
            : {})
        }
      ];
    case "plan":
      return [
        {
          kind: "plan",
          entries: planEntries(update)
        }
      ];
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
      return [];
    default:
      return update ? [{ kind: "raw", content: stringifyValue(update) }] : [];
  }
}

export function shouldEmitAcpUpdate(
  _update: any,
  state: { promptStarted: boolean }
): boolean {
  return state.promptStarted;
}

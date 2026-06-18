export type AcpRequestId = number | string | null;

export interface AcpMessage {
  jsonrpc: "2.0";
  id?: AcpRequestId;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
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
      kind: "usage";
      inputTokens?: number;
      outputTokens?: number;
      totalCost?: number;
    }
  | { kind: "error"; message: string; details?: string[] }
  | { kind: "done"; exitCode?: number }
  | { kind: "raw"; content: string };

export function buildInitializeRequest(id: AcpRequestId): AcpMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
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

function actionFromToolKind(kind: unknown): "create" | "update" | "delete" {
  return kind === "delete" ? "delete" : "update";
}

function usageTokens(update: any, key: string): number | undefined {
  return update?.[key] ?? update?.usage?.[key] ?? update?.usage?.context?.[key];
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
      return [
        {
          kind: "text",
          role: "assistant",
          content: textFromContent(update.content),
          append: true
        }
      ];
    case "agent_thought_chunk":
      return [
        {
          kind: "thinking",
          content: textFromContent(update.content),
          append: true
        }
      ];
    case "tool_call":
      return [
        {
          kind: "tool-call",
          id: update.toolCallId,
          tool: String(update.title ?? update.kind ?? "tool"),
          input: update.rawInput ?? update.content
        }
      ];
    case "tool_call_update": {
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
          ...(usageTokens(update, "inputTokens") != null
            ? { inputTokens: usageTokens(update, "inputTokens") }
            : {}),
          ...(usageTokens(update, "outputTokens") != null
            ? { outputTokens: usageTokens(update, "outputTokens") }
            : {}),
          ...(usageTokens(update, "totalCost") != null
            ? { totalCost: usageTokens(update, "totalCost") }
            : {})
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

import type { CLIStreamMode } from "@/config/cliAdapters";

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "mode"
  | "other";

export type ToolCallStatus = "pending" | "running" | "completed" | "failed";

export type ToolOutputItem = Extract<
  CliStreamItem,
  | { kind: "content-block" }
  | { kind: "file-edit" }
  | { kind: "command" }
  | { kind: "command-output" }
  | { kind: "terminal-embed" }
>;

export type CliStreamItem =
  | {
      kind: "text";
      role: "assistant" | "user" | "system";
      content: string;
      append?: boolean;
    }
  | { kind: "thinking"; content: string; append?: boolean }
  | {
      kind: "tool-call";
      tool: string;
      input?: unknown;
      id?: string;
      status?: ToolCallStatus;
      toolKind?: ToolKind;
      locations?: { path: string; line?: number }[];
      output?: string;
      isError?: boolean;
      toolOutputs?: ToolOutputItem[];
      /** Internal merge hint: replace toolOutputs instead of appending. */
      replaceToolOutputs?: boolean;
    }
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
      oldText?: string;
      newText?: string;
    }
  | { kind: "terminal-embed"; terminalId: string }
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
      /** ACP usage_update: cumulative context tokens used. */
      contextUsed?: number;
      /** ACP usage_update: session context window size. */
      contextSize?: number;
      /** ACP usage_update: cumulative cost amount. */
      costAmount?: number;
      costCurrency?: string;
    }
  | {
      kind: "content-block";
      blockType: "image" | "audio" | "resource_link" | "resource";
      mimeType?: string;
      /** Base64 payload for image/audio or embedded blob resources. */
      data?: string;
      uri?: string;
      name?: string;
      title?: string;
      description?: string;
      size?: number;
      /** Text payload for embedded text resources. */
      text?: string;
    }
  | { kind: "error"; message: string; details?: string[] }
  | { kind: "done"; exitCode?: number }
  | { kind: "raw"; content: string };

export interface ParseContext {
  sessionId?: string;
  diagnosticLogs?: string[];
}

export interface AdapterStreamParser {
  parseStdoutLine(line: string, ctx: ParseContext): CliStreamItem[];
  parseStderrLine?(line: string, ctx: ParseContext): CliStreamItem[];
}

export function tryJson(line: string): any | undefined {
  const t = line.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export const rawParser: AdapterStreamParser = {
  parseStdoutLine(line) {
    return line ? [{ kind: "raw", content: line }] : [];
  }
};

const registry: Record<CLIStreamMode, AdapterStreamParser | undefined> = {
  "codex-json": undefined,
  "claude-json": undefined,
  "opencode-json": undefined,
  raw: rawParser
};

export function registerParser(
  mode: CLIStreamMode,
  parser: AdapterStreamParser
) {
  registry[mode] = parser;
}

export function getParser(mode: CLIStreamMode | string): AdapterStreamParser {
  return registry[mode as CLIStreamMode] ?? rawParser;
}

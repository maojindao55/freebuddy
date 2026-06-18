import type { CLIStreamMode } from "@/config/cliAdapters";

export type CliStreamItem =
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

export type CLIStreamMode =
  | "codex-json"
  | "claude-json"
  | "opencode-json"
  | "raw";

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

export type CliStreamItem =
  | {
      kind: "text";
      role: "assistant" | "user" | "system";
      content: string;
      append?: boolean;
      messageId?: string;
    }
  | { kind: "thinking"; content: string; append?: boolean; messageId?: string }
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
  | {
      kind: "terminal-embed";
      terminalId: string;
      output?: string;
      truncated?: boolean;
      exitCode?: number | null;
      exited?: boolean;
      running?: boolean;
    }
  | { kind: "session"; sessionId: string; title?: string; updatedAt?: string }
  | {
      kind: "available-commands";
      commands: {
        name: string;
        description?: string;
        inputHint?: string;
      }[];
    }
  | {
      kind: "config-options";
      options: {
        id: string;
        name?: string;
        category?: string;
        type?: string;
        currentValue?: string;
        currentLabel?: string;
        description?: string;
        values?: { id: string; name?: string }[];
      }[];
    }
  | {
      kind: "plan";
      entries: {
        content: string;
        priority: "high" | "medium" | "low";
        status: "pending" | "in_progress" | "completed" | "cancelled";
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
      cachedReadTokens?: number;
      cachedWriteTokens?: number;
      thoughtTokens?: number;
      totalTokens?: number;
      metrics?: {
        turns?: number;
        steps?: number;
        llmDurationMs?: number;
        avgTtftMs?: number;
        tokensPerSecond?: number;
        cacheHitRate?: number;
        uncachedInputTokens?: number;
        cachedReadTokens?: number;
        cachedWriteTokens?: number;
        outputTokens?: number;
        thoughtTokens?: number;
        totalTokens?: number;
        rawSummary?: string;
      };
    }
  | {
      kind: "content-block";
      blockType: "image" | "audio" | "resource_link" | "resource";
      mimeType?: string;
      data?: string;
      previewKey?: string;
      uri?: string;
      name?: string;
      title?: string;
      description?: string;
      size?: number;
      text?: string;
    }
  | { kind: "error"; message: string; details?: string[]; terminal?: boolean }
  | { kind: "done"; exitCode?: number }
  | { kind: "raw"; content: string };

export type ToolOutputItem = Extract<
  CliStreamItem,
  | { kind: "content-block" }
  | { kind: "file-edit" }
  | { kind: "command" }
  | { kind: "command-output" }
  | { kind: "terminal-embed" }
>;

export interface ParseContext {
  sessionId?: string;
  diagnosticLogs?: string[];
}

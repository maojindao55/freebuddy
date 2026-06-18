import type { CLIAdapterId } from "@/config/cliAdapters";

export interface CLIExecutorOverride {
  id: CLIAdapterId;
  baseAdapter?: CLIAdapterId;
  label?: string;
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  installHint?: string;
  docsUrl?: string;
  enabled?: boolean;
}

export interface CliRunArgs {
  sessionId: string;
  agentId: string;
  agentName: string;
  adapter: CLIAdapterId;
  binary?: string;
  extraArgs?: string[];
  prompt: string;
  cwd?: string;
  env?: Record<string, string>;
  approvalMode?: "auto" | "ask";
  showStderr?: boolean;
  resumeToolSession?: boolean;
  timeoutMs?: number;
}

export type CliEvent =
  | { type: "started"; pid: number }
  | { type: "stdout"; content: string }
  | { type: "stderr"; content: string }
  | { type: "done"; exitCode: number }
  | { type: "error"; message: string };

export interface CliCheckResult {
  installed: boolean;
  path?: string;
  version?: string;
}

export interface CliInstallResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CliRuntime {
  adapter: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  lastCheckAt?: string;
  lastRunAt?: string;
  lastError?: string;
  updatedAt: string;
}

export interface CliTaskRow {
  id: string;
  agentId: string;
  agentName: string;
  adapter: string;
  status: "running" | "done" | "failed" | "killed" | string;
  cwd?: string;
  prompt: string;
  promptSummary?: string;
  sessionId?: string;
  toolSessionId?: string;
  pid?: number;
  exitCode?: number;
  errorMessage?: string;
  logPath?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CliTaskLogEntry {
  ts: string;
  type: string;
  content: string;
}

export interface CliTaskLogPage {
  entries: CliTaskLogEntry[];
  total: number;
  truncated: boolean;
}

export interface CliTaskListArgs {
  agentId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ToolSessionRecord {
  key: string;
  agentId: string;
  workspacePath: string;
  adapter: string;
  sessionId: string;
  title?: string;
  updatedAt: string;
}

// ---- Conversations -------------------------------------------------------

export interface Conversation {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  cwd?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
}

export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus =
  | "sent"
  | "running"
  | "done"
  | "failed"
  | "killed"
  | string;

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  status: MessageStatus;
  /** For assistant messages: JSON-serialized CliStreamItem[]; for user: text. */
  content: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationInput {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  cwd?: string;
}

export interface ListConversationsArgs {
  archived?: boolean;
  agentId?: string;
  limit?: number;
}

export interface AppendMessageInput {
  id: string;
  conversationId: string;
  role: MessageRole;
  status: MessageStatus;
  content: string;
  taskId?: string;
}

export interface UpdateMessageInput {
  id: string;
  status?: MessageStatus;
  content?: string;
  taskId?: string;
}

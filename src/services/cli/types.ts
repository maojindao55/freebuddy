import type { CLIAdapterId } from "@/config/cliAdapters";
import type { CliStreamItem } from "./streamParser";

export interface CLIExecutorOverride {
  id: CLIAdapterId;
  baseAdapter?: CLIAdapterId;
  label?: string;
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  installHint?: string;
  docsUrl?: string;
  icon?: string;
  enabled?: boolean;
  codexByok?: CLICodexByokConfig;
  claudeByok?: CLIClaudeByokConfig;
}

export interface CLICodexByokConfig {
  enabled?: boolean;
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  envKey?: string;
  wireApi?: "responses";
  apiKey?: string;
  apiKeyPreview?: string;
}

export interface CLIClaudeByokConfig {
  enabled?: boolean;
  baseUrl?: string;
  envKey?: string;
  apiKey?: string;
  apiKeyPreview?: string;
}

export interface CliPromptAttachment {
  path: string;
  kind: "image" | "document" | "code";
  mimeType?: string;
  name?: string;
}

export interface CliRunArgs {
  sessionId: string;
  agentId: string;
  agentName: string;
  adapter: CLIAdapterId;
  binary?: string;
  extraArgs?: string[];
  prompt: string;
  promptAttachments?: CliPromptAttachment[];
  cwd?: string;
  /** Persistence key for tool-session resume. Defaults to cwd when omitted. */
  toolSessionScope?: string;
  /** Concrete CLI session/thread id to resume when available. */
  toolSessionId?: string;
  env?: Record<string, string>;
  approvalMode?: "auto" | "ask";
  showStderr?: boolean;
  resumeToolSession?: boolean;
  timeoutMs?: number;
  userMessageId?: string;
  knownStreamMessageIds?: string[];
}

export interface CliPermissionOption {
  optionId: string;
  name?: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface CliPermissionRequest {
  requestId: string;
  sessionId: string;
  acpSessionId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    locations?: unknown;
  };
  options: CliPermissionOption[];
}

export type CliEvent =
  | { type: "started"; pid: number }
  | { type: "stdout"; content: string }
  | { type: "stderr"; content: string }
  | { type: "items"; items: CliStreamItem[] }
  | {
      type: "terminal-update";
      terminalId: string;
      output: string;
      truncated?: boolean;
      exitCode?: number | null;
      exited?: boolean;
      running?: boolean;
    }
  | { type: "permission"; request: CliPermissionRequest }
  | { type: "permission-resolved"; requestId: string }
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

export interface CodexUsageWindow {
  usedPercent: number;
  leftPercent: number;
  windowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
}

export interface CodexResetCredit {
  status: string;
  expiresAt?: number;
}

export interface CodexResetCredits {
  availableCount: number;
  totalCount: number;
  nextExpiresAt?: number;
  credits: CodexResetCredit[];
}

export type CodexUsageResult =
  | {
      ok: true;
      allowed: boolean;
      limitReached: boolean;
      planType?: string;
      primaryWindow: CodexUsageWindow;
      secondaryWindow?: CodexUsageWindow;
      resetCredits?: CodexResetCredits;
      fetchedAt: string;
    }
  | {
      ok: false;
      reason:
        | "missing_auth"
        | "invalid_auth"
        | "expired_token"
        | "request_failed"
        | "invalid_response";
      error?: string;
      fetchedAt: string;
    };

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

export interface ChatAttachment {
  id: string;
  kind: "image" | "document" | "code";
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  extension?: string;
}

export interface AttachmentCandidate {
  path: string;
  name?: string;
  size?: number;
  mimeType?: string;
  mime_type?: string;
}

export interface Conversation {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  cwd?: string;
  approvalMode?: "auto" | "ask";
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
  attachments?: ChatAttachment[];
  taskId?: string;
  agentId?: string;
  agentName?: string;
  adapter?: string;
  roleLabel?: string;
  workflowRunId?: string;
  workflowStepRowId?: string;
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
  approvalMode?: "auto" | "ask";
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
  attachments?: ChatAttachment[];
  taskId?: string;
  agentId?: string;
  agentName?: string;
  adapter?: string;
  roleLabel?: string;
  workflowRunId?: string;
  workflowStepRowId?: string;
}

export interface UpdateMessageInput {
  id: string;
  status?: MessageStatus;
  content?: string;
  taskId?: string;
}

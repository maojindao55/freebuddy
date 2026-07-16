import type { CLIAdapterId } from "@/config/cliAdapters";
import type { CliStreamItem } from "./streamParser";
import type { SkillSnapshot } from "@/services/skills/types";

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
  skillIds?: string[];
}

export interface CLICodexByokConfig {
  enabled?: boolean;
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  envKey?: string;
  wireApi?: "responses" | "chat";
  apiKey?: string;
  apiKeyPreview?: string;
  models?: CLIByokModel[];
}

export interface CLIClaudeByokConfig {
  enabled?: boolean;
  baseUrl?: string;
  envKey?: string;
  apiKey?: string;
  apiKeyPreview?: string;
  models?: CLIByokModel[];
}

export interface CLIByokModel {
  id: string;
  name?: string;
}

export interface CliPromptAttachment {
  path: string;
  kind: "image" | "document" | "code";
  mimeType?: string;
  name?: string;
}

export interface CliRunArgs {
  sessionId: string;
  /** FreeBuddy conversation that owns UI-scoped tools such as Draft. */
  conversationId?: string;
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
  configOptionOverrides?: Record<string, string>;
  showStderr?: boolean;
  resumeToolSession?: boolean;
  timeoutMs?: number;
  userMessageId?: string;
  knownStreamMessageIds?: string[];
  skills?: SkillSnapshot[];
  announceSkills?: boolean;
}

export interface SessionConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  currentLabel?: string;
  description?: string;
  values?: { id: string; name?: string }[];
}

export interface SessionConfigProbeInput {
  agentId: string;
  adapter: CLIAdapterId;
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type DraftToolAction = "show" | "inspect" | "report";

export type DraftLoadState = "idle" | "loading" | "ready" | "error";

export interface DraftCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DraftScreenshot {
  mimeType: "image/png";
  data: string;
  width: number;
  height: number;
}

export interface DraftConsoleEntry {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  source?: string;
  line?: number;
  timestamp: string;
}

export interface DraftToolEvent {
  requestId: string;
  conversationId: string;
  cwd: string;
  action: DraftToolAction;
  params: Record<string, unknown>;
}

export interface DraftToolResult {
  ok: boolean;
  conversationId: string;
  cwd: string;
  target?: string;
  resolvedUrl?: string;
  loadState?: DraftLoadState;
  visible?: boolean;
  message?: string;
  error?: string;
  updatedAt?: string;
  diagnostics?: { console: DraftConsoleEntry[] };
  screenshot?: DraftScreenshot;
  screenshotError?: string;
  /** Renderer-only capture hint, stripped before the result reaches the agent. */
  captureRect?: DraftCaptureRect;
}

export interface DraftToolResolution {
  requestId: string;
  result: DraftToolResult;
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

export interface CliAuthenticationMethod {
  methodId: string;
  name: string;
  description?: string;
}

export interface CliAuthenticationRequest {
  requestId: string;
  sessionId: string;
  agentName: string;
  methods: CliAuthenticationMethod[];
}

export interface CliAuthenticationTerminalRequest {
  requestId: string;
  sessionId: string;
  agentName: string;
  methodName: string;
}

export interface CliAuthControlArgs {
  agentId: string;
  adapter: CLIAdapterId;
  binary?: string;
  extraArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CliAuthProbeResult {
  authMethods: Array<{
    methodId: string;
    name: string;
    description?: string;
    type: "agent" | "terminal" | "env_var";
  }>;
  logoutSupported: boolean;
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
  | { type: "authentication"; request: CliAuthenticationRequest }
  | { type: "authentication-resolved"; requestId: string }
  | {
      type: "authentication-terminal-started";
      request: CliAuthenticationTerminalRequest;
    }
  | {
      type: "authentication-terminal-update";
      requestId: string;
      output: string;
      running: boolean;
      exitCode?: number;
      signal?: number;
    }
  | { type: "authentication-terminal-resolved"; requestId: string }
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

export type CliInstallFailureCode =
  | "tool_missing"
  | "node_arch_mismatch"
  | "timeout"
  | "spawn_error";

export type CliInstallEvent =
  | { type: "stdout" | "stderr"; content: string }
  | {
      type: "done";
      exitCode: number | null;
      failureCode?: CliInstallFailureCode;
      failureDetail?: string;
    };

export interface CliRuntime {
  adapter: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  latestVersion?: string;
  updateStatus?:
    | "idle"
    | "checking"
    | "current"
    | "updating"
    | "updated"
    | "error";
  lastUpdateCheckAt?: string;
  lastUpdateError?: string;
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
      windows: CodexUsageWindow[];
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
  managed?: boolean;
  created?: boolean;
}

export interface AttachmentCandidate {
  path: string;
  name?: string;
  size?: number;
  mimeType?: string;
  mime_type?: string;
  managed?: boolean;
  created?: boolean;
}

export interface WorkspaceFileMatch {
  path: string;
  name: string;
  directory: string;
}

export type AttachmentPrepareRejectionReason = "unsupported_type" | "file_too_large";

export interface AttachmentPrepareRejection {
  name: string;
  reason: AttachmentPrepareRejectionReason;
}

export interface PrepareAttachmentFilesResult {
  candidates: AttachmentCandidate[];
  rejections: AttachmentPrepareRejection[];
  overflow?: boolean;
}

export type ConversationTitleSource = "default" | "prompt" | "agent" | "user";

export interface Conversation {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  cwd?: string;
  approvalMode?: "auto" | "ask";
  configOptionOverrides?: Record<string, string>;
  skillSnapshot: SkillSnapshot[];
  titleSource?: ConversationTitleSource;
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
  configOptionOverrides?: Record<string, string>;
  skillIds?: string[];
  titleSource?: ConversationTitleSource;
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

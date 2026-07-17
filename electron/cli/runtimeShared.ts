import fs from "node:fs";
import { type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { getDb } from "./db.js";
import type { CLIAdapterId } from "./adapters.js";
import type { AcpStreamItem } from "./acp.js";
import type { SkillSnapshot } from "./skillTypes.js";
import type { HandoffBrief } from "../shared/handoffTypes.js";
import { trackTelemetryEvent } from "../telemetry.js";
import {
  categorizeTelemetryError,
  normalizeTelemetryAdapter,
  telemetryDurationMs
} from "../telemetryPrivacy.js";

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
  /** DB id of the user message for this prompt (ACP dedup). */
  userMessageId?: string;
  /** Known stream messageIds from prior assistant turns (replay suppression). */
  knownStreamMessageIds?: string[];
  /** Normalized text signatures of prior turns (replay suppression when messageIds are absent). */
  knownStreamContentSignatures?: string[];
  /**
   * Agent-chunk messageIds (text/thinking only) persisted from prior turns.
   * Empty for adapters (e.g. Qoder) that stream live without messageIds, which
   * enables replay-phase suppression on resumed sessions.
   */
  knownAgentStreamMessageIds?: string[];
  skills?: SkillSnapshot[];
  announceSkills?: boolean;
  handoffBrief?: HandoffBrief;
  handoffBriefId?: string;
}

export type CliPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | string;

export interface CliPermissionOption {
  optionId: string;
  name?: string;
  kind?: CliPermissionOptionKind;
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

export type CliEvent =
  | { type: "started"; pid: number }
  | { type: "stdout"; content: string }
  | { type: "stderr"; content: string }
  | { type: "items"; items: AcpStreamItem[] }
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

export interface Running {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  pid: number;
  cancel?: () => void;
}

export function channelName(sessionId: string) {
  return `cli://${sessionId}`;
}

export function insertTask(
  args: CliRunArgs,
  logPath: string,
  toolSessionId?: string
) {
  const now = new Date().toISOString();
  const summary = (args.prompt || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 60);
  getDb()
    .prepare(
      `INSERT INTO cli_tasks
         (id, agent_id, agent_name, adapter, status, cwd, prompt, prompt_summary,
          session_id, tool_session_id, log_path, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.sessionId,
      args.agentId,
      args.agentName,
      args.adapter,
      args.cwd ?? null,
      args.prompt,
      summary,
      args.sessionId,
      toolSessionId ?? null,
      logPath,
      now,
      now,
      now
    );
  trackTelemetryEvent("agent_run_started", {
    adapter: normalizeTelemetryAdapter(args.adapter),
    run_context: args.toolSessionScope?.startsWith("workflow:")
      ? "workflow"
      : "conversation",
    resumed_session: Boolean(toolSessionId),
    has_attachments: Boolean(args.promptAttachments?.length),
    attachment_count: args.promptAttachments?.length ?? 0,
    approval_mode: args.approvalMode ?? "default",
    has_workspace: Boolean(args.cwd)
  });
}

export function updateTaskStatus(
  id: string,
  status: "running" | "done" | "failed" | "killed",
  exitCode?: number | null,
  errorMessage?: string | null
) {
  const previous = getDb()
    .prepare(`SELECT adapter, status, started_at FROM cli_tasks WHERE id = ?`)
    .get(id) as
    | { adapter: string; status: string; started_at: string | null }
    | undefined;
  const now = new Date().toISOString();
  const endedAt = status === "running" ? null : now;
  getDb()
    .prepare(
      `UPDATE cli_tasks SET
         status = ?,
         exit_code = COALESCE(?, exit_code),
         error_message = COALESCE(?, error_message),
         ended_at = COALESCE(?, ended_at),
         updated_at = ?
       WHERE id = ?`
    )
    .run(status, exitCode ?? null, errorMessage ?? null, endedAt, now, id);
  if (status !== "running" && previous?.status === "running") {
    trackTelemetryEvent("agent_run_finished", {
      adapter: normalizeTelemetryAdapter(previous.adapter),
      status,
      duration_ms: telemetryDurationMs(previous.started_at ?? undefined),
      ...(typeof exitCode === "number" ? { exit_code: exitCode } : {}),
      ...(status === "failed"
        ? { error_category: categorizeTelemetryError(errorMessage) }
        : {})
    });
  }
}

export function setTaskPid(id: string, pid: number) {
  getDb().prepare(`UPDATE cli_tasks SET pid = ? WHERE id = ?`).run(pid, id);
}

export function setTaskToolSessionId(id: string, toolSessionId: string) {
  getDb()
    .prepare(`UPDATE cli_tasks SET tool_session_id = ?, updated_at = ? WHERE id = ?`)
    .run(toolSessionId, new Date().toISOString(), id);
}

/** Cap a single log line so the main process never synchronously
 *  JSON.stringify + write a multi-megabyte blob (e.g. an inline video base64
 *  returned by the agent), which would freeze window/event handling. */
const MAX_LOG_LINE_CHARS = 64_000;

export function appendLog(
  file: fs.WriteStream | null,
  kind: string,
  content: string
) {
  if (!file || file.writableEnded || file.destroyed) return;
  const safeContent =
    content.length > MAX_LOG_LINE_CHARS
      ? `${content.slice(0, MAX_LOG_LINE_CHARS)}\n… [log truncated]`
      : content;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    type: kind,
    content: safeContent
  });
  try {
    file.write(entry + "\n");
  } catch {
    /* best-effort: stream may close while the agent is shutting down */
  }
}

export function maybeCaptureSessionId(
  capturedSessions: Map<string, string>,
  args: CliRunArgs,
  rawLine: string
) {
  if (capturedSessions.has(args.sessionId)) return;
  const line = rawLine.trim();
  if (!line.startsWith("{")) return;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  const o = obj as Record<string, any>;
  const msg = o?.msg ?? o;
  const candidate =
    o?.session_id ||
    o?.sessionId ||
    o?.thread_id ||
    o?.threadId ||
    o?.session?.id ||
    o?.data?.session_id ||
    o?.data?.sessionId ||
    msg?.session_id ||
    msg?.sessionId ||
    msg?.thread_id ||
    msg?.threadId ||
    msg?.session?.id;
  if (typeof candidate === "string" && candidate.length > 0) {
    capturedSessions.set(args.sessionId, candidate);
  }
}

// ---- Permission request registry ----------------------------------------
// Renderer dispatches decisions back to the main process via IPC; we look up
// the pending resolver by sessionId+requestId and let acpRuntime write the
// JSON-RPC response back to the agent.

export type CliPermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export type CliPermissionResolver = (decision: CliPermissionDecision) => void;

const permissionRegistry = new Map<string, Map<string, CliPermissionResolver>>();

export function registerPermissionResolver(
  sessionId: string,
  requestId: string,
  resolver: CliPermissionResolver
) {
  let bucket = permissionRegistry.get(sessionId);
  if (!bucket) {
    bucket = new Map();
    permissionRegistry.set(sessionId, bucket);
  }
  bucket.set(requestId, resolver);
}

export function takePermissionResolver(
  sessionId: string,
  requestId: string
): CliPermissionResolver | undefined {
  const bucket = permissionRegistry.get(sessionId);
  if (!bucket) return undefined;
  const resolver = bucket.get(requestId);
  if (resolver) {
    bucket.delete(requestId);
    if (bucket.size === 0) permissionRegistry.delete(sessionId);
  }
  return resolver;
}

export function clearPermissionResolversForSession(sessionId: string) {
  const bucket = permissionRegistry.get(sessionId);
  if (!bucket) return;
  for (const resolver of bucket.values()) {
    try {
      resolver({ outcome: "cancelled" });
    } catch {
      /* noop */
    }
  }
  permissionRegistry.delete(sessionId);
}

// ---- Authentication method registry ------------------------------------

export type CliAuthenticationDecision =
  | { outcome: "selected"; methodId: string }
  | { outcome: "cancelled" };

export type CliAuthenticationResolver = (
  decision: CliAuthenticationDecision
) => void;

const authenticationRegistry = new Map<
  string,
  Map<string, CliAuthenticationResolver>
>();

export function registerAuthenticationResolver(
  sessionId: string,
  requestId: string,
  resolver: CliAuthenticationResolver
) {
  let bucket = authenticationRegistry.get(sessionId);
  if (!bucket) {
    bucket = new Map();
    authenticationRegistry.set(sessionId, bucket);
  }
  bucket.set(requestId, resolver);
}

export function takeAuthenticationResolver(
  sessionId: string,
  requestId: string
): CliAuthenticationResolver | undefined {
  const bucket = authenticationRegistry.get(sessionId);
  if (!bucket) return undefined;
  const resolver = bucket.get(requestId);
  if (resolver) {
    bucket.delete(requestId);
    if (bucket.size === 0) authenticationRegistry.delete(sessionId);
  }
  return resolver;
}

export function clearAuthenticationResolversForSession(sessionId: string) {
  const bucket = authenticationRegistry.get(sessionId);
  if (!bucket) return;
  for (const resolver of bucket.values()) {
    try {
      resolver({ outcome: "cancelled" });
    } catch {
      /* noop */
    }
  }
  authenticationRegistry.delete(sessionId);
}

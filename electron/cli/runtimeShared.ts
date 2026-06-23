import fs from "node:fs";
import { type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { getDb } from "./db.js";
import type { CLIAdapterId } from "./adapters.js";
import type { AcpStreamItem } from "./acp.js";

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

export type CliEvent =
  | { type: "started"; pid: number }
  | { type: "stdout"; content: string }
  | { type: "stderr"; content: string }
  | { type: "items"; items: AcpStreamItem[] }
  | { type: "permission"; request: CliPermissionRequest }
  | { type: "permission-resolved"; requestId: string }
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
}

export function updateTaskStatus(
  id: string,
  status: "running" | "done" | "failed" | "killed",
  exitCode?: number | null,
  errorMessage?: string | null
) {
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
}

export function setTaskPid(id: string, pid: number) {
  getDb().prepare(`UPDATE cli_tasks SET pid = ? WHERE id = ?`).run(pid, id);
}

export function setTaskToolSessionId(id: string, toolSessionId: string) {
  getDb()
    .prepare(`UPDATE cli_tasks SET tool_session_id = ?, updated_at = ? WHERE id = ?`)
    .run(toolSessionId, new Date().toISOString(), id);
}

export function appendLog(
  file: fs.WriteStream | null,
  kind: string,
  content: string
) {
  if (!file) return;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    type: kind,
    content
  });
  file.write(entry + "\n");
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

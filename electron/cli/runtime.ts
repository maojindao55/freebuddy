import { spawn, type ChildProcessByStdio } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import type { Readable, Writable } from "node:stream";

import {
  buildCommand,
  getAdapterDefinition,
  hasExplicitToolSessionArg,
  type CLIAdapterId
} from "./adapters.js";
import { getDb, getLogDir } from "./db.js";
import { updateRuntimeRun } from "./check.js";
import { getToolSession, saveToolSession } from "./store.js";

export interface CliRunArgs {
  sessionId: string;
  agentId: string;
  agentName: string;
  adapter: CLIAdapterId;
  binary?: string;
  extraArgs?: string[];
  prompt: string;
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

export type CliEvent =
  | { type: "started"; pid: number }
  | { type: "stdout"; content: string }
  | { type: "stderr"; content: string }
  | { type: "done"; exitCode: number }
  | { type: "error"; message: string };

interface Running {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  pid: number;
}

const running = new Map<string, Running>();
const capturedSessions = new Map<string, string>();

function channelName(sessionId: string) {
  return `cli://${sessionId}`;
}

function insertTask(args: CliRunArgs, logPath: string, toolSessionId?: string) {
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

function updateTaskStatus(
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

function setTaskPid(id: string, pid: number) {
  getDb().prepare(`UPDATE cli_tasks SET pid = ? WHERE id = ?`).run(pid, id);
}

function setTaskToolSessionId(id: string, toolSessionId: string) {
  getDb()
    .prepare(`UPDATE cli_tasks SET tool_session_id = ?, updated_at = ? WHERE id = ?`)
    .run(toolSessionId, new Date().toISOString(), id);
}

function appendLog(file: fs.WriteStream | null, kind: string, content: string) {
  if (!file) return;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    type: kind,
    content
  });
  file.write(entry + "\n");
}

function maybeCaptureSessionId(args: CliRunArgs, rawLine: string) {
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

export async function cliRun(
  webContents: WebContents,
  args: CliRunArgs
): Promise<void> {
  const channel = channelName(args.sessionId);
  const emit = (e: CliEvent) => {
    if (!webContents.isDestroyed()) webContents.send(channel, e);
  };

  const logFile = path.join(getLogDir(), `${args.sessionId}.jsonl`);
  let logStream: fs.WriteStream | null = null;
  try {
    logStream = fs.createWriteStream(logFile, { flags: "w" });
  } catch {
    /* best-effort */
  }

  let toolSessionId: string | undefined;
  const toolSessionScope = args.toolSessionScope || args.cwd;
  const definition = getAdapterDefinition(args.adapter);
  const userControlsResume = hasExplicitToolSessionArg(args.adapter, args.extraArgs);
  if (
    args.resumeToolSession !== false &&
    !userControlsResume &&
    definition?.capabilities.toolSession
  ) {
    toolSessionId = args.toolSessionId;
    if (!toolSessionId && toolSessionScope) {
      const prev = getToolSession(args.agentId, toolSessionScope);
      if (prev && prev.adapter === args.adapter) {
        toolSessionId = prev.sessionId;
      }
    }
  }

  insertTask(args, logFile, toolSessionId);
  appendLog(
    logStream,
    "system",
    `start adapter=${args.adapter} cwd=${args.cwd ?? "."} resume=${toolSessionId ?? "-"}`
  );

  let built;
  try {
    built = buildCommand({
      adapter: args.adapter,
      binary: args.binary,
      prompt: args.prompt,
      extraArgs: args.extraArgs,
      cwd: args.cwd,
      toolSessionId
    });
  } catch (e) {
    const msg = `build command failed: ${(e as Error)?.message || e}`;
    appendLog(logStream, "system", msg);
    emit({ type: "error", message: msg });
    emit({ type: "done", exitCode: -1 });
    updateTaskStatus(args.sessionId, "failed", -1, msg);
    updateRuntimeRun(args.adapter, msg);
    logStream?.end();
    return;
  }

  const env = { ...process.env, ...(args.env || {}) };

  const child = spawn(built.bin, built.args, {
    cwd: args.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  let resolved = false;
  await new Promise<void>((resolve) => {
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    child.once("spawn", done);
    child.once("error", (err) => {
      const msg = `spawn failed: ${err.message}`;
      appendLog(logStream, "system", msg);
      emit({ type: "error", message: msg });
      emit({ type: "done", exitCode: -1 });
      updateTaskStatus(args.sessionId, "failed", -1, msg);
      updateRuntimeRun(args.adapter, msg);
      logStream?.end();
      done();
    });
  });

  const pid = child.pid ?? 0;
  if (!pid) return;
  running.set(args.sessionId, { child, pid });
  setTaskPid(args.sessionId, pid);
  emit({ type: "started", pid });

  if (built.promptViaStdin) {
    child.stdin.write(args.prompt);
  }
  child.stdin.end();

  const rlOut = readline.createInterface({ input: child.stdout });
  rlOut.on("line", (line) => {
    appendLog(logStream, "stdout", line);
    emit({ type: "stdout", content: line });
    maybeCaptureSessionId(args, line);
  });

  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on("line", (line) => {
    appendLog(logStream, "stderr", line);
    if (args.showStderr !== false) emit({ type: "stderr", content: line });
  });

  let timer: NodeJS.Timeout | undefined;
  if (args.timeoutMs && args.timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
    }, args.timeoutMs);
  }

  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    const exitCode = code ?? -1;
    running.delete(args.sessionId);
    appendLog(logStream, "system", `exit code=${exitCode}`);
    emit({ type: "done", exitCode });
    const status = exitCode === 0 ? "done" : "failed";
    updateTaskStatus(args.sessionId, status, exitCode);
    updateRuntimeRun(
      args.adapter,
      status === "failed" ? `exit ${exitCode}` : undefined
    );

    const captured = capturedSessions.get(args.sessionId);
    if (captured && toolSessionScope) {
      saveToolSession(args.agentId, toolSessionScope, args.adapter, captured);
      setTaskToolSessionId(args.sessionId, captured);
    }
    capturedSessions.delete(args.sessionId);
    logStream?.end();
  });
}

export function cliKill(sessionId: string): boolean {
  const r = running.get(sessionId);
  if (!r) return false;
  try {
    r.child.kill("SIGTERM");
    setTimeout(() => {
      const still = running.get(sessionId);
      if (still) {
        try {
          still.child.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }
    }, 2000);
    updateTaskStatus(sessionId, "killed");
    return true;
  } catch {
    return false;
  }
}

import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import type { Readable, Writable } from "node:stream";

import {
  buildCommand,
  getAdapterDefinition,
  hasExplicitToolSessionArg
} from "./adapters.js";
import { runAcpAgent } from "./acpRuntime.js";
import { runLegacyCliAgent } from "./legacyRuntime.js";
import { getLogDir } from "./db.js";
import { updateRuntimeRun } from "./check.js";
import { getToolSession } from "./store.js";
import {
  appendLog,
  channelName,
  insertTask,
  setTaskPid,
  updateTaskStatus,
  type CliEvent,
  type CliRunArgs,
  type Running
} from "./runtimeShared.js";

export type { CliEvent, CliRunArgs } from "./runtimeShared.js";

const running = new Map<string, Running>();
const capturedSessions = new Map<string, string>();

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
  setTaskPid(args.sessionId, pid);
  emit({ type: "started", pid });

  if (built.protocol === "acp") {
    await runAcpAgent({
      child,
      args,
      pid,
      logStream,
      toolSessionId,
      toolSessionScope,
      running,
      capturedSessions,
      emit
    });
    return;
  }

  runLegacyCliAgent({
    child,
    args,
    built,
    pid,
    logStream,
    toolSessionScope,
    running,
    capturedSessions,
    emit
  });
}

export function cliKill(sessionId: string): boolean {
  const r = running.get(sessionId);
  if (!r) return false;
  try {
    r.cancel?.();
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

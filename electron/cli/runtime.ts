import { type ChildProcessByStdio } from "node:child_process";
import spawn from "cross-spawn";
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
import { updateRuntimeRun, waitForCodexToolchainAutoUpdate } from "./check.js";
import { safeSendToWebContents } from "./ipcSend.js";
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
import { killProcessTree } from "./process-kill.js";
import { resolveCliByokEnv } from "./store.js";

export type { CliEvent, CliRunArgs } from "./runtimeShared.js";

const running = new Map<string, Running>();
const capturedSessions = new Map<string, string>();

type StreamItemEntry = Extract<CliEvent, { type: "items" }>["items"][number];

/**
 * Coalesce consecutive high-frequency `items` events (ACP agent_message
 * chunks, tool calls, ...) into a single event flushed on a short timer or
 * before any non-items event. ACP agents can emit hundreds of small updates
 * per second; without batching every chunk triggers a renderer state update,
 * a JSON.stringify of the whole turn, a React render, and (in workflow mode)
 * a synchronous DB write + full-message reload. Batching caps that to ~60
 * flushes/sec while preserving ordering relative to permission/done/error.
 */
function createItemsBatchingEmit(
  send: (e: CliEvent) => void
): (e: CliEvent) => void {
  const FLUSH_MS = 16;
  const MAX_BUFFER = 200;
  let buffer: StreamItemEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (buffer.length === 0) return;
    const items = buffer;
    buffer = [];
    send({ type: "items", items });
  };

  return (e: CliEvent) => {
    if (e.type === "items" && e.items.length) {
      for (const it of e.items) buffer.push(it);
      if (buffer.length >= MAX_BUFFER) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
      } else if (timer === null) {
        timer = setTimeout(flush, FLUSH_MS);
      }
      return;
    }
    // Preserve ordering: flush pending items before a non-items event
    // (permission / done / error / started) so the renderer observes them
    // first, and so finalizeRun sees the complete item set on `done`.
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length > 0) flush();
    send(e);
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeJsonObjects(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    next[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMergeJsonObjects(existing, value)
        : value;
  }
  return next;
}

function mergeJsonEnvValue(current: string | undefined, patch: string) {
  if (!current) return patch;
  try {
    const currentJson = JSON.parse(current);
    const patchJson = JSON.parse(patch);
    if (isPlainObject(currentJson) && isPlainObject(patchJson)) {
      return JSON.stringify(deepMergeJsonObjects(currentJson, patchJson));
    }
    return patch;
  } catch {
    return patch;
  }
}

function mergeBuiltEnv(
  base: Record<string, string | undefined>,
  patch?: Record<string, string>
) {
  if (!patch) return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    next[key] =
      key === "OPENCODE_CONFIG_CONTENT" || key === "CODEX_CONFIG"
        ? mergeJsonEnvValue(next[key], value)
        : value;
  }
  return next;
}

export async function cliRun(
  webContents: WebContents,
  args: CliRunArgs,
  onEvent?: (e: CliEvent) => void
): Promise<void> {
  const channel = channelName(args.sessionId);
  const emit = createItemsBatchingEmit((e) => {
    if (onEvent) onEvent(e);
    safeSendToWebContents(webContents, channel, e);
  });

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

  // Avoid spawning codex-acp while npm is replacing its global package files.
  // A failed background update is non-fatal and resolves this wait normally.
  await waitForCodexToolchainAutoUpdate(args.adapter);

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

  const env = mergeBuiltEnv(
    mergeBuiltEnv(
      { ...process.env, ...(args.env || {}) },
      resolveCliByokEnv(args.agentId, args.adapter)
    ),
    built.env
  );

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
      webContents,
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
    killProcessTree(r.child, "term");
    if (process.platform !== "win32") {
      setTimeout(() => {
        const still = running.get(sessionId);
        if (still) {
          try {
            killProcessTree(still.child, "force");
          } catch {
            /* noop */
          }
        }
      }, 2000);
    }
    updateTaskStatus(sessionId, "killed");
    return true;
  } catch {
    return false;
  }
}

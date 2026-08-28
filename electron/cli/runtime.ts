import { type ChildProcessByStdio } from "node:child_process";
import spawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import type { Readable, Writable } from "node:stream";

import {
  buildCommand,
  buildDshAcpRuntimeDiagnostics,
  dshAcpKoffiGuardPath,
  dshAcpManagedRoot,
  dshAcpWindowsResiduePath,
  ensureDshAcpCwd,
  getAdapterDefinition,
  hasExplicitToolSessionArg,
  mergeNodeOptions,
  patchDshAcpRuntimeFromCommand,
  sanitizeCliAgentEnv,
  syncDshAcpManagedConfig
} from "./adapters.js";
import { runAcpAgent } from "./acpRuntime.js";
import { runLegacyCliAgent } from "./legacyRuntime.js";
import { getDataDir, getLogDir } from "./db.js";
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
import {
  ensureCodexChatBridge,
  resolveClaudeByokSessionOptions,
  resolveCliByokEnv
} from "./store.js";
import { getSkillOwnershipRoots } from "./skills.js";
import {
  buildSkillAnnouncement,
  reconcileNativeSkillLinks
} from "./skillRuntime.js";
import { logMain } from "../debugLog.js";
import {
  cleanupSandboxCommand,
  isRemoteIsolatedCaller,
  prepareSandboxedSpawn,
  sandboxWorkingDirectory,
  shouldSandboxCurrentCaller,
  type SandboxedSpawn
} from "./sandboxRuntime.js";
import { isolateRemoteCwdForCaller } from "./remoteWorkspaceAccess.js";
import { clearSessionOwner } from "./sessionOwners.js";

export type { CliEvent, CliRunArgs } from "./runtimeShared.js";

const running = new Map<string, Running>();
const capturedSessions = new Map<string, string>();

type StreamItemEntry = Extract<CliEvent, { type: "items" }>["items"][number];

/**
 * Coalesce consecutive high-frequency `items` events (ACP agent_message
 * chunks, tool calls, ...) into a single event flushed on a short timer or
 * before any non-items event. ACP agents can emit hundreds of small updates
 * per second; without batching every chunk triggers a renderer state update,
 * a React render and (in workflow mode) a synchronous DB write + full-message
 * reload. A 12.5 Hz visual update rate remains smooth for text streaming while
 * preventing several concurrent agents from collectively driving hundreds of
 * renderer updates per second.
 */
function createItemsBatchingEmit(
  send: (e: CliEvent) => void
): (e: CliEvent) => void {
  const FLUSH_MS = 80;
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

export function mergeBuiltEnv(
  base: Record<string, string | undefined>,
  patch?: Record<string, string>
) {
  if (!patch) return sanitizeCliAgentEnv(base);
  const next: Record<string, string | undefined> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    next[key] =
      key === "OPENCODE_CONFIG_CONTENT" || key === "CODEX_CONFIG"
        ? mergeJsonEnvValue(next[key], value)
        : key === "NODE_OPTIONS"
          ? mergeNodeOptions(next[key], value)
          : value;
  }
  return sanitizeCliAgentEnv(next);
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

  const remoteIsolated = isRemoteIsolatedCaller();
  const readOnlyWorkspace = args.workspaceAccess === "read-only";
  // OS process sandbox is only for remote callers who enabled strictIsolation.
  // Local read-only reviewers stay unsandboxed so CLIs installed under AppData
  // can start; workspaceAccess still gates native skill mounts and, when the
  // process is already sandboxed, extra denyWrite on the workspace.
  const processSandboxed = shouldSandboxCurrentCaller();
  let toolSessionId: string | undefined;
  const toolSessionScope = args.toolSessionScope || args.cwd;
  const definition = getAdapterDefinition(args.adapter);
  const userControlsResume = hasExplicitToolSessionArg(args.adapter, args.extraArgs);
  if (
    args.resumeToolSession !== false &&
    !userControlsResume &&
    definition?.capabilities.toolSession
  ) {
    const prev = toolSessionScope
      ? getToolSession(args.agentId, toolSessionScope)
      : undefined;
    if (remoteIsolated) {
      // Renderer history can contain a desktop-owned ACP session id. Remote
      // callers may resume only the owner-scoped session stored server-side;
      // trusting a renderer-supplied id can load another user's cwd/config.
      if (prev?.adapter === args.adapter) {
        toolSessionId = prev.sessionId;
      }
    } else {
      toolSessionId = args.toolSessionId;
      if (!toolSessionId && prev?.adapter === args.adapter) {
        toolSessionId = prev.sessionId;
      }
    }
  }

  insertTask(args, logFile, toolSessionId);
  logMain().info("runtime", "agent run start", {
    adapter: args.adapter,
    sessionId: args.sessionId,
    approvalMode: args.approvalMode ?? "default"
  });
  appendLog(
    logStream,
    "system",
    `start adapter=${args.adapter} approvalMode=${args.approvalMode ?? "default"} cwd=${args.cwd ?? "."} resume=${toolSessionId ?? "-"}`
  );

  // Avoid spawning codex-acp while npm is replacing its global package files.
  // A failed background update is non-fatal and resolves this wait normally.
  await waitForCodexToolchainAutoUpdate(args.adapter);

  const skillSupport = definition?.capabilities.skills;
  let nativeSkillsMounted = false;
  if (
    !readOnlyWorkspace &&
    args.cwd &&
    args.skills &&
    skillSupport?.nativeDirs?.length
  ) {
    nativeSkillsMounted = reconcileNativeSkillLinks(
      args.cwd,
      skillSupport.nativeDirs,
      args.skills,
      getSkillOwnershipRoots()
    );
  }
  const effectiveArgs: CliRunArgs =
    args.announceSkills && args.skills?.length
      ? {
          ...args,
          prompt: buildSkillAnnouncement(args.prompt, args.skills, {
            nativeSkillsMounted
          })
        }
      : args;
  const withWorkspace: CliRunArgs =
    effectiveArgs.adapter === "dsh-acp"
      ? {
          ...effectiveArgs,
          cwd: ensureDshAcpCwd(effectiveArgs.cwd, getDataDir())
        }
      : effectiveArgs;
  if (withWorkspace.adapter === "dsh-acp") {
    syncDshAcpManagedConfig(getDataDir());
  }
  const isolatedCwd = remoteIsolated
    ? await isolateRemoteCwdForCaller(withWorkspace.cwd)
    : withWorkspace.cwd;
  const executionArgs: CliRunArgs = remoteIsolated
    ? { ...withWorkspace, cwd: sandboxWorkingDirectory(isolatedCwd) }
    : { ...withWorkspace, cwd: isolatedCwd };

  let built;
  try {
    built = buildCommand({
      adapter: executionArgs.adapter,
      binary: executionArgs.binary,
      prompt: executionArgs.prompt,
      extraArgs: executionArgs.extraArgs,
      cwd: executionArgs.cwd,
      toolSessionId,
      workspaceRoots: args.workspaceRoots,
      dshAcpRuntimeRoot:
        executionArgs.adapter === "dsh-acp"
          ? dshAcpManagedRoot(getDataDir())
          : undefined
    });
    if (executionArgs.adapter === "dsh-acp") {
      patchDshAcpRuntimeFromCommand(built);
      const configIdx = built.args.findIndex(
        (arg) => arg === "--config" || arg === "-c"
      );
      const configPath =
        configIdx >= 0
          ? built.args[configIdx + 1]
          : built.args
              .find((arg) => arg.startsWith("--config=") || arg.startsWith("-c="))
              ?.split("=")
              .slice(1)
              .join("=");
      appendLog(
        logStream,
        "system",
        `dsh-acp runtime ${JSON.stringify(
          buildDshAcpRuntimeDiagnostics({
            runtimeRoot: dshAcpManagedRoot(getDataDir()),
            configPath,
            spawnBin: built.bin,
            spawnArgs: built.args
          })
        )}`
      );
    }
  } catch (e) {
    const msg = `build command failed: ${(e as Error)?.message || e}`;
    appendLog(logStream, "system", msg);
    emit({ type: "error", message: msg });
    emit({ type: "done", exitCode: -1 });
    clearSessionOwner(args.sessionId);
    updateTaskStatus(args.sessionId, "failed", -1, msg);
    updateRuntimeRun(args.adapter, msg);
    logStream?.end();
    return;
  }

  await ensureCodexChatBridge();
  const env = mergeBuiltEnv(
    mergeBuiltEnv(
      { ...process.env, ...(effectiveArgs.env || {}) },
      built.env
    ),
    resolveCliByokEnv(
      args.agentId,
      args.adapter,
      args.configOptionOverrides?.model ?? built.env?.ANTHROPIC_MODEL
    )
  );

  let spawnCommand: SandboxedSpawn = {
    bin: built.bin,
    args: built.args,
    env
  };
  if (processSandboxed) {
    try {
      spawnCommand = await prepareSandboxedSpawn({
        adapter: executionArgs.adapter,
        bin: built.bin,
        args: built.args,
        cwd: executionArgs.cwd ?? process.cwd(),
        readOnlyWorkspace,
        env,
        extraReadPaths: [
          ...(executionArgs.promptAttachments ?? []).map(
            (attachment) => attachment.path
          ),
          ...(executionArgs.skills ?? []).map((skill) => skill.rootPath),
          ...(executionArgs.adapter === "dsh-acp"
            ? [
                dshAcpManagedRoot(getDataDir()),
                dshAcpKoffiGuardPath(),
                dshAcpWindowsResiduePath() ?? ""
              ].filter(Boolean)
            : [])
        ]
      });
    } catch (error) {
      const msg = `sandbox setup failed: ${
        (error as Error)?.message || String(error)
      }`;
      appendLog(logStream, "system", msg);
      emit({ type: "error", message: msg });
      emit({ type: "done", exitCode: -1 });
      clearSessionOwner(args.sessionId);
      updateTaskStatus(args.sessionId, "failed", -1, msg);
      updateRuntimeRun(args.adapter, msg);
      logStream?.end();
      return;
    }
  }

  const child = spawn(spawnCommand.bin, spawnCommand.args, {
    cwd: executionArgs.cwd,
    env: spawnCommand.env,
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  const attachSandboxStdin = (
    target: ChildProcessByStdio<Writable, Readable, Readable>,
    reset = false
  ) => {
    if (!spawnCommand.stdinPath) return;
    if (reset) fs.writeFileSync(spawnCommand.stdinPath, "");
    const stdin = fs.createWriteStream(spawnCommand.stdinPath, { flags: "a" });
    Object.defineProperty(target, "stdin", { value: stdin });
    target.once("close", () => stdin.end());
  };

  attachSandboxStdin(child);


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
      clearSessionOwner(args.sessionId);
      updateTaskStatus(args.sessionId, "failed", -1, msg);
      updateRuntimeRun(args.adapter, msg);
      logStream?.end();
      done();
    });
  });

  const pid = child.pid ?? 0;
  if (!pid) {
    if (processSandboxed) cleanupSandboxCommand();
    return;
  }
  setTaskPid(args.sessionId, pid);
  emit({ type: "started", pid });

  if (built.protocol === "acp") {
    try {
      await runAcpAgent({
        child,
        webContents,
        args: executionArgs,
        pid,
        logStream,
        toolSessionId,
        toolSessionScope,
        running,
        capturedSessions,
        emit,
        agentCommand: {
          bin: spawnCommand.bin,
          args: spawnCommand.args,
          cwd: executionArgs.cwd,
          env: spawnCommand.env
        },
        claudeAcpSessionOptions: resolveClaudeByokSessionOptions(
          args.agentId,
          args.adapter
        ),
        restartAgent: async () => {
          const restarted = spawn(spawnCommand.bin, spawnCommand.args, {
            cwd: executionArgs.cwd,
            env: spawnCommand.env,
            stdio: ["pipe", "pipe", "pipe"]
          }) as ChildProcessByStdio<Writable, Readable, Readable>;
          attachSandboxStdin(restarted, true);
          await new Promise<void>((resolve, reject) => {
            restarted.once("spawn", resolve);
            restarted.once("error", reject);
          });
          const restartedPid = restarted.pid ?? 0;
          if (!restartedPid) {
            throw new Error("Restarted ACP agent did not report a process id.");
          }
          setTaskPid(args.sessionId, restartedPid);
          emit({ type: "started", pid: restartedPid });
          return { child: restarted, pid: restartedPid };
        }
      });
    } finally {
      if (processSandboxed) cleanupSandboxCommand();
    }
    return;
  }

  if (processSandboxed) child.once("close", cleanupSandboxCommand);
  runLegacyCliAgent({
    child,
    args: executionArgs,
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

/** Ask an ACP-backed agent to end its current turn successfully. */
export function cliYield(sessionId: string): boolean {
  const current = running.get(sessionId);
  if (!current?.yield) return false;
  try {
    current.yield();
    return true;
  } catch {
    return false;
  }
}

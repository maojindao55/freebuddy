import { type ChildProcessByStdio } from "node:child_process";
import spawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";

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
import {
  ensurePiSettings,
  piLauncherDir,
  resolvePiAcpRuntime
} from "./piRuntime.js";
import { ensurePackagedPiRuntime } from "./piRuntimePackage.js";
import { runAcpAgent } from "./acpRuntime.js";
import { acpProcessPool, type AcpWarmConnection } from "./acpProcessPool.js";
import { unregisterBrowserToolSession } from "../browserToolService.js";
import { getCallerUserId } from "./callerContext.js";
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
  resolveCliByokEnv,
  resolvePiByokDefaultModel
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
import { RunMetricsCollector } from "./runMetricsCollector.js";

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
): ((e: CliEvent) => void) & { flush: () => void } {
  const FLUSH_MS = 80;
  const MAX_BUFFER = 200;
  let buffer: StreamItemEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (buffer.length === 0) return;
    const items = buffer;
    buffer = [];
    send({ type: "items", items });
  };

  const emit = (e: CliEvent) => {
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
  return Object.assign(emit, { flush });
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
  const sanitized = sanitizeCliAgentEnv(next);
  // Built commands may explicitly opt into Electron-as-Node (the bundled pi
  // runtime does when no user node is available). sanitize strips the
  // *inherited* value so Electron children of CLI agents never misbehave; an
  // explicit patch from buildCommand must still win.
  if (typeof patch.ELECTRON_RUN_AS_NODE === "string") {
    sanitized.ELECTRON_RUN_AS_NODE = patch.ELECTRON_RUN_AS_NODE;
  }
  return sanitized;
}

export async function cliRun(
  webContents: WebContents,
  args: CliRunArgs,
  onEvent?: (e: CliEvent) => void
): Promise<void> {
  const channel = channelName(args.sessionId);
  const send = createItemsBatchingEmit((e) => {
    if (onEvent) onEvent(e);
    safeSendToWebContents(webContents, channel, e);
  });
  const metrics = new RunMetricsCollector(args.sessionId, (runMetrics) => {
    send({ type: "items", items: [{ kind: "usage", runId: args.sessionId, runMetrics }] });
  });
  const emit = (event: CliEvent) => {
    if (event.type === "error") metrics.error();
    if (event.type === "done") metrics.finish(event.exitCode === 0 ? "done" : "failed");
    if (event.type === "items") {
      event = { ...event, items: event.items.map(item => item.kind === "usage"
        ? { ...item, runId: args.sessionId } : item) };
    }
    send(event);
  };
  metrics.emit();
  try {
    await runCliAgent(webContents, args, emit, metrics);
  } catch (error) {
    metrics.error();
    metrics.finish("failed");
    send.flush();
    throw error;
  }
}

async function runCliAgent(
  webContents: WebContents,
  args: CliRunArgs,
  emit: (event: CliEvent) => void,
  metrics: RunMetricsCollector
): Promise<void> {

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

  // Wait until any installation replacing this agent's files has finished.
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
    if (executionArgs.adapter === "pi-acp") {
      await ensurePackagedPiRuntime(getDataDir());
    }
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
          : undefined,
      piDataDir:
        executionArgs.adapter === "pi-acp" ? getDataDir() : undefined
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
  const byokEnv = resolveCliByokEnv(
    args.agentId,
    args.adapter,
    args.configOptionOverrides?.model ?? built.env?.ANTHROPIC_MODEL
  );
  if (args.adapter === "pi-acp") {
    const defaultModel = resolvePiByokDefaultModel(args.agentId, args.adapter);
    if (defaultModel) {
      ensurePiSettings(getDataDir(), {
        defaultProvider: "freebuddy-relay",
        defaultModel: defaultModel.replace(/^freebuddy-relay\//, "")
      });
    }
  }
  const env = mergeBuiltEnv(
    mergeBuiltEnv(
      { ...process.env, ...(effectiveArgs.env || {}) },
      built.env
    ),
    byokEnv
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
            : []),
          ...(executionArgs.adapter === "pi-acp"
            ? [
                resolvePiAcpRuntime().root ?? "",
                piLauncherDir(getDataDir()),
                path.join(getDataDir(), "pi-agent")
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

  if (built.protocol !== "acp" && !built.promptViaStdin) metrics.promptSubmitted();
  const warmKey = built.protocol === "acp" && args.adapter === "agy-acp" && args.conversationId &&
      !processSandboxed && !remoteIsolated && !args.delegation && !userControlsResume
    ? JSON.stringify([getCallerUserId(), webContents.id, args.conversationId, args.agentId, toolSessionScope]) : undefined;
  const warmFingerprint = createHash("sha256").update(JSON.stringify({
    bin: spawnCommand.bin, args: spawnCommand.args, cwd: executionArgs.cwd,
    env: Object.entries(spawnCommand.env).sort(([a], [b]) => a.localeCompare(b)),
    access: executionArgs.workspaceAccess, approval: executionArgs.approvalMode,
  })).digest("hex");
  const reused = warmKey ? acpProcessPool.take(warmKey, warmFingerprint, toolSessionId) : undefined;
  const child = reused?.child ?? spawn(spawnCommand.bin, spawnCommand.args, {
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

  if (!reused) attachSandboxStdin(child);

  let resolved = false;
  await new Promise<void>((resolve) => {
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    if (reused) { done(); return; }
    const spawnError = (err: Error) => {
      const msg = `spawn failed: ${err.message}`;
      appendLog(logStream, "system", msg);
      emit({ type: "error", message: msg });
      emit({ type: "done", exitCode: -1 });
      clearSessionOwner(args.sessionId);
      updateTaskStatus(args.sessionId, "failed", -1, msg);
      updateRuntimeRun(args.adapter, msg);
      logStream?.end();
      done();
    };
    child.once("spawn", () => { child.off("error", spawnError); done(); });
    child.once("error", spawnError);
  });

  const pid = child.pid ?? 0;
  if (!pid) {
    if (processSandboxed) cleanupSandboxCommand();
    return;
  }
  setTaskPid(args.sessionId, pid);
  emit({ type: "started", pid });

  if (built.protocol === "acp") {
    const connection: AcpWarmConnection | undefined = warmKey ? reused ?? {
      child, fingerprint: warmFingerprint, conversationId: args.conversationId!, requestId: 0,
      dispose: () => {
        if (connection?.previousRunId) unregisterBrowserToolSession(connection.previousRunId);
        try { killProcessTree(connection?.child ?? child, "term"); } catch { /* already closed */ }
      },
    } : undefined;
    let parked = false;
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
        metrics,
        warmConnection: connection,
        parkConnection: connection && warmKey ? () => {
          parked = true;
          acpProcessPool.put(warmKey, connection);
        } : undefined,
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
      if (connection && !parked) connection.dispose();
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
    emit,
    metrics,
    resumed: Boolean(toolSessionId) || userControlsResume
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

function waitForCliProcessExit(
  child: Running["child"],
  timeoutMs: number
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("close", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("close", done);
  });
}

export async function shutdownCliProcesses(timeoutMs = 2000): Promise<void> {
  acpProcessPool.dispose();
  const entries = [...running.entries()];
  for (const [sessionId] of entries) cliKill(sessionId);
  await Promise.all(
    entries.map(([, entry]) => waitForCliProcessExit(entry.child, timeoutMs))
  );
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

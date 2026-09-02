import readline from "node:readline";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { WebContents } from "electron";

import {
  acpPromptResultToItems,
  acpNonRetryableUpstreamError,
  acpSessionListToItems,
  acpSessionSetupToItems,
  acpUpdateToItems,
  buildAuthenticateRequest,
  buildInitializeRequest,
  buildSessionCancelNotification,
  buildSessionCloseRequest,
  buildSessionListRequest,
  buildSessionLoadRequest,
  buildSessionNewRequest,
  buildSessionPromptRequest,
  buildSessionResumeRequest,
  buildSessionSetConfigOptionRequest,
  buildTerminalOutputResponse,
  parseAcpLine,
  selectAcpSessionStartMode,
  selectAcpAuthMethod,
  shouldDropReplayPhaseAgentChunk,
  shouldEmitAcpUpdate,
  shouldSkipUserMessageChunk,
  shouldDiscardAcpToolSession,
  shouldRetryEmptyResumedDshTurn,
  textFromContent,
  updateActiveAcpToolCalls,
  isMissingSavedSessionError,
  type AcpAuthMethod,
  type AcpMessage,
  type AcpSessionMeta,
  type AcpRequestId
} from "./acp.js";
import { createAcpTerminalManager } from "./acpTerminal.js";
import { updateRuntimeRun } from "./check.js";
import {
  hasCliByokModels,
  mergeCliByokModelOption,
  clearToolSession,
  saveToolSession
} from "./store.js";
import {
  appendLog,
  clearAuthenticationResolversForSession,
  clearPermissionResolversForSession,
  registerAuthenticationResolver,
  registerPermissionResolver,
  takePermissionResolver,
  setTaskToolSessionId,
  updateTaskStatus,
  type CliEvent,
  type CliPermissionDecision,
  type CliPermissionOption,
  type CliRunArgs,
  type Running
} from "./runtimeShared.js";
import { isInactivitySuppressed, removeInactivitySuppression } from "./inactivitySuppression.js";
import { killProcessTree } from "./process-kill.js";
import {
  registerBrowserToolSession,
  unregisterBrowserToolSession
} from "../browserToolService.js";
import {
  registerGameToolSession,
  unregisterGameToolSession
} from "../gameToolService.js";
import {
  registerSkillToolSession,
  unregisterSkillToolSession
} from "../skillToolService.js";
import {
  registerButlerToolSession,
  unregisterButlerToolSession
} from "../butlerToolService.js";
import {
  registerDelegateToolSession,
  unregisterDelegateToolSession
} from "../delegationToolService.js";
import { BUTLERBUDDY_AGENT_ID } from "./agentProfiles.js";
import {
  registerContextToolSession,
  unregisterContextToolSession
} from "../contextToolService.js";
import {
  registerWorkspaceFsToolSession,
  unregisterWorkspaceFsToolSession
} from "../workspaceFsToolService.js";
import { getConversation } from "./conversations.js";
import type { AcpStdioMcpServer } from "../shared/browserToolProtocol.js";
import {
  clearAuthenticationTerminalsForSession,
  runAuthenticationTerminal
} from "./acpAuthTerminal.js";
import { logMain } from "../debugLog.js";
import { getCallerUserId, isCallerAdmin } from "./callerContext.js";
import {
  cleanupSandboxCommand,
  isRemoteIsolatedCaller,
  prepareSandboxedSpawn,
  shouldSandboxCurrentCaller
} from "./sandboxRuntime.js";
import { isPathWithinRoots } from "../shared/workspaceRoots.js";
import { clearSessionOwner } from "./sessionOwners.js";
import { getLanguage } from "./settings.js";
import {
  adapterAcceptsClientMcpServers,
  formatAcpAgentExitMessage,
  isDshAcpExperimentalWarningLine
} from "./adapters.js";

const PERMISSION_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
// An ACP turn blocks on a single session/prompt request that only resolves
// when the agent returns its final response. If a tool spawns a long-running
// child (for example a dev server) that holds the agent's stdio open, the
// agent stops emitting session/update frames and the prompt request never
// settles. Cancel the turn after this much continuous silence.
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
// When the inactivity watchdog fires, probe the agent with a read-only
// session/list before killing the run. If the agent responds, its main process
// is alive (most likely blocked on a silent long-running tool such as a
// sub-agent task) and the run is granted more time. Requires the adapter to
// implement session/list (advertised in agentCapabilities.sessionCapabilities);
// adapters that reject the probe are treated as unresponsive. Reprieves are
// capped so a permanently silent run still gets killed eventually.
const INACTIVITY_PING_TIMEOUT_MS = 15_000;
const MAX_INACTIVITY_REPRIEVES = 2;

function writeAcp(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  msg: AcpMessage
) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function contextResetInstruction(): string {
  // Agent-facing instruction (sent to the model). Keep it English for reliable
  // instruction-following across all models; UI language must not change it.
  return "The previous agent session reached its context limit. Continue from the current workspace state; do not repeat completed work. Re-check the current files and finish the request.";
}

function emptySessionResetInstruction(): string {
  // Agent-facing recovery instruction. The original prompt is retained before
  // this suffix so a newly created session can safely resume the same task.
  return "The previous agent session ended without producing output. Continue from the current workspace state; do not repeat completed work. Re-check the current files and finish the request.";
}

function contextWindowExceededAfterResetError(err: unknown): Error {
  const detail = (err as Error)?.message || String(err);
  return getLanguage() === "zh-CN"
    ? new Error(
        `重置会话后，请求仍超出模型的上下文窗口。请缩短提示内容，或切换到上下文窗口更大的模型后重试。原始错误：${detail}`
      )
    : new Error(
        `The request still exceeds the model's context window even after starting a fresh agent session. Shorten the prompt or switch to a model with a larger context window, then try again. Original error: ${detail}`
      );
}

export interface AcpRuntimeInput {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  webContents: WebContents;
  args: CliRunArgs;
  pid: number;
  logStream: fs.WriteStream | null;
  toolSessionId?: string;
  toolSessionScope?: string;
  running: Map<string, Running>;
  capturedSessions: Map<string, string>;
  emit: (e: CliEvent) => void;
  agentCommand: {
    bin: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
  };
  claudeAcpSessionOptions?: {
    settings: {
      autoCompactEnabled: boolean;
      autoCompactWindow?: number;
    };
  };
  restartAgent: () => Promise<{
    child: ChildProcessByStdio<Writable, Readable, Readable>;
    pid: number;
  }>;
}

export async function runAcpAgent({
  child: initialChild,
  webContents,
  args,
  pid: initialPid,
  logStream,
  toolSessionId,
  toolSessionScope,
  running,
  capturedSessions,
  emit,
  agentCommand,
  claudeAcpSessionOptions,
  restartAgent
}: AcpRuntimeInput): Promise<void> {
  let child = initialChild;
  let pid = initialPid;
  let requestedToolSessionId = toolSessionId;
  let requestId = 0;
  let activeAcpSessionId: string | undefined;
  let finished = false;
  let yieldRequested = false;
  let promptStarted = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityFired = false;
  let inactivityReprieves = 0;
  let promptHadContent = false;
  let turnHadTerminalError = false;
  let turnHadLiveAgentChunk = false;
  let sessionWasResumed = false;
  let mcpServers: AcpStdioMcpServer[] = [];
  let contextResetAttempted = false;
  let emptySessionResetAttempted = false;
  let nonRetryableUpstreamError: string | undefined;
  const activeToolCallIds = new Set<string>();
  let activePrompt = args.prompt;
  const sessionMeta: AcpSessionMeta | undefined = claudeAcpSessionOptions
    ? { claudeCode: { options: claudeAcpSessionOptions } }
    : undefined;
  const remoteIsolated = isRemoteIsolatedCaller();
  const readOnlyWorkspace = args.workspaceAccess === "read-only";
  // OS process sandbox follows the shared remote strictIsolation flag only.
  // Local read-only reviewers must not enter srt-win / seatbelt just because
  // roster.canWrite is false — that blocks CLIs installed under AppData.
  const processSandboxed = shouldSandboxCurrentCaller();
  const replayMessageIds = new Set(args.knownStreamMessageIds ?? []);
  const replayContentSignatures = new Set(
    args.knownStreamContentSignatures ?? []
  );
  // Qoder-style adapters stream live agent chunks WITHOUT a messageId and only
  // attach messageIds when replaying history on resume. When resuming such an
  // adapter (prior turns persisted zero agent messageIds), drop messageId-
  // carrying chunks until the first live chunk signals real generation.
  const suppressReplayByPhase = () =>
    sessionWasResumed &&
    (args.knownAgentStreamMessageIds ?? []).length === 0;
  const terminalManager = createAcpTerminalManager({
    defaultCwd: args.cwd,
    // Grok ACP and CodeBuddy ACP both send a complete command line in
    // `command` (for example `/bin/bash -lc pwd` or `git status`) without a
    // separate `args` array. Route those through the system shell instead of
    // spawning the whole string as an executable name (which fails with
    // ENOENT and silently reports exit 1 / no output).
    commandIsShellLine:
      args.adapter === "grok-acp" || args.adapter === "codebuddy-acp",
    prepareSpawn: processSandboxed
      ? async (input) => {
          const workspaceRoot = args.cwd;
          if (!workspaceRoot || !isPathWithinRoots(input.cwd, [workspaceRoot])) {
            throw new Error("forbidden_path: terminal cwd");
          }
          const prepared = await prepareSandboxedSpawn({
            adapter: args.adapter,
            bin: input.command,
            args: input.args,
            cwd: input.cwd,
            workspaceRoot,
            env: input.env,
            readOnlyWorkspace
          });
          return {
            command: prepared.bin,
            args: prepared.args,
            env: prepared.env
          };
        }
      : undefined,
    onPreparedSpawnExit: cleanupSandboxCommand,
    onSpawnError: ({ terminalId, command, args: spawnArgs, cwd, error }) => {
      logMain().error("acp", "terminal spawn failed", {
        adapter: args.adapter,
        sessionId: args.sessionId,
        terminalId,
        command,
        args: spawnArgs,
        cwd,
        error: error.message
      });
    },
    onOutput: (terminalId, snap) => {
      emit({
        type: "terminal-update",
        terminalId,
        output: snap.output,
        truncated: snap.truncated,
        exitCode: snap.exitCode,
        exited: snap.exited,
        running: !snap.exited
      });
    }
  });
  const pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (reason: Error) => void;
    }
  >();

  const nextId = () => ++requestId;
  const request = (msg: AcpMessage) =>
    new Promise<any>((resolve, reject) => {
      if (msg.id == null) {
        reject(new Error("ACP requests require an id"));
        return;
      }
      pending.set(String(msg.id), { resolve, reject });
      appendLog(logStream, "stdin", JSON.stringify(msg));
      writeAcp(child, msg);
    });
  const notify = (msg: AcpMessage) => {
    appendLog(logStream, "stdin", JSON.stringify(msg));
    writeAcp(child, msg);
  };
  const probeAgentLiveness = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const probeId = nextId();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pending.delete(String(probeId));
        resolve(false);
      }, INACTIVITY_PING_TIMEOUT_MS);
      pending.set(String(probeId), {
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        },
        reject: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
      const probeMsg = buildSessionListRequest(probeId);
      appendLog(logStream, "stdin", JSON.stringify(probeMsg));
      writeAcp(child, probeMsg);
    });

  const onInactivityExpired = async () => {
    if (args.sessionId && isInactivitySuppressed(args.sessionId)) {
      inactivityFired = false;
      return;
    }
    if (finished) return;
    const alive = await probeAgentLiveness();
    if (finished) return;
    const minutes = Math.round(INACTIVITY_TIMEOUT_MS / 60000);
    const hasActiveToolCall = activeToolCallIds.size > 0;
    if (
      (alive || hasActiveToolCall) &&
      inactivityReprieves < MAX_INACTIVITY_REPRIEVES
    ) {
      inactivityReprieves += 1;
      appendLog(
        logStream,
        "system",
        `inactivity after ${INACTIVITY_TIMEOUT_MS}ms; ${
          alive
            ? "agent responded to liveness probe"
            : `ACP tool call still active (${activeToolCallIds.size})`
        }; continuing (reprieve ${inactivityReprieves}/${MAX_INACTIVITY_REPRIEVES})`
      );
      inactivityFired = false;
      disarmInactivityTimer();
      armInactivityTimer();
      return;
    }
    appendLog(
      logStream,
      "system",
      `inactivity timeout after ${INACTIVITY_TIMEOUT_MS}ms with no agent output; cancelling`
    );
    cancelRun();
    finish(
      "failed",
      -1,
      hasActiveToolCall
        ? `Agent's active tool call produced no output for ${minutes} minutes and remained silent after ${MAX_INACTIVITY_REPRIEVES} watchdog reprieves.`
        : alive
        ? `Agent produced no output for ${minutes} minutes and was still silent after ${MAX_INACTIVITY_REPRIEVES} liveness probes. This usually means a tool spawned a long-running process (for example a dev server or sub-agent) that held the agent's output stream open.`
        : `Agent produced no output for ${minutes} minutes and did not respond to a liveness probe. This usually means a tool spawned a long-running process (for example a dev server) that held the agent's output stream open.`
    );
  };

  const armInactivityTimer = () => {
    if (args.sessionId && isInactivitySuppressed(args.sessionId)) {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      return;
    }
    if (INACTIVITY_TIMEOUT_MS <= 0) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (finished || inactivityFired) return;
    inactivityTimer = setTimeout(() => {
      if (finished || inactivityFired) return;
      inactivityFired = true;
      void onInactivityExpired();
    }, INACTIVITY_TIMEOUT_MS);
  };
  const disarmInactivityTimer = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = undefined;
    }
  };
  const finish = (
    status: "done" | "failed" | "killed",
    exitCode: number,
    errorMessage?: string
  ) => {
    if (finished) return;
    finished = true;
    disarmInactivityTimer();
    removeInactivitySuppression(args.sessionId);
    terminalManager.dispose();
    running.delete(args.sessionId);
    unregisterBrowserToolSession(args.sessionId);
    unregisterGameToolSession(args.sessionId);
    unregisterSkillToolSession(args.sessionId);
    unregisterButlerToolSession(args.sessionId);
    unregisterDelegateToolSession(args.sessionId);
    unregisterContextToolSession(args.sessionId);
    unregisterWorkspaceFsToolSession(args.sessionId);
    clearAuthenticationTerminalsForSession(args.sessionId);
    clearAuthenticationResolversForSession(args.sessionId);
    clearPermissionResolversForSession(args.sessionId);
    logMain()[status === "failed" ? "error" : "info"]("acp", `agent run ${status}`, {
      adapter: args.adapter,
      sessionId: args.sessionId,
      exitCode,
      ...(errorMessage ? { errorMessage } : {}),
      ...(agentInfo?.name ? { agentName: agentInfo.name } : {}),
      ...(agentInfo?.version ? { agentVersion: agentInfo.version } : {})
    });
    if (errorMessage) emit({ type: "error", message: errorMessage });
    emit({ type: "done", exitCode });
    // WebUI session events are routed through the in-memory owner mapping.
    // Keep it alive until the terminal events have been broadcast, otherwise
    // remote clients see streamed content but never receive done/error.
    clearSessionOwner(args.sessionId);
    updateTaskStatus(args.sessionId, status, exitCode, errorMessage);
    updateRuntimeRun(args.adapter, status === "failed" ? errorMessage : undefined);
    const discardToolSession = shouldDiscardAcpToolSession({
      adapter: args.adapter,
      status,
      promptStarted,
      promptHadContent,
      turnHadTerminalError
    });
    if (discardToolSession && toolSessionScope) {
      try {
        clearToolSession(args.agentId, toolSessionScope);
      } catch {
        /* best-effort */
      }
    } else if (activeAcpSessionId && toolSessionScope) {
      saveToolSession(args.agentId, toolSessionScope, args.adapter, activeAcpSessionId);
      setTaskToolSessionId(args.sessionId, activeAcpSessionId);
    }
    capturedSessions.delete(args.sessionId);
    logStream?.end();
  };

  const cancelRun = () => {
    clearAuthenticationTerminalsForSession(args.sessionId);
    if (activeAcpSessionId) {
      notify(buildSessionCancelNotification(activeAcpSessionId));
    }
    setTimeout(() => {
      const still = running.get(args.sessionId);
      if (still) {
        try {
          killProcessTree(still.child, "term");
        } catch {
          /* noop */
        }
      }
    }, 500);
  };
  const yieldRun = () => {
    if (finished || yieldRequested) return;
    yieldRequested = true;
    appendLog(logStream, "system", "delegate yield accepted; parking current ACP turn");
    cancelRun();
  };
  const updateRunningProcess = () => {
    running.set(args.sessionId, { child, pid, cancel: cancelRun, yield: yieldRun });
  };
  updateRunningProcess();

  const handleAcpLine = (line: string) => {
    appendLog(logStream, "stdout", line);
    const msg = parseAcpLine(line);
    if (!msg) {
      emit({ type: "stderr", content: line });
      return;
    }

    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const waiter = pending.get(String(msg.id));
      if (waiter) {
        pending.delete(String(msg.id));
        if (msg.error) {
          const err = new Error(msg.error.message);
          (err as Error & { code?: number; data?: unknown }).code = msg.error.code;
          (err as Error & { code?: number; data?: unknown }).data = msg.error.data;
          waiter.reject(err);
        } else {
          waiter.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method === "session/update") {
      const sessionId = msg.params?.sessionId;
      if (typeof sessionId === "string") {
        activeAcpSessionId = sessionId;
        capturedSessions.set(args.sessionId, sessionId);
      }
      const updateType = String(msg.params?.update?.sessionUpdate ?? "");
      if (promptStarted) {
        updateActiveAcpToolCalls(activeToolCallIds, msg.params?.update);
      }
      const upstreamFailure = acpNonRetryableUpstreamError(msg.params?.update);
      if (!nonRetryableUpstreamError && upstreamFailure) {
        nonRetryableUpstreamError = upstreamFailure;
        appendLog(
          logStream,
          "system",
          `non-retryable upstream error; cancelling ACP turn: ${upstreamFailure}`
        );
        if (activeAcpSessionId) {
          notify(buildSessionCancelNotification(activeAcpSessionId));
        }
      }
      if (updateType === "agent_message_chunk" || updateType === "agent_thought_chunk") {
        const chunkText = textFromContent(msg.params?.update?.content);
        if (chunkText) {
          lastAgentText = (lastAgentText + chunkText).slice(-2000);
        }
      } else if (updateType === "tool_call") {
        const rawCmd = msg.params?.update?.rawInput?.command;
        const cmd =
          typeof rawCmd === "string"
            ? rawCmd
            : typeof msg.params?.update?.title === "string"
              ? msg.params.update.title
              : "";
        if (cmd) lastToolCommand = cmd;
      }
      if (
        promptStarted &&
        /^(agent_message_chunk|agent_thought_chunk|tool_call|tool_call_update|plan)$/.test(
          updateType
        )
      ) {
        promptHadContent = true;
        armInactivityTimer();
      }
      if (
        shouldSkipUserMessageChunk(msg.params?.update, {
          userMessageId: args.userMessageId,
          promptText: args.prompt
        })
      ) {
        return;
      }
      const isAgentChunkForPhase =
        updateType === "agent_message_chunk" ||
        updateType === "agent_thought_chunk";
      const replayPhaseSuppressionEnabled = suppressReplayByPhase();
      if (isAgentChunkForPhase && replayPhaseSuppressionEnabled) {
        if (
          shouldDropReplayPhaseAgentChunk(msg.params?.update, {
            suppressReplayByPhase: replayPhaseSuppressionEnabled,
            turnHadLiveAgentChunk
          })
        ) {
          return;
        }
        const hasMessageId =
          typeof msg.params?.update?.messageId === "string" &&
          msg.params.update.messageId.length > 0;
        if (!hasMessageId) {
          turnHadLiveAgentChunk = true;
        }
      }
      if (
        !shouldEmitAcpUpdate(msg.params?.update, {
          promptStarted,
          replaySuppressionEnabled: sessionWasResumed,
          replayMessageIds,
          replayContentSignatures
        })
      ) {
        return;
      }
      const items = acpUpdateToItems(msg.params?.update, sessionId);
      if (
        items.some(
          (item) => item.kind === "error" && item.terminal === true
        )
      ) {
        turnHadTerminalError = true;
      }
      if (items.length) emit({ type: "items", items });
      return;
    }

    if (msg.method && msg.id != null) {
      if (msg.method === "session/request_permission") {
        handlePermissionRequest(msg);
      } else if (msg.method.startsWith("terminal/")) {
        void handleTerminalRequest(msg);
      } else {
        writeAcp(child, {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32601,
            message: `FreeBuddy does not implement ACP method ${msg.method}`
          }
        });
      }
    }
  };

  function normalizePermissionOptions(raw: unknown): CliPermissionOption[] {
    if (!Array.isArray(raw)) return [];
    const out: CliPermissionOption[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const optionId =
        typeof e.optionId === "string"
          ? e.optionId
          : typeof e.id === "string"
            ? e.id
            : undefined;
      if (!optionId) continue;
      out.push({
        optionId,
        name:
          typeof e.name === "string"
            ? e.name
            : typeof e.label === "string"
              ? (e.label as string)
              : undefined,
        kind: typeof e.kind === "string" ? (e.kind as string) : undefined
      });
    }
    return out;
  }

  function pickAutoApprovedOption(
    options: CliPermissionOption[]
  ): CliPermissionOption | undefined {
    const allowOnce = options.find((o) => o.kind === "allow_once");
    if (allowOnce) return allowOnce;
    const allowAlways = options.find((o) => o.kind === "allow_always");
    if (allowAlways) return allowAlways;
    const idHint = options.find((o) => /^allow(-|_)?(once|always)?$/i.test(o.optionId));
    if (idHint) return idHint;
    return undefined;
  }

  function respondToPermission(
    requestRpcId: AcpRequestId,
    decision: CliPermissionDecision
  ) {
    if (decision.outcome === "selected") {
      writeAcp(child, {
        jsonrpc: "2.0",
        id: requestRpcId,
        result: {
          outcome: { outcome: "selected", optionId: decision.optionId }
        }
      });
    } else {
      writeAcp(child, {
        jsonrpc: "2.0",
        id: requestRpcId,
        result: { outcome: { outcome: "cancelled" } }
      });
    }
  }

  function handlePermissionRequest(msg: AcpMessage) {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const options = normalizePermissionOptions(params.options);
    const requestRpcId = msg.id!;

    if (args.approvalMode === "auto") {
      const auto = pickAutoApprovedOption(options);
      if (auto) {
        appendLog(
          logStream,
          "system",
          `permission auto-approved (${auto.optionId})`
        );
        respondToPermission(requestRpcId, {
          outcome: "selected",
          optionId: auto.optionId
        });
        return;
      }
      // An auto-approved run has no renderer prompt to resolve. Cancelling is
      // safer than leaving the ACP request pending forever when an adapter
      // exposes only an unsupported permission shape.
      appendLog(
        logStream,
        "system",
        "permission auto-cancelled (no allow option)"
      );
      respondToPermission(requestRpcId, { outcome: "cancelled" });
      return;
    }

    if (options.length === 0) {
      appendLog(
        logStream,
        "system",
        "permission request had no options; cancelling"
      );
      respondToPermission(requestRpcId, { outcome: "cancelled" });
      return;
    }

    const requestId = randomUUID();
    const toolCallRaw =
      (params.toolCall as Record<string, unknown> | undefined) ?? undefined;
    const toolCall = toolCallRaw
      ? {
          toolCallId:
            typeof toolCallRaw.toolCallId === "string"
              ? (toolCallRaw.toolCallId as string)
              : typeof toolCallRaw.id === "string"
                ? (toolCallRaw.id as string)
                : undefined,
          title:
            typeof toolCallRaw.title === "string"
              ? (toolCallRaw.title as string)
              : undefined,
          kind:
            typeof toolCallRaw.kind === "string"
              ? (toolCallRaw.kind as string)
              : undefined,
          rawInput: toolCallRaw.rawInput,
          locations: toolCallRaw.locations
        }
      : undefined;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    registerPermissionResolver(args.sessionId, requestId, (decision) => {
      if (timeout) clearTimeout(timeout);
      appendLog(
        logStream,
        "system",
        `permission decision (${requestId}): ${
          decision.outcome === "selected"
            ? `selected ${decision.optionId}`
            : "cancelled"
        }`
      );
      respondToPermission(requestRpcId, decision);
      emit({ type: "permission-resolved", requestId });
    });

    timeout = setTimeout(() => {
      const resolver = takePermissionResolver(args.sessionId, requestId);
      if (!resolver) return;
      appendLog(
        logStream,
        "system",
        `permission timeout (${requestId}) after ${PERMISSION_REQUEST_TIMEOUT_MS}ms`
      );
      resolver({ outcome: "cancelled" });
    }, PERMISSION_REQUEST_TIMEOUT_MS);

    appendLog(
      logStream,
      "system",
      `permission requested (${requestId}) options=${options.map((o) => o.optionId).join(",")}`
    );
    emit({
      type: "permission",
      request: {
        requestId,
        sessionId: args.sessionId,
        acpSessionId:
          typeof params.sessionId === "string"
            ? (params.sessionId as string)
            : activeAcpSessionId,
        toolCall,
        options
      }
    });
  }

  async function handleTerminalRequest(msg: AcpMessage) {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const requestRpcId = msg.id!;
    const respond = (result: Record<string, unknown>) => {
      writeAcp(child, { jsonrpc: "2.0", id: requestRpcId, result });
    };
    const respondError = (message: string) => {
      writeAcp(child, {
        jsonrpc: "2.0",
        id: requestRpcId,
        error: { code: -32603, message }
      });
    };

    try {
      switch (msg.method) {
        case "terminal/create": {
          const sessionId =
            typeof params.sessionId === "string"
              ? params.sessionId
              : activeAcpSessionId;
          const command = typeof params.command === "string" ? params.command : "";
          if (!sessionId || !command) {
            respondError("terminal/create requires sessionId and command");
            return;
          }
          const argsList = Array.isArray(params.args)
            ? params.args.map((entry) => String(entry))
            : undefined;
          const env = Array.isArray(params.env)
            ? params.env
                .map((entry) => {
                  const item = entry as { name?: unknown; value?: unknown };
                  if (typeof item?.name !== "string") return undefined;
                  return {
                    name: item.name,
                    value: String(item.value ?? "")
                  };
                })
                .filter(
                  (entry): entry is { name: string; value: string } =>
                    entry != null
                )
            : undefined;
          const created = await terminalManager.create({
            sessionId,
            command,
            args: argsList,
            cwd: typeof params.cwd === "string" ? params.cwd : args.cwd,
            env,
            outputByteLimit:
              typeof params.outputByteLimit === "number"
                ? params.outputByteLimit
                : undefined
          });
          respond({ terminalId: created.terminalId });
          return;
        }
        case "terminal/output": {
          const terminalId =
            typeof params.terminalId === "string" ? params.terminalId : "";
          if (!terminalId) {
            respondError("terminal/output requires terminalId");
            return;
          }
          const snap = terminalManager.output(terminalId);
          respond(buildTerminalOutputResponse(snap));
          return;
        }
        case "terminal/wait_for_exit": {
          const terminalId =
            typeof params.terminalId === "string" ? params.terminalId : "";
          if (!terminalId) {
            respondError("terminal/wait_for_exit requires terminalId");
            return;
          }
          const result = await terminalManager.waitForExit(terminalId);
          respond({
            ...(result.exitCode != null ? { exitCode: result.exitCode } : {}),
            ...(result.signal ? { signal: result.signal } : {})
          });
          return;
        }
        case "terminal/kill": {
          const terminalId =
            typeof params.terminalId === "string" ? params.terminalId : "";
          if (!terminalId) {
            respondError("terminal/kill requires terminalId");
            return;
          }
          terminalManager.kill(terminalId);
          respond({});
          return;
        }
        case "terminal/release": {
          const terminalId =
            typeof params.terminalId === "string" ? params.terminalId : "";
          if (!terminalId) {
            respondError("terminal/release requires terminalId");
            return;
          }
          terminalManager.release(terminalId);
          respond({});
          return;
        }
        default:
          respondError(`Unsupported terminal method ${msg.method}`);
      }
    } catch (err) {
      respondError((err as Error)?.message || String(err));
    }
  }

  let connectionEpoch = 0;
  let rlOut: readline.Interface | undefined;
  let rlErr: readline.Interface | undefined;
  let recentStderr: string[] = [];
  let lastAgentText = "";
  let lastToolCommand = "";

  const attachConnection = () => {
    const epoch = ++connectionEpoch;
    recentStderr = [];
    lastAgentText = "";
    lastToolCommand = "";
    rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", (line) => {
      if (epoch === connectionEpoch) handleAcpLine(line);
    });
    rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      if (epoch !== connectionEpoch) return;
      appendLog(logStream, "stderr", line);
      if (
        args.adapter === "dsh-acp" &&
        isDshAcpExperimentalWarningLine(line)
      ) {
        return;
      }
      recentStderr.push(line);
      if (recentStderr.length > 50) recentStderr.shift();
      if (args.showStderr !== false) emit({ type: "stderr", content: line });
    });
    child.on("close", (code) => {
      if (epoch !== connectionEpoch) return;
      const exitCode = code ?? -1;
      for (const waiter of pending.values()) {
        waiter.reject(
          new Error(
            formatAcpAgentExitMessage(exitCode, getLanguage(), args.adapter)
          )
        );
      }
      pending.clear();
      if (finished) return;
      appendLog(logStream, "system", `exit code=${exitCode}`);
      if (yieldRequested) {
        finish("done", 0);
        return;
      }
      const status = exitCode === 0 ? "done" : "failed";
      const stderrTail = recentStderr.slice(-40).join("\n").trim();
      const commandTail = lastToolCommand.slice(-500).trim();
      const agentTail = lastAgentText.slice(-800).trim();
      const crashMessage =
        status === "failed"
          ? stderrTail ||
            (commandTail ? `Last command before exit: ${commandTail}` : "") ||
            (agentTail ? `Agent output before exit: ${agentTail}` : "") ||
            formatAcpAgentExitMessage(exitCode, getLanguage(), args.adapter)
          : undefined;
      finish(status, exitCode, crashMessage);
    });
  };
  attachConnection();

  let agentCaps: any = {};
  let authMethods: AcpAuthMethod[] = [];
  let authenticationAttempted = false;
  let agentInfo: { name?: string; version?: string } | undefined;

  const applyInitialize = (init: any) => {
    agentCaps = init?.agentCapabilities ?? {};
    authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    // ACP-compliant adapters (codex-acp, ...) expose { name, version } under
    // agentInfo. Others (grok-acp, ...) omit agentInfo and stash the version in
    // _meta.agentVersion instead; fall back to both so every adapter is logged.
    const info = init?.agentInfo;
    const meta = init?._meta;
    const agentName =
      typeof info?.name === "string"
        ? info.name
        : typeof info?.title === "string"
          ? info.title
          : undefined;
    const agentVersion =
      typeof info?.version === "string"
        ? info.version
        : typeof meta?.agentVersion === "string"
          ? meta.agentVersion
          : undefined;
    agentInfo =
      agentName || agentVersion ? { name: agentName, version: agentVersion } : undefined;
    logMain().info("acp", "agent initialized", {
      adapter: args.adapter,
      sessionId: args.sessionId,
      ...(agentName ? { agentName } : {}),
      ...(agentVersion ? { agentVersion } : {})
    });
  };

  const stopAcpConnectionForAuthentication = async () => {
    const stoppingChild = child;
    connectionEpoch += 1;
    rlOut?.close();
    rlErr?.close();
    for (const waiter of pending.values()) {
      waiter.reject(new Error("ACP connection restarting for authentication."));
    }
    pending.clear();
    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      stoppingChild.once("close", done);
      setTimeout(done, 2000);
      try {
        killProcessTree(stoppingChild, "term");
      } catch {
        done();
      }
    });
  };

  const restartAndInitialize = async () => {
    const restarted = await restartAgent();
    child = restarted.child;
    pid = restarted.pid;
    activeAcpSessionId = undefined;
    promptStarted = false;
    promptHadContent = false;
    turnHadLiveAgentChunk = false;
    sessionWasResumed = false;
    updateRunningProcess();
    attachConnection();
    const init = await request(buildInitializeRequest(nextId()));
    if (init?.protocolVersion !== 1) {
      throw new Error(
        `Unsupported ACP protocol version ${String(init?.protocolVersion ?? "missing")}; FreeBuddy supports version 1.`
      );
    }
    applyInitialize(init);
  };

  const establishSession = async () => {
    const emitSetupItems = (result: any) => {
      if (!activeAcpSessionId) return;
      const items = acpSessionSetupToItems(activeAcpSessionId, result).map(
        (item) => item.kind === "config-options"
          ? {
              ...item,
              options: mergeCliByokModelOption(
                args.agentId,
                args.adapter,
                item.options,
                args.configOptionOverrides?.model
              )
            }
          : item
      );
      if (items.length) emit({ type: "items", items });
    };

    sessionWasResumed = false;
    const sessionStartMode = selectAcpSessionStartMode(
      requestedToolSessionId,
      agentCaps
    );
    if (sessionStartMode === "load") {
      const loaded = await request(
        buildSessionLoadRequest(
          nextId(),
          requestedToolSessionId!,
          args.cwd,
          mcpServers,
          sessionMeta
        )
      );
      activeAcpSessionId = requestedToolSessionId!;
      sessionWasResumed = true;
      emitSetupItems(loaded);
    } else if (sessionStartMode === "resume") {
      const resumed = await request(
        buildSessionResumeRequest(
          nextId(),
          requestedToolSessionId!,
          args.cwd,
          mcpServers,
          sessionMeta
        )
      );
      activeAcpSessionId = requestedToolSessionId!;
      sessionWasResumed = true;
      emitSetupItems(resumed);
    } else {
      const created = await request(
        buildSessionNewRequest(nextId(), args.cwd, mcpServers, sessionMeta)
      );
      activeAcpSessionId = created?.sessionId ?? created?.session_id;
      emitSetupItems(created);
    }
  };

  const syncSessionMetadataFromList = async () => {
    if (!agentCaps?.sessionCapabilities?.list || !activeAcpSessionId) return;
    try {
      const listed = await request(buildSessionListRequest(nextId(), args.cwd));
      const items = acpSessionListToItems(activeAcpSessionId, listed);
      if (items.length) emit({ type: "items", items });
    } catch {
      /* best-effort */
    }
  };

  const runPromptOnSession = async () => {
    emit({
      type: "items",
      items: [{ kind: "session", sessionId: activeAcpSessionId! }]
    });
    promptStarted = true;
    promptHadContent = false;
    turnHadTerminalError = false;
    turnHadLiveAgentChunk = false;
    inactivityReprieves = 0;
    activeToolCallIds.clear();
    // Live generation begins here. Replay suppression (sessionWasResumed) must
    // be confined to the pre-prompt replay phase; keeping it enabled would drop
    // live agent chunks whose text matches a persisted history signature.
    sessionWasResumed = false;
    armInactivityTimer();
    try {
      const promptResult = await request(
        buildSessionPromptRequest(
          nextId(),
          activeAcpSessionId!,
          activePrompt,
          args.promptAttachments
        )
      );
      const resultItems = acpPromptResultToItems(promptResult);
      if (resultItems.length) {
        emit({ type: "items", items: resultItems });
      }
    } finally {
      disarmInactivityTimer();
    }
  };

  const authRequiredError = (methods: AcpAuthMethod[]) => {
    const selected = selectAcpAuthMethod(methods, agentCommand.env);
    const method = selected ?? methods[0];
    const label = method?.name ? ` (${method.name})` : "";
    const unsupportedType =
      method?.type && method.type !== "agent"
        ? ` The agent requested unsupported ${method.type} authentication.`
        : "";
    return new Error(
      `Authentication required${label}.${unsupportedType} Log in to this agent from your terminal, then retry the task.`
    );
  };

  const chooseAuthMethod = async (
    methods: AcpAuthMethod[]
  ): Promise<AcpAuthMethod> => {
    const automatic = selectAcpAuthMethod(methods, agentCommand.env);
    if (automatic) return automatic;

    const supported = methods.filter(
      (method) =>
        typeof method?.id === "string" &&
        method.id.length > 0 &&
        (method.type == null ||
          method.type === "agent" ||
          method.type === "terminal")
    );
    if (supported.length < 2) throw authRequiredError(methods);

    const requestId = randomUUID();
    return new Promise<AcpAuthMethod>((resolve, reject) => {
      registerAuthenticationResolver(args.sessionId, requestId, (decision) => {
        emit({ type: "authentication-resolved", requestId });
        if (decision.outcome !== "selected") {
          reject(new Error("Authentication cancelled."));
          return;
        }
        const selected = supported.find(
          (method) => method.id === decision.methodId
        );
        if (!selected) {
          reject(new Error("The selected authentication method is unavailable."));
          return;
        }
        resolve(selected);
      });
      emit({
        type: "authentication",
        request: {
          requestId,
          sessionId: args.sessionId,
          agentName: args.agentName,
          methods: supported.map((method) => ({
            methodId: method.id,
            name: method.name ?? method.id,
            ...(method.description ? { description: method.description } : {})
          }))
        }
      });
    });
  };

  const authenticate = async (methods: AcpAuthMethod[]) => {
    const method = await chooseAuthMethod(methods);
    authenticationAttempted = true;
    appendLog(
      logStream,
      "system",
      `authenticating with ACP method ${method.id}`
    );
    if (method.type === "terminal") {
      if (getCallerUserId() && !isCallerAdmin()) {
        throw new Error(
          "Remote interactive agent login is disabled. Configure the agent on the FreeBuddy desktop first."
        );
      }
      await stopAcpConnectionForAuthentication();
      await runAuthenticationTerminal({
        sessionId: args.sessionId,
        agentName: args.agentName,
        method,
        command: agentCommand,
        emit
      });
      await restartAndInitialize();
      await request(buildAuthenticateRequest(nextId(), method.id));
      return true;
    }
    if (remoteIsolated && args.adapter.includes("grok")) {
      throw authRequiredError(methods);
    }
    await request(buildAuthenticateRequest(nextId(), method.id));
    return false;
  };

  const isAuthenticationRequiredError = (err: unknown) => {
    const e = err as Error & { code?: number };
    if (e?.code === -32000) return true;
    if (e?.code === 401 || e?.code === 403) return true;
    const message = String(e?.message ?? err).toLowerCase();
    return /\b(auth|unauthorized|unauthenticated|login|credential|api key|subscription)\b/.test(
      message
    );
  };

  const isContextWindowError = (err: unknown) => {
    const message = String((err as Error)?.message ?? err).toLowerCase();
    return /context window|context length|input exceeds|prompt is too long|too many tokens/.test(
      message
    );
  };

  const abandonStaleToolSession = (sessionId: string, err: unknown) => {
    const detail = (err as Error)?.message || String(err);
    appendLog(
      logStream,
      "system",
      `saved ACP session unavailable (${sessionId}); starting a fresh session: ${detail}`
    );
    emit({
      type: "stderr",
      content:
        "Previous agent session is no longer available; starting a fresh session."
    });
    if (toolSessionScope) {
      try {
        clearToolSession(args.agentId, toolSessionScope);
      } catch {
        /* best-effort */
      }
    }
    requestedToolSessionId = undefined;
    activeAcpSessionId = undefined;
    sessionWasResumed = false;
  };

  try {
    const init = await request(buildInitializeRequest(nextId()));
    if (init?.protocolVersion !== 1) {
      throw new Error(
        `Unsupported ACP protocol version ${String(init?.protocolVersion ?? "missing")}; FreeBuddy supports version 1.`
      );
    }
    applyInitialize(init);

    // Browser bridges back into the desktop renderer over localhost
    // and launches an Electron child process. Remote WebUI callers use the
    // authenticated HTTP Browser endpoints instead, so do not expose this
    // desktop-only capability to isolated remote users.
    // DeepSeek Harness ACP rejects non-empty mcpServers on session/new.
    if (adapterAcceptsClientMcpServers(args.adapter)) {
      if (args.conversationId && !remoteIsolated) {
        mcpServers.push(
          await registerBrowserToolSession({
            taskSessionId: args.sessionId,
            conversationId: args.conversationId,
            // Keep an unscoped conversation unscoped. ACP itself requires a cwd
            // and falls back to process.cwd(), but Browser must not treat the app's
            // launch directory as a user-selected workspace.
            cwd: args.cwd ?? "",
            webContents
          })
        );
      }
      if (args.conversationId) {
        const conv = getConversation(args.conversationId);
        const isGameSession =
          conv?.kind === "game" ||
          args.skills?.some((s) => s.id === "game-arena" || s.name === "game-arena");
        if (isGameSession) {
          const gameType = (conv?.metadata?.gameType as any) || "gomoku";
          mcpServers.push(
            await registerGameToolSession({
              taskSessionId: args.sessionId,
              conversationId: args.conversationId,
              gameType,
              webContents
            })
          );
        }
      }
      if (args.skills?.length) {
        mcpServers.push(registerSkillToolSession(args.sessionId, args.skills));
      }
      if (args.agentId === BUTLERBUDDY_AGENT_ID && !remoteIsolated) {
        mcpServers.push(
          await registerButlerToolSession({
            taskSessionId: args.sessionId,
            agentId: args.agentId,
            userId: getCallerUserId(),
            webContents
          })
        );
      }
      if (args.delegation) {
        mcpServers.push(
          await registerDelegateToolSession({
            taskSessionId: args.sessionId,
            runId: args.delegation.runId,
            parentEventId: args.delegation.parentEventId,
            depth: args.delegation.depth,
            selfAgentId: args.delegation.selfAgentId,
            selfLabel: args.delegation.selfLabel,
            ownerId: getCallerUserId(),
            webContents
          })
        );
      }
      if (args.contextReferences?.length) {
        mcpServers.push(
          registerContextToolSession(args.sessionId, args.contextReferences)
        );
      }
      const roots = (args.workspaceRoots ?? [])
        .map((root) => (typeof root === "string" ? root.trim() : ""))
        .filter(Boolean);
      if (roots.length > 1) {
        const primary = args.cwd || roots[0];
        mcpServers.push(
          await registerWorkspaceFsToolSession({
            taskSessionId: args.sessionId,
            roots,
            primary
          })
        );
      }
    }
    if (mcpServers.length) {
      appendLog(
        logStream,
        "system",
        `mcp servers=${mcpServers.map((server) => server.name).join(",")} draftCwd=${args.cwd || "<none>"}`
      );
    }

    try {
      await establishSession();
    } catch (sessionErr) {
      if (
        !finished &&
        authMethods.length > 0 &&
        isAuthenticationRequiredError(sessionErr)
      ) {
        await authenticate(authMethods);
        await establishSession();
      } else if (
        !finished &&
        requestedToolSessionId &&
        isMissingSavedSessionError(sessionErr)
      ) {
        abandonStaleToolSession(requestedToolSessionId, sessionErr);
        await establishSession();
      } else {
        throw sessionErr;
      }
    }

    if (!activeAcpSessionId) {
      throw new Error("ACP agent did not return a sessionId");
    }

    const applyConfigOptionOverrides = async () => {
      const overrides = args.configOptionOverrides;
      if (!overrides || !activeAcpSessionId) return;
      for (const [configId, value] of Object.entries(overrides)) {
        if (!configId || value == null || value === "") continue;
        if (
          configId === "model" &&
          (args.adapter === "claude-agent-acp" || args.adapter === "claude") &&
          hasCliByokModels(args.agentId, args.adapter)
        ) {
          continue;
        }
        try {
          const result = await request(
            buildSessionSetConfigOptionRequest(
              nextId(),
              activeAcpSessionId,
              configId,
              value
            )
          );
          const setupItems = acpSessionSetupToItems(activeAcpSessionId, {
            sessionId: activeAcpSessionId,
            ...(result && typeof result === "object" ? result : {})
          });
          if (configId === "model") {
            const actualModel = setupItems
              .find((item) => item.kind === "config-options")
              ?.options.find(
                (option) => option.id === "model" || option.category === "model"
              )?.currentValue;
            const normalizeModel = (model: string) =>
              model
                .trim()
                .replace(/\[(?:none|low|medium|high|xhigh|max)\]$/i, "");
            if (
              actualModel &&
              normalizeModel(actualModel) !== normalizeModel(value)
            ) {
              throw new Error(
                `agent kept ${actualModel} after selecting ${value}`
              );
            }
          }
          const items = setupItems
            .filter((item) => item.kind === "config-options")
            .map((item) => item.kind === "config-options"
              ? {
                  ...item,
                  options: mergeCliByokModelOption(
                    args.agentId,
                    args.adapter,
                    item.options,
                    args.configOptionOverrides?.model
                  )
                }
              : item
            );
          if (items.length) emit({ type: "items", items });
        } catch (err) {
          const message = (err as Error)?.message || String(err);
          appendLog(
            logStream,
            "system",
            `set_config_option failed id=${configId}: ${message}`
          );
          emit({
            type: "stderr",
            content: `Failed to set config option ${configId}: ${message}`
          });
          // A failed model switch would send the prompt to the wrong provider
          // model. Other optional config controls remain best-effort.
          if (configId === "model") {
            throw new Error(`Failed to select model ${value}: ${message}`);
          }
        }
      }
    };

    await applyConfigOptionOverrides();
    const initialPromptResumedSession = sessionWasResumed;
    try {
      await runPromptOnSession();
    } catch (promptErr) {
      if (yieldRequested) {
        // session/cancel rejects the outstanding prompt request. This is an
        // intentional park, not an agent failure or a context/auth retry.
      } else if (nonRetryableUpstreamError) {
        throw new Error(nonRetryableUpstreamError);
      } else if (!finished && !contextResetAttempted && isContextWindowError(promptErr)) {
        contextResetAttempted = true;
        const exhaustedSessionId = activeAcpSessionId;
        appendLog(
          logStream,
          "system",
          `context window exceeded; starting a fresh ACP session${
            exhaustedSessionId ? ` from ${exhaustedSessionId}` : ""
          }`
        );
        if (exhaustedSessionId && agentCaps?.sessionCapabilities?.close) {
          try {
            await request(buildSessionCloseRequest(nextId(), exhaustedSessionId));
          } catch {
            /* best-effort */
          }
        }
        requestedToolSessionId = undefined;
        activeAcpSessionId = undefined;
        activePrompt = [
          args.prompt.trimEnd(),
          "",
          contextResetInstruction()
        ].join("\n");
        await establishSession();
        await applyConfigOptionOverrides();
        try {
          await runPromptOnSession();
        } catch (resetErr) {
          // A fresh session may still overflow (e.g. the prompt alone exceeds
          // the model's window). Surface a friendly error instead of the raw
          // ACP failure, since the reset path is already exhausted.
          if (!finished && isContextWindowError(resetErr)) {
            throw contextWindowExceededAfterResetError(resetErr);
          }
          throw resetErr;
        }
      } else if (
        !finished &&
        !promptHadContent &&
        authMethods.length > 0 &&
        isAuthenticationRequiredError(promptErr)
      ) {
        const restarted = await authenticate(authMethods);
        if (restarted) await establishSession();
        await runPromptOnSession();
      } else {
        throw promptErr;
      }
    }
    if (nonRetryableUpstreamError) {
      throw new Error(nonRetryableUpstreamError);
    }

    if (
      !finished &&
      shouldRetryEmptyResumedDshTurn({
        adapter: args.adapter,
        resumed: initialPromptResumedSession,
        promptHadContent,
        resetAttempted: emptySessionResetAttempted
      })
    ) {
      emptySessionResetAttempted = true;
      const emptySessionId = activeAcpSessionId;
      appendLog(
        logStream,
        "system",
        `saved DeepSeek ACP session returned an empty turn; starting a fresh session${
          emptySessionId ? ` from ${emptySessionId}` : ""
        }`
      );
      emit({
        type: "stderr",
        content:
          "Previous DeepSeek session returned no output; retrying once in a fresh session."
      });
      if (toolSessionScope) {
        try {
          clearToolSession(args.agentId, toolSessionScope);
        } catch {
          /* best-effort */
        }
      }
      requestedToolSessionId = undefined;
      activeAcpSessionId = undefined;
      sessionWasResumed = false;
      activePrompt = [
        args.prompt.trimEnd(),
        "",
        emptySessionResetInstruction()
      ].join("\n");
      await establishSession();
      await applyConfigOptionOverrides();
      await runPromptOnSession();
      if (nonRetryableUpstreamError) {
        throw new Error(nonRetryableUpstreamError);
      }
    }
    await syncSessionMetadataFromList();

    // Some agents (e.g. kimi when signed out) let session creation succeed but
    // return an empty turn because the model layer is unauthenticated. If the
    // agent advertised auth methods and produced nothing, treat it as a missing
    // login rather than a silent success.
    if (!promptHadContent && authMethods.length > 0 && !finished) {
      if (!authenticationAttempted) {
        const restarted = await authenticate(authMethods);
        if (restarted) await establishSession();
        await runPromptOnSession();
      }
      if (!promptHadContent) throw authRequiredError(authMethods);
    }

    if (agentCaps?.sessionCapabilities?.close) {
      try {
        await request(buildSessionCloseRequest(nextId(), activeAcpSessionId!));
      } catch {
        /* best-effort */
      }
    }
    appendLog(logStream, "system", "prompt complete; finalizing ACP turn");
    finish("done", 0);
    try {
      child.stdin.end();
    } catch {
      /* noop */
    }
    setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          killProcessTree(child, "term");
        } catch {
          /* noop */
        }
      }
    }, 250);
  } catch (e) {
    if (yieldRequested) {
      finish("done", 0);
      return;
    }
    const msg = (e as Error)?.message || String(e);
    appendLog(logStream, "system", msg);
    try {
      child.stdin.end();
    } catch {
      /* noop */
    }
    finish("failed", -1, msg);
  }
}

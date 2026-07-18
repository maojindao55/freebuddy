import readline from "node:readline";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { WebContents } from "electron";

import {
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
  selectAcpAuthMethod,
  shouldDropReplayPhaseAgentChunk,
  shouldEmitAcpUpdate,
  shouldSkipUserMessageChunk,
  type AcpAuthMethod,
  type AcpMessage,
  type AcpRequestId
} from "./acp.js";
import { createAcpTerminalManager } from "./acpTerminal.js";
import { updateRuntimeRun } from "./check.js";
import {
  hasCliByokModels,
  mergeCliByokModelOption,
  saveToolSession
} from "./store.js";
import {
  appendLog,
  clearAuthenticationResolversForSession,
  clearPermissionResolversForSession,
  registerAuthenticationResolver,
  registerPermissionResolver,
  setTaskToolSessionId,
  updateTaskStatus,
  type CliEvent,
  type CliPermissionDecision,
  type CliPermissionOption,
  type CliRunArgs,
  type Running
} from "./runtimeShared.js";
import { killProcessTree } from "./process-kill.js";
import {
  registerDraftToolSession,
  unregisterDraftToolSession
} from "../draftToolService.js";
import {
  registerBrowserToolSession,
  unregisterBrowserToolSession
} from "../browserToolService.js";
import {
  registerSkillToolSession,
  unregisterSkillToolSession
} from "../skillToolService.js";
import {
  registerContextToolSession,
  unregisterContextToolSession
} from "../contextToolService.js";
import type { AcpStdioMcpServer } from "../shared/draftToolProtocol.js";
import {
  clearAuthenticationTerminalsForSession,
  runAuthenticationTerminal
} from "./acpAuthTerminal.js";

function writeAcp(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  msg: AcpMessage
) {
  child.stdin.write(JSON.stringify(msg) + "\n");
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
  restartAgent
}: AcpRuntimeInput): Promise<void> {
  let child = initialChild;
  let pid = initialPid;
  let requestId = 0;
  let activeAcpSessionId: string | undefined;
  let finished = false;
  let promptStarted = false;
  let promptHadContent = false;
  let turnHadLiveAgentChunk = false;
  let mcpServers: AcpStdioMcpServer[] = [];
  const replayMessageIds = new Set(args.knownStreamMessageIds ?? []);
  const replayContentSignatures = new Set(
    args.knownStreamContentSignatures ?? []
  );
  // Qoder-style adapters stream live agent chunks WITHOUT a messageId and only
  // attach messageIds when replaying history on resume. When resuming such an
  // adapter (prior turns persisted zero agent messageIds), drop messageId-
  // carrying chunks until the first live chunk signals real generation.
  const suppressReplayByPhase =
    Boolean(toolSessionId) &&
    (args.knownAgentStreamMessageIds ?? []).length === 0;
  const terminalManager = createAcpTerminalManager({
    defaultCwd: args.cwd,
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
  const finish = (
    status: "done" | "failed" | "killed",
    exitCode: number,
    errorMessage?: string
  ) => {
    if (finished) return;
    finished = true;
    terminalManager.dispose();
    running.delete(args.sessionId);
    unregisterDraftToolSession(args.sessionId);
    unregisterBrowserToolSession(args.sessionId);
    unregisterSkillToolSession(args.sessionId);
    unregisterContextToolSession(args.sessionId);
    clearAuthenticationTerminalsForSession(args.sessionId);
    clearAuthenticationResolversForSession(args.sessionId);
    clearPermissionResolversForSession(args.sessionId);
    if (errorMessage) emit({ type: "error", message: errorMessage });
    emit({ type: "done", exitCode });
    updateTaskStatus(args.sessionId, status, exitCode, errorMessage);
    updateRuntimeRun(args.adapter, status === "failed" ? errorMessage : undefined);
    if (activeAcpSessionId && toolSessionScope) {
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
  const updateRunningProcess = () => {
    running.set(args.sessionId, { child, pid, cancel: cancelRun });
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
      if (
        promptStarted &&
        /^(agent_message_chunk|agent_thought_chunk|tool_call|tool_call_update|plan)$/.test(
          updateType
        )
      ) {
        promptHadContent = true;
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
      if (isAgentChunkForPhase && suppressReplayByPhase) {
        if (
          shouldDropReplayPhaseAgentChunk(msg.params?.update, {
            suppressReplayByPhase,
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
          replayMessageIds,
          replayContentSignatures
        })
      ) {
        return;
      }
      const items = acpUpdateToItems(msg.params?.update, sessionId);
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
      // Fall through to manual prompting if no allow option is present.
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

    registerPermissionResolver(args.sessionId, requestId, (decision) => {
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
          const created = terminalManager.create({
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

  const attachConnection = () => {
    const epoch = ++connectionEpoch;
    rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", (line) => {
      if (epoch === connectionEpoch) handleAcpLine(line);
    });
    rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      if (epoch !== connectionEpoch) return;
      appendLog(logStream, "stderr", line);
      if (args.showStderr !== false) emit({ type: "stderr", content: line });
    });
    child.on("close", (code) => {
      if (epoch !== connectionEpoch) return;
      const exitCode = code ?? -1;
      for (const waiter of pending.values()) {
        waiter.reject(new Error(`ACP agent exited with code ${exitCode}`));
      }
      pending.clear();
      if (finished) return;
      appendLog(logStream, "system", `exit code=${exitCode}`);
      finish(exitCode === 0 ? "done" : "failed", exitCode);
    });
  };
  attachConnection();

  let agentCaps: any = {};
  let authMethods: AcpAuthMethod[] = [];
  let authenticationAttempted = false;

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
    updateRunningProcess();
    attachConnection();
    const init = await request(buildInitializeRequest(nextId()));
    if (init?.protocolVersion !== 1) {
      throw new Error(
        `Unsupported ACP protocol version ${String(init?.protocolVersion ?? "missing")}; FreeBuddy supports version 1.`
      );
    }
    agentCaps = init?.agentCapabilities ?? {};
    authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
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

    if (toolSessionId && agentCaps?.loadSession) {
      const loaded = await request(
        buildSessionLoadRequest(nextId(), toolSessionId, args.cwd, mcpServers)
      );
      activeAcpSessionId = toolSessionId;
      emitSetupItems(loaded);
    } else if (toolSessionId && agentCaps?.sessionCapabilities?.resume) {
      const resumed = await request(
        buildSessionResumeRequest(nextId(), toolSessionId, args.cwd, mcpServers)
      );
      activeAcpSessionId = toolSessionId;
      emitSetupItems(resumed);
    } else {
      const created = await request(
        buildSessionNewRequest(nextId(), args.cwd, mcpServers)
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
    turnHadLiveAgentChunk = false;
    await request(
      buildSessionPromptRequest(
        nextId(),
        activeAcpSessionId!,
        args.prompt,
        args.promptAttachments
      )
    );
  };

  const authRequiredError = (methods: AcpAuthMethod[]) => {
    const selected = selectAcpAuthMethod(methods);
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
    const automatic = selectAcpAuthMethod(methods);
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

  const isMissingSavedSessionError = (err: unknown) => {
    const e = err as Error & { code?: number };
    return e?.code === -32002 && /resource not found/i.test(e.message ?? "");
  };

  const savedSessionUnavailableError = (sessionId: string, err: unknown) => {
    const message = (err as Error)?.message || String(err);
    return new Error(
      `Saved agent session is no longer available (${sessionId}). The agent returned: ${message}. Start a new conversation or choose a workspace and retry so FreeBuddy can create a fresh agent session.`
    );
  };

  try {
    const init = await request(buildInitializeRequest(nextId()));
    if (init?.protocolVersion !== 1) {
      throw new Error(
        `Unsupported ACP protocol version ${String(init?.protocolVersion ?? "missing")}; FreeBuddy supports version 1.`
      );
    }
    agentCaps = init?.agentCapabilities ?? {};
    authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];

    if (args.conversationId) {
      mcpServers.push(
        await registerDraftToolSession({
          taskSessionId: args.sessionId,
          conversationId: args.conversationId,
          // Keep an unscoped conversation unscoped. ACP itself requires a cwd
          // and falls back to process.cwd(), but Draft must not treat the app's
          // launch directory as a user-selected workspace.
          cwd: args.cwd ?? "",
          webContents
        }),
        await registerBrowserToolSession(args.sessionId)
      );
    }
    if (args.skills?.length) {
      mcpServers.push(registerSkillToolSession(args.sessionId, args.skills));
    }
    if (args.handoffBrief && args.handoffBriefId) {
      mcpServers.push(
        registerContextToolSession(
          args.sessionId,
          args.handoffBrief,
          args.handoffBriefId,
          args.handoffTranscript
        )
      );
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
        toolSessionId &&
        isMissingSavedSessionError(sessionErr)
      ) {
        throw savedSessionUnavailableError(toolSessionId, sessionErr);
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
          const items = acpSessionSetupToItems(activeAcpSessionId, {
            sessionId: activeAcpSessionId,
            ...(result && typeof result === "object" ? result : {})
          })
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
          appendLog(
            logStream,
            "system",
            `set_config_option failed id=${configId}: ${(err as Error)?.message || String(err)}`
          );
          emit({
            type: "stderr",
            content: `Failed to set config option ${configId}: ${(err as Error)?.message || String(err)}`
          });
          // do not block prompt
        }
      }
    };

    await applyConfigOptionOverrides();
    try {
      await runPromptOnSession();
    } catch (promptErr) {
      if (
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
        await request(buildSessionCloseRequest(nextId(), activeAcpSessionId));
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

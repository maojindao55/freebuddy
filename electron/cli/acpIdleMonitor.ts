import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { WebContents } from "electron";
import { serializeStreamItemsForPersist } from "@freebuddy/cli-stream";

import {
  acpUpdateToItems,
  normalizePermissionOptions,
  parseAcpLine,
  pickAutoApprovedOption,
  updateActiveAcpToolCalls,
  type AcpMessage,
  type AcpRequestId,
  type AcpStreamItem
} from "./acp.js";
import type { CLIAdapterId } from "./adapters.js";
import { importAgyLocalDiff, withoutInlineFileBodies } from "./acpLocalDiff.js";
import { isAntigravityBridgeBinary } from "../shared/antigravity.js";
import { persistFileEditItems } from "./fileEditBlobs.js";
import { appendMessage, updateMessage } from "./conversations.js";
import { safeSendToWebContents } from "./ipcSend.js";
import { logMain } from "../debugLog.js";
import {
  clearPermissionResolversForSession,
  registerPermissionResolver,
  takePermissionResolver,
  type Running,
  type CliPermissionDecision,
  type CliPermissionRequest
} from "./runtimeShared.js";
import { clearSessionOwner, recordSessionOwner } from "./sessionOwners.js";
import { AcpToolActivityTracker } from "./acpToolActivity.js";

const IDLE_FLUSH_DEBOUNCE_MS = 120;
const IDLE_SEAL_QUIET_MS = 2000;
const IDLE_PERMISSION_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_IDLE_MERGED_CHARS = 500_000;

export interface AcpIdlePermissionEvent {
  conversationId: string;
  action: "enqueue" | "remove";
  request?: CliPermissionRequest;
  requestId?: string;
}

export interface AcpIdleMonitorInput {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  conversationId: string;
  acpSessionId: string;
  agentId: string;
  agentName: string;
  adapter: CLIAdapterId;
  binary?: string;
  approvalMode?: "auto" | "ask";
  ownerUserId?: string | null;
  webContents?: WebContents;
  running: Map<string, Running>;
  activeToolCallIds?: Iterable<string>;
}

type ToolCallItem = Extract<AcpStreamItem, { kind: "tool-call" }>;

function appendBounded(prev: string, delta: string): string {
  const combined = prev + delta;
  if (combined.length <= MAX_IDLE_MERGED_CHARS) return combined;
  return combined.slice(0, MAX_IDLE_MERGED_CHARS);
}

function mergeToolCall(prev: ToolCallItem, next: ToolCallItem): ToolCallItem {
  const toolOutputs = next.replaceToolOutputs
    ? next.toolOutputs
    : next.toolOutputs?.length
      ? [...(prev.toolOutputs ?? []), ...next.toolOutputs]
      : prev.toolOutputs;
  return {
    ...prev,
    ...next,
    tool: next.tool && next.tool !== "tool" ? next.tool : prev.tool,
    input: next.input !== undefined ? next.input : prev.input,
    output: next.output !== undefined ? next.output : prev.output,
    isError: next.isError !== undefined ? next.isError : prev.isError,
    locations: next.locations?.length ? next.locations : prev.locations,
    toolOutputs
  };
}

/** Merge streaming ACP items into a compact persisted snapshot while parked idle. */
export function mergeIdleStreamItems(
  prev: AcpStreamItem[],
  next: AcpStreamItem[]
): AcpStreamItem[] {
  if (!next.length) return prev;
  const out = [...prev];
  for (const item of next) {
    const last = out[out.length - 1];
    if (item.kind === "text" && item.messageId) {
      const idx = out.findIndex(
        (p) => p.kind === "text" && p.messageId === item.messageId && p.role === item.role
      );
      if (idx >= 0) {
        const prevItem = out[idx] as Extract<AcpStreamItem, { kind: "text" }>;
        const content = item.append
          ? appendBounded(prevItem.content, item.content)
          : item.content.startsWith(prevItem.content)
            ? item.content.slice(0, MAX_IDLE_MERGED_CHARS)
            : appendBounded(prevItem.content, item.content);
        out[idx] = { ...prevItem, content };
        continue;
      }
    }
    if (item.kind === "thinking" && item.messageId) {
      const idx = out.findIndex(
        (p) => p.kind === "thinking" && p.messageId === item.messageId
      );
      if (idx >= 0) {
        const prevItem = out[idx] as Extract<AcpStreamItem, { kind: "thinking" }>;
        const content = item.append
          ? appendBounded(prevItem.content, item.content)
          : item.content.startsWith(prevItem.content)
            ? item.content.slice(0, MAX_IDLE_MERGED_CHARS)
            : appendBounded(prevItem.content, item.content);
        out[idx] = { ...prevItem, content };
        continue;
      }
    }
    if (item.kind === "text" && last?.kind === "text" && last.role === item.role) {
      if (item.append) {
        out[out.length - 1] = { ...last, content: appendBounded(last.content, item.content) };
        continue;
      }
      if (item.content === last.content) continue;
      if (item.content.startsWith(last.content)) {
        out[out.length - 1] = { ...last, content: item.content.slice(0, MAX_IDLE_MERGED_CHARS) };
        continue;
      }
    }
    if (item.kind === "thinking" && last?.kind === "thinking") {
      if (item.append) {
        out[out.length - 1] = { ...last, content: appendBounded(last.content, item.content) };
        continue;
      }
      if (item.content === last.content) continue;
      if (item.content.startsWith(last.content)) {
        out[out.length - 1] = { ...last, content: item.content.slice(0, MAX_IDLE_MERGED_CHARS) };
        continue;
      }
    }
    if (item.kind === "tool-call" && item.id) {
      const idx = out.findIndex((p) => p.kind === "tool-call" && p.id === item.id);
      if (idx >= 0) {
        out[idx] = mergeToolCall(out[idx] as ToolCallItem, item);
        continue;
      }
    }
    if (item.kind === "plan" || item.kind === "session" || item.kind === "available-commands" || item.kind === "config-options") {
      const idx = out.findIndex((p) => p.kind === item.kind);
      if (idx >= 0) {
        out[idx] = item;
        continue;
      }
    }
    if (item.kind === "usage") {
      const idx = out.findIndex((p) => p.kind === "usage");
      if (idx >= 0) {
        out[idx] = item;
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

export function isVisibleIdleStreamItem(item: AcpStreamItem): boolean {
  return (
    item.kind !== "session" &&
    item.kind !== "usage" &&
    item.kind !== "available-commands" &&
    item.kind !== "config-options"
  );
}

/**
 * Listen for post-`end_turn` background updates and permission requests on an
 * idle pooled ACP connection, persisting wake-up replies to the conversation.
 */
export function createAcpIdleMonitor(input: AcpIdleMonitorInput): {
  startIdle: () => void;
  stopIdle: (status?: "done" | "failed" | "killed") => void;
} {
  const {
    child,
    conversationId,
    acpSessionId,
    agentId,
    agentName,
    adapter,
    binary,
    approvalMode,
    ownerUserId,
    webContents,
    running
  } = input;

  let active = false;
  let rlOut: readline.Interface | undefined;
  let rlErr: readline.Interface | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let sealTimer: ReturnType<typeof setTimeout> | undefined;
  let idleMessageId: string | undefined;
  let idleItems: AcpStreamItem[] = [];
  let hasVisibleContent = false;
  let dirty = false;
  let replyAfterActivity = false;
  const activeIdleToolIds = new Set(input.activeToolCallIds);
  const toolActivity = new AcpToolActivityTracker();
  const idleControlSessionId = `acp-idle-${randomUUID()}`;
  let idleOwnerRecorded = false;
  const pendingPermissionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  const writeRpc = (payload: unknown) => {
    try {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      }
    } catch {
      /* Connection teardown handles dead pipes. */
    }
  };

  const respondToPermission = (
    requestRpcId: AcpRequestId,
    decision: CliPermissionDecision
  ) => {
    if (decision.outcome === "selected") {
      writeRpc({
        jsonrpc: "2.0",
        id: requestRpcId,
        result: { outcome: { outcome: "selected", optionId: decision.optionId } }
      });
    } else {
      writeRpc({
        jsonrpc: "2.0",
        id: requestRpcId,
        result: { outcome: { outcome: "cancelled" } }
      });
    }
  };

  const flush = (status: "running" | "done" | "failed" | "killed" = "running") => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!dirty || !hasVisibleContent) return;
    dirty = false;
    const serialized = serializeStreamItemsForPersist(idleItems);
    try {
      if (!idleMessageId) {
        idleMessageId = randomUUID();
        appendMessage({
          id: idleMessageId,
          conversationId,
          role: "assistant",
          status,
          content: serialized,
          // Passive work has its own control session. The previous prompt's
          // task is already terminal and must not determine this reply's state.
          taskId: idleControlSessionId,
          agentId,
          agentName,
          adapter,
          authorUsername: null
        });
      } else {
        updateMessage({
          id: idleMessageId,
          status,
          content: serialized
        });
      }
    } catch (error) {
      logMain().warn("acp", "failed to persist idle background update", {
        conversationId,
        error: (error as Error)?.message || String(error)
      });
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => flush(), IDLE_FLUSH_DEBOUNCE_MS);
  };

  const beginWakeupBurst = () => {
    if (!idleOwnerRecorded) {
      recordSessionOwner(idleControlSessionId, ownerUserId ?? null);
      idleOwnerRecorded = true;
    }
    running.set(idleControlSessionId, {
      child,
      pid: child.pid ?? 0,
      cancel: () => stopIdle("killed")
    });
  };

  const sealWakeupBurst = (status: "done" | "failed" | "killed" = "done") => {
    if (sealTimer) {
      clearTimeout(sealTimer);
      sealTimer = undefined;
    }
    if (hasVisibleContent) dirty = true;
    flush(status);
    running.delete(idleControlSessionId);
    if (idleOwnerRecorded && pendingPermissionTimeouts.size === 0) {
      clearSessionOwner(idleControlSessionId);
      idleOwnerRecorded = false;
    }
    idleMessageId = undefined;
    idleItems = [];
    hasVisibleContent = false;
    replyAfterActivity = false;
    activeIdleToolIds.clear();
    toolActivity.clear();
  };

  const scheduleSeal = () => {
    if (sealTimer) {
      clearTimeout(sealTimer);
      sealTimer = undefined;
    }
    // ACP provides no prompt response for a passive wake-up. Quiet between
    // tools is not completion: wait for an assistant reply after the activity,
    // with no outstanding tools or permission requests, before sealing it.
    if (hasVisibleContent && replyAfterActivity && activeIdleToolIds.size === 0 && pendingPermissionTimeouts.size === 0) {
      sealTimer = setTimeout(() => sealWakeupBurst(), IDLE_SEAL_QUIET_MS);
    }
  };

  const handlePermissionRequest = (msg: AcpMessage) => {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const options = normalizePermissionOptions(params.options);
    const requestRpcId = msg.id!;
    beginWakeupBurst();
    hasVisibleContent = true;
    replyAfterActivity = false;
    dirty = true;
    flush();
    scheduleSeal();

    if (approvalMode === "auto") {
      const auto = pickAutoApprovedOption(options);
      respondToPermission(
        requestRpcId,
        auto ? { outcome: "selected", optionId: auto.optionId } : { outcome: "cancelled" }
      );
      return;
    }

    if (options.length === 0 || !webContents || webContents.isDestroyed?.()) {
      respondToPermission(requestRpcId, { outcome: "cancelled" });
      return;
    }

    const requestId = randomUUID();
    const toolCallRaw = (params.toolCall as Record<string, unknown> | undefined) ?? undefined;
    const toolCall = toolCallRaw
      ? {
          toolCallId:
            typeof toolCallRaw.toolCallId === "string"
              ? toolCallRaw.toolCallId
              : typeof toolCallRaw.id === "string"
                ? toolCallRaw.id
                : undefined,
          title: typeof toolCallRaw.title === "string" ? toolCallRaw.title : undefined,
          kind: typeof toolCallRaw.kind === "string" ? toolCallRaw.kind : undefined,
          rawInput: toolCallRaw.rawInput,
          locations: toolCallRaw.locations
        }
      : undefined;

    const sendPermissionEvent = (payload: AcpIdlePermissionEvent) => {
      if (webContents && !webContents.isDestroyed?.()) {
        safeSendToWebContents(webContents, "freebuddy://acp-permission", payload);
      }
    };

    registerPermissionResolver(idleControlSessionId, requestId, (decision) => {
      const timer = pendingPermissionTimeouts.get(requestId);
      if (timer) {
        clearTimeout(timer);
        pendingPermissionTimeouts.delete(requestId);
      }
      respondToPermission(requestRpcId, decision);
      sendPermissionEvent({ conversationId, action: "remove", requestId });
      if (active) {
        // The agent can start a slow tool/inference step after approval.
        // Text shown before approval is not its final reply.
        replyAfterActivity = false;
        dirty = true;
        flush();
        scheduleSeal();
      }
    });

    const timeout = setTimeout(() => {
      const resolver = takePermissionResolver(idleControlSessionId, requestId);
      if (!resolver) return;
      resolver({ outcome: "cancelled" });
    }, IDLE_PERMISSION_TIMEOUT_MS);
    pendingPermissionTimeouts.set(requestId, timeout);

    sendPermissionEvent({
      conversationId,
      action: "enqueue",
      request: {
        requestId,
        sessionId: idleControlSessionId,
        acpSessionId: typeof params.sessionId === "string" ? params.sessionId : acpSessionId,
        toolCall,
        options
      }
    });
  };

  const handleLine = (line: string) => {
    if (!active) return;
    const msg = parseAcpLine(line);
    if (!msg) return;
    if (typeof msg.params?.sessionId === "string" && msg.params.sessionId !== acpSessionId) return;

    if (msg.method && msg.id != null) {
      if (msg.method === "session/request_permission") {
        handlePermissionRequest(msg);
      } else {
        writeRpc({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32601,
            message: `FreeBuddy does not implement idle ACP method ${msg.method}`
          }
        });
      }
      return;
    }

    if (msg.method !== "session/update" || !msg.params?.update) return;
    const update = msg.params.update;
    const sessionId = typeof msg.params.sessionId === "string" ? msg.params.sessionId : acpSessionId;
    updateActiveAcpToolCalls(activeIdleToolIds, update);

    const localDiff = importAgyLocalDiff(update, adapter);
    const timing = toolActivity.observe(update);
    const items = acpUpdateToItems(localDiff.update, sessionId, adapter, {
      legacyAgyBridge: adapter === "agy-acp" && isAntigravityBridgeBinary(binary)
    }).map((item) => (item.kind === "tool-call" && timing ? { ...item, ...timing } : item));
    if (!items.length) {
      if (localDiff.imported) localDiff.release();
      return;
    }

    let storedItems = items;
    try {
      storedItems = persistFileEditItems({ conversationId, sessionId: idleControlSessionId }, items);
      if (localDiff.imported) {
        storedItems = withoutInlineFileBodies(storedItems);
        localDiff.release();
      }
    } catch {
      if (localDiff.imported) storedItems = withoutInlineFileBodies(items);
    }

    idleItems = mergeIdleStreamItems(idleItems, storedItems);
    const visibleItems = storedItems.filter(isVisibleIdleStreamItem);
    if (visibleItems.length) {
      const firstActivity = !hasVisibleContent;
      beginWakeupBurst();
      hasVisibleContent = true;
      const last = visibleItems[visibleItems.length - 1];
      replyAfterActivity = last.kind === "text" && last.role === "assistant" && Boolean(last.content.trim());
      dirty = true;
      if (visibleItems.some((item) => item.kind === "error" && item.terminal)) {
        sealWakeupBurst("failed");
        return;
      }
      if (firstActivity) flush();
      else scheduleFlush();
    }
    scheduleSeal();
  };

  const startIdle = () => {
    if (active) return;
    active = true;
    rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", handleLine);
    rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", () => {
      /* Drain idle stderr without buffering. */
    });
  };

  const stopIdle = (status: "done" | "failed" | "killed" = "done") => {
    if (!active) return;
    active = false;
    if (sealTimer) {
      clearTimeout(sealTimer);
      sealTimer = undefined;
    }
    rlOut?.close();
    rlOut = undefined;
    rlErr?.close();
    rlErr = undefined;
    for (const [requestId, timer] of pendingPermissionTimeouts) {
      clearTimeout(timer);
      const resolver = takePermissionResolver(idleControlSessionId, requestId);
      if (resolver) resolver({ outcome: "cancelled" });
      else if (webContents && !webContents.isDestroyed?.()) {
        safeSendToWebContents(webContents, "freebuddy://acp-permission", {
          conversationId,
          action: "remove",
          requestId
        } satisfies AcpIdlePermissionEvent);
      }
    }
    pendingPermissionTimeouts.clear();
    clearPermissionResolversForSession(idleControlSessionId);
    sealWakeupBurst(status);
    if (idleOwnerRecorded) {
      clearSessionOwner(idleControlSessionId);
      idleOwnerRecorded = false;
    }
    idleMessageId = undefined;
    idleItems = [];
    hasVisibleContent = false;
    dirty = false;
    replyAfterActivity = false;
    activeIdleToolIds.clear();
  };

  return { startIdle, stopIdle };
}

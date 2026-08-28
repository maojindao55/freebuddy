import { create } from "zustand";
import { nanoid } from "nanoid";

import type { CLIMember } from "@/config/aiMembers";
import { builtinCliMembers } from "@/config/aiMembers";
import { cliClient } from "@/services/cli/client";
import {
  getParser,
  type CliStreamItem,
  type ParseContext
} from "@/services/cli/parsers";
import type {
  CliEvent,
  CliRunArgs,
  ChatAttachment,
  Conversation,
  ConversationKind,
  ConversationMessage
} from "@/services/cli/types";
import type {
  WorkflowRunRow,
  WorkflowStepRow
} from "@/services/workflows/types";
import { workflowFollowupAgentId } from "@/services/workflows/types";
import { workflowClient } from "@/services/workflows/client";
import { debugLogClient } from "@/services/debugLog";
import { composeMessageWithAttachments } from "@/utils/chatAttachments";
import {
  filterSessionConfigPickerOptions,
  resolveConfigOptionOverrides
} from "@/utils/sessionConfigOptions";

import { useCliExecutorStore } from "./cliExecutorStore";
import { useProjectStore } from "./projectStore";
import {
  buildOrphanFollowupContext,
  appendItems,
  collectStreamMessageIds,
  collectStreamAgentMessageIds,
  collectStreamContentSignatures,
  composeOrphanFollowupPrompt,
  defaultTitleFor,
  feedArticleTitleFromMessages,
  mergeConversationMessages,
  shouldApplyAgentSessionTitle,
  upsertConversationMessage
} from "./conversationUtils";
import {
  handleStreamControlEvent,
  handleStreamEvent,
  killConversation
} from "./conversationHandlers";
import {
  latestConfigOptionsFromItems,
  latestConfigOptionsFromMessages,
  latestSessionInfoFromMessages
} from "./sessionMetaUtils";
import {
  loadUnreadConversations,
  persistUnreadConversations,
  type UnreadConversationMap
} from "./conversationUnread";
import { isAppInBackground } from "@/utils/appFocus";

function resolveWorkspaceRootsForConversation(conv: Conversation): string[] {
  const taskWorkspace = conv.metadata?.taskWorkspace;
  if (
    taskWorkspace &&
    typeof taskWorkspace === "object" &&
    (taskWorkspace as Record<string, unknown>).mode === "worktree"
  ) {
    return conv.cwd ? [conv.cwd] : [];
  }
  if (conv.projectId) {
    const project = useProjectStore
      .getState()
      .projects.find((entry) => entry.id === conv.projectId);
    if (project?.folders?.length) {
      return project.folders.map((folder) => folder.trim()).filter(Boolean);
    }
  }
  return conv.cwd ? [conv.cwd] : [];
}

export interface LiveAssistant {
  messageId: string;
  taskSessionId: string;
  items: CliStreamItem[];
  status: "starting" | "running" | "done" | "failed" | "killed";
  pid?: number;
  exitCode?: number;
  errorMessage?: string;
  resumedFromSessionId?: string;
  capturedSessionId?: string;
  preserveConversationTitle?: boolean;
}

export interface ConversationState {
  members: CLIMember[];
  memberRuntimeOverrides: Record<string, string>;
  conversations: Conversation[];
  activeId?: string;
  messages: Record<string, ConversationMessage[]>;
  live: Record<string, LiveAssistant>;
  unreadConversations: UnreadConversationMap;
  pendingFreshContext: Record<string, boolean>;
  currentUser: { username: string; isOwner: boolean } | null;

  load(): Promise<void>;
  refreshList(): Promise<void>;
  refreshMembers(): void;
  reloadMemberRuntimeOverrides(): Promise<void>;
  setMemberRuntimeOverride(memberId: string, runtimeKey: string): Promise<void>;
  requestFreshContext(id: string): void;
  setActive(id: string | undefined): Promise<void>;
  loadMessages(id: string, messageIds?: string[]): Promise<void>;
  markConversationUnread(id: string): void;
  markConversationCompletedUnread(
    id: string,
    result: "success" | "failure"
  ): void;
  markConversationRead(id: string): void;

  newConversation(input: {
    member: CLIMember;
    cwd?: string;
    projectId?: string;
    title?: string;
    kind?: ConversationKind;
    metadata?: Record<string, unknown>;
    approvalMode?: "auto" | "ask";
    configOptionOverrides?: Record<string, string>;
    skillIds?: string[];
  }): Promise<Conversation>;
  transferConversation(input: {
    sourceConversationId: string;
    targetMember: CLIMember;
  }): Promise<{
    conversation: Conversation;
    warning?: "brief_extraction_failed";
    startError?: string;
  }>;
  importCodexSession(sessionId: string): Promise<{
    conversation: Conversation;
    created: boolean;
    turns: number;
    messages: number;
    warning?: "resume_session_not_linked";
  }>;
  renameConversation(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  archiveConversation(id: string, archived: boolean): Promise<void>;
  setConversationApprovalMode(
    id: string,
    approvalMode: "auto" | "ask"
  ): Promise<void>;
  setConversationConfigOptionOverrides(
    id: string,
    overrides: Record<string, string>
  ): Promise<void>;
  setConversationSkills(id: string, skillIds: string[]): Promise<void>;

  sendMessage(input: {
    conversationId: string;
    prompt: string;
    attachments?: ChatAttachment[];
    userMessageId?: string;
    assistantMessageId?: string;
    approvalModeOverride?: "auto" | "ask";
    preserveConversationTitle?: boolean;
    internalPrompt?: boolean;
    memberOverride?: CLIMember;
    configOptionOverrides?: Record<string, string>;
  }): Promise<void>;
  stopActive(conversationId: string): Promise<void>;
  isRunning(conversationId: string): boolean;
}

export interface RunCtx {
  conversationId: string;
  messageId: string;
  parser: ReturnType<typeof getParser>;
  parseCtx: ParseContext;
  unsubscribe: () => void;
}

export const runCtxMap = new Map<string, RunCtx>();

let transferInFlight = false;

const workflowMessageUnsubscribes = new Map<string, () => void>();
const workflowEventUnsubscribes = new Map<string, () => void>();
let workflowFinishedUnsubscribe: (() => void) | null = null;
const workflowRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const workflowPendingMessageIds = new Map<string, Set<string>>();

const terminalWorkflowStatuses = new Set([
  "completed",
  "failed",
  "killed",
  "partial"
]);

function removeWorkflowMessageSubscription(conversationId: string): void {
  const unsubscribe = workflowMessageUnsubscribes.get(conversationId);
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      /* noop */
    }
    workflowMessageUnsubscribes.delete(conversationId);
  }
  const timer = workflowRefreshTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    workflowRefreshTimers.delete(conversationId);
  }
  workflowPendingMessageIds.delete(conversationId);
}

function removeWorkflowEventSubscription(conversationId: string): void {
  const unsubscribe = workflowEventUnsubscribes.get(conversationId);
  if (!unsubscribe) return;
  try {
    unsubscribe();
  } catch {
    /* noop */
  }
  workflowEventUnsubscribes.delete(conversationId);
}

/** Running assistant turns (workflow steps or delegation handoffs). */
function hasActiveStreamingMessages(messages: ConversationMessage[] | undefined): boolean {
  return (
    messages?.some(
      (message) =>
        message.role === "assistant" &&
        (message.status === "running" || message.status === "starting")
    ) ?? false
  );
}

function ensureWorkflowMessageSubscription(
  conversationId: string | undefined,
  refresh: (id: string, messageIds?: string[]) => Promise<void>
) {
  const fb = (globalThis as any).freebuddy;
  const api = fb?.workflow;
  if (!api?.onStepMessage) return;
  if (!workflowFinishedUnsubscribe && api.onRunFinished) {
    workflowFinishedUnsubscribe = api.onRunFinished((event: {
      runId: string;
      conversationId?: string;
      status: string;
      name: string;
    }) => {
      if (event.conversationId) {
        refreshWorkflowTree(event.conversationId, event.runId);
      }
      if (
        event.conversationId &&
        terminalWorkflowStatuses.has(event.status)
      ) {
        removeWorkflowEventSubscription(event.conversationId);
        removeWorkflowMessageSubscription(event.conversationId);
      }
    });
  }
  if (
    conversationId &&
    api.onStepEvent &&
    !workflowEventUnsubscribes.has(conversationId)
  ) {
    workflowEventUnsubscribes.set(
      conversationId,
      api.onStepEvent(
        conversationId,
        (event: { sessionId?: string; event?: CliEvent }) => {
          if (event?.event) {
            handleStreamControlEvent(conversationId, event.event);
          }
        }
      )
    );
  }

  if (conversationId && !workflowMessageUnsubscribes.has(conversationId)) {
    workflowMessageUnsubscribes.set(
      conversationId,
      api.onStepMessage(conversationId, (event: { messageId?: string }) => {
        let pending = workflowPendingMessageIds.get(conversationId);
        if (!pending) {
          pending = new Set();
          workflowPendingMessageIds.set(conversationId, pending);
        }
        if (event.messageId) pending.add(event.messageId);
        if (workflowRefreshTimers.has(conversationId)) return;
        workflowRefreshTimers.set(
          conversationId,
          setTimeout(() => {
            workflowRefreshTimers.delete(conversationId);
            const ids = [...(workflowPendingMessageIds.get(conversationId) ?? [])];
            workflowPendingMessageIds.get(conversationId)?.clear();
            void refresh(conversationId, ids.length ? ids : undefined);
            refreshWorkflowTree(conversationId);
          }, 300)
        );
      })
    );
  }
}

function refreshWorkflowTree(conversationId: string, runId?: string) {
  void import("@/store/workflowStore").then(({ useWorkflowStore }) => {
    const { activeRun, refresh } = useWorkflowStore.getState();
    const id =
      runId ??
      (activeRun?.conversationId === conversationId ? activeRun.id : undefined);
    if (id) void refresh(id);
  });
}

function pruneIdleWorkflowMessageSubscriptions(
  activeId: string | undefined,
  messagesById: ConversationState["messages"]
): void {
  for (const cid of [...workflowMessageUnsubscribes.keys()]) {
    if (cid === activeId) continue;
    if (!hasActiveStreamingMessages(messagesById[cid])) {
      removeWorkflowMessageSubscription(cid);
      removeWorkflowEventSubscription(cid);
    }
  }
}

function latestSessionIdFromMessages(
  messages: ConversationMessage[],
  adapter?: string
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    // Never resume a session that was created by a different adapter: the new
    // adapter doesn't know that session and rejects it (e.g. "Session not
    // found" / "Invalid params" after switching the ButlerBuddy adapter).
    if (adapter && message.adapter && message.adapter !== adapter) continue;
    try {
      const items = JSON.parse(message.content) as CliStreamItem[];
      if (!Array.isArray(items)) continue;
      for (let j = items.length - 1; j >= 0; j -= 1) {
        const item = items[j];
        if (item?.kind === "session" && item.sessionId) {
          return item.sessionId;
        }
      }
    } catch {
      // Ignore old/plain assistant messages.
    }
  }
  return undefined;
}

async function workflowRunForConversation(
  conversationId: string
): Promise<WorkflowRunRow | undefined> {
  if (!workflowClient.isAvailable()) return undefined;
  const runs = await workflowClient.listRuns(conversationId);
  return runs[0];
}

function memberForWorkflowFollowup(
  run: WorkflowRunRow | undefined,
  members: CLIMember[]
): CLIMember | undefined {
  const agentId = run ? workflowFollowupAgentId(run) : undefined;
  if (!agentId) return undefined;
  return members.find((member) => member.id === agentId);
}

function truncateWorkflowContext(text: string | undefined, max = 1200): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}\n[truncated]`;
}

function workflowFollowupToolSessionScope(
  run: WorkflowRunRow,
  member: CLIMember
): string {
  return `workflow-followup:${run.id}:${member.id}`;
}

function mergeMemberSkillIds(
  selectedIds: readonly string[] | undefined,
  requiredIds: readonly string[] | undefined
): string[] {
  return [...new Set([...(requiredIds ?? []), ...(selectedIds ?? [])])];
}

const MEMBER_RUNTIME_OVERRIDES_KEY = "member.runtimeOverrides";

async function loadMemberOverrideMap(
  key: string
): Promise<Record<string, string>> {
  try {
    const raw = await cliClient.getSetting(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const result: Record<string, string> = {};
      for (const [mapKey, value] of Object.entries(
        parsed as Record<string, unknown>
      )) {
        if (typeof value === "string") result[mapKey] = value;
      }
      return result;
    }
  } catch {
    // non-fatal
  }
  return {};
}

function firstInstalledAcpAdapter(
  executorStore: ReturnType<typeof useCliExecutorStore.getState>
): string | undefined {
  for (const def of executorStore.adapters) {
    if (def.protocol === "acp" && executorStore.runtimes[def.id]?.installed) {
      return def.id;
    }
  }
  return undefined;
}

function buildConversationMembers(
  runtimeOverrides: Record<string, string> = {}
): CLIMember[] {
  const executorStore = useCliExecutorStore.getState();
  const dynamicDefaultAdapter = firstInstalledAcpAdapter(executorStore);
  const builtinMembers = builtinCliMembers.map((member) => {
    const overrideAdapter = member.runtimeKey
      ? runtimeOverrides[member.id]
      : undefined;
    const resolvedAdapter =
      overrideAdapter ??
      (member.runtimeKey ? dynamicDefaultAdapter : undefined) ??
      member.cli.adapter;
    const executor = executorStore.resolve(resolvedAdapter);
    return {
      ...member,
      runtimeKey: resolvedAdapter,
      enabled: executor?.enabled ?? member.enabled,
      cli: {
        ...member.cli,
        adapter: resolvedAdapter,
        skillIds: mergeMemberSkillIds(
          executor?.skillIds ?? member.cli.skillIds,
          member.requiredSkillIds
        )
      }
    };
  });
  const customMembers = executorStore
    .listResolved()
    .filter((executor) => executor.isClone && executor.baseAdapter)
    .map((executor): CLIMember => ({
      id: `cli-${executor.id}`,
      kind: "cli",
      name: executor.label,
      avatar: executor.icon,
      description: `Custom ${executor.label} agent.`,
      source: "user",
      enabled: executor.enabled,
      cli: {
        adapter: executor.baseAdapter!,
        binary: executor.binary,
        extraArgs: executor.extraArgs,
        env: executor.env,
        approvalMode: "auto",
        showStderr: true,
        skillIds: executor.skillIds
      }
    }));
  return [...builtinMembers, ...customMembers];
}

function defaultTitleForAgentName(agentName: string, cwd?: string): string {
  const tail = cwd
    ? cwd.split(/[/\\]/).filter(Boolean).slice(-1)[0]
    : undefined;
  return tail ? `${agentName} · ${tail}` : agentName;
}

function syncConversationAgentNames(
  conversations: Conversation[],
  members: CLIMember[]
): {
  conversations: Conversation[];
  agentNameChanges: Map<string, string>;
  titleChanges: Array<{ id: string; title: string }>;
} {
  const membersById = new Map(members.map((member) => [member.id, member]));
  const agentNameChanges = new Map<string, string>();
  const titleChanges: Array<{ id: string; title: string }> = [];
  let changed = false;
  const next = conversations.map((conversation) => {
    const member = membersById.get(conversation.agentId);
    if (!member || member.name === conversation.agentName) {
      return conversation;
    }
    changed = true;
    agentNameChanges.set(conversation.agentId, member.name);
    const oldDefaultTitle = defaultTitleForAgentName(
      conversation.agentName,
      conversation.cwd
    );
    const title =
      conversation.title === oldDefaultTitle
        ? defaultTitleForAgentName(member.name, conversation.cwd)
        : conversation.title;
    if (title !== conversation.title) {
      titleChanges.push({ id: conversation.id, title });
    }
    return {
      ...conversation,
      agentName: member.name,
      title,
      ...(title !== conversation.title
        ? { titleSource: "default" as const }
        : {})
    };
  });
  return {
    conversations: changed ? next : conversations,
    agentNameChanges,
    titleChanges
  };
}

function persistSyncedConversationAgentNames(input: {
  agentNameChanges: Map<string, string>;
  titleChanges: Array<{ id: string; title: string }>;
}) {
  if (!cliClient.isAvailable()) return;
  input.agentNameChanges.forEach((agentName, agentId) => {
    void cliClient.updateConversationAgentName(agentId, agentName);
  });
  input.titleChanges.forEach(({ id, title }) => {
    void cliClient.renameConversation(id, title, "default");
  });
}

function workflowPlanPhaseList(run: WorkflowRunRow): string {
  try {
    const plan = JSON.parse(run.planJson) as {
      phases?: Array<{ id: string; title: string }>;
    };
    return (plan.phases ?? [])
      .map((phase) => `${phase.id}: ${phase.title}`)
      .join(" -> ");
  } catch {
    return "";
  }
}

function buildWorkflowFollowupContext(
  run: WorkflowRunRow,
  steps: WorkflowStepRow[]
): string {
  const lines: string[] = [
    "You are answering a follow-up about a completed FreeBuddy team workflow.",
    "Use the workflow record below as the source of truth. Do not claim you personally performed steps assigned to other roles; attribute them by role or agent when relevant.",
    "",
    "Workflow run:",
    `- id: ${run.id}`,
    `- name: ${run.name}`,
    `- status: ${run.status}`,
    `- goal: ${run.goal}`,
    `- loop: ${run.loopIndex + 1}/${run.maxLoops}`
  ];

  if (run.teamId) lines.push(`- team: ${run.teamId}`);
  const phases = workflowPlanPhaseList(run);
  if (phases) lines.push(`- route: ${phases}`);
  if (run.summary?.trim()) {
    lines.push("", "Final workflow summary:", truncateWorkflowContext(run.summary, 2400));
  }

  const visibleSteps = steps.filter((step) => step.status !== "pending");
  if (visibleSteps.length) {
    lines.push("", "Step summaries:");
    for (const step of visibleSteps) {
      lines.push(
        `- ${step.phaseId}/${step.stepId} [${step.status}] ${step.title} (${step.agentName}): ${truncateWorkflowContext(step.summary, 700) || "(no summary)"}`
      );
    }
  }

  return lines.join("\n");
}

async function workflowFollowupContextForRun(
  run: WorkflowRunRow | undefined
): Promise<string | undefined> {
  if (!run || !workflowClient.isAvailable()) return undefined;
  const steps = await workflowClient.getSteps(run.id);
  return buildWorkflowFollowupContext(run, steps);
}

const ACTIVE_CONV_STORAGE_KEY = "fb_last_active_conversation";

function getStoredActiveId(): string | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    const fromUrl = new URLSearchParams(window.location.search).get("c");
    if (fromUrl) return fromUrl;
    return sessionStorage.getItem(ACTIVE_CONV_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function setStoredActiveId(id: string | undefined): void {
  try {
    if (typeof window === "undefined") return;
    if (id) {
      sessionStorage.setItem(ACTIVE_CONV_STORAGE_KEY, id);
    } else {
      sessionStorage.removeItem(ACTIVE_CONV_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  members: buildConversationMembers(),
  memberRuntimeOverrides: {},
  conversations: [],
  activeId: undefined,
  messages: {},
  live: {},
  unreadConversations: loadUnreadConversations(),
  pendingFreshContext: {},
  currentUser: null,

  async load() {
    if (!cliClient.isAvailable()) return;
    const memberRuntimeOverrides = await loadMemberOverrideMap(
      MEMBER_RUNTIME_OVERRIDES_KEY
    );
    const members = buildConversationMembers(memberRuntimeOverrides);
    const list = await cliClient.listConversations({ archived: false });
    const synced = syncConversationAgentNames(list, members);
    persistSyncedConversationAgentNames(synced);
    try {
      const me = await window.freebuddy?.remote?.whoami();
      if (me?.username) {
        set({ currentUser: { username: me.username, isOwner: !!me.isOwner } });
      }
    } catch {
      // current user unavailable; non-fatal
    }
    const stored = getStoredActiveId();
    const cur = get().activeId || stored;
    const matchedCur =
      cur && synced.conversations.some((c) => c.id === cur) ? cur : undefined;
    set({
      members,
      memberRuntimeOverrides,
      conversations: synced.conversations,
      activeId: matchedCur
    });
    const active = get().activeId;
    if (active) get().markConversationRead(active);
    if (active && !get().messages[active]) {
      await get().loadMessages(active);
    }
    ensureWorkflowMessageSubscription(active, async (cid, messageIds) => {
      await get().loadMessages(cid, messageIds);
    });
  },

  async refreshList() {
    if (!cliClient.isAvailable()) return;
    const members = buildConversationMembers(get().memberRuntimeOverrides);
    const list = await cliClient.listConversations({ archived: false });
    const synced = syncConversationAgentNames(list, members);
    persistSyncedConversationAgentNames(synced);
    set({ members, conversations: synced.conversations });
  },

  refreshMembers() {
    const members = buildConversationMembers(get().memberRuntimeOverrides);
    const synced = syncConversationAgentNames(get().conversations, members);
    persistSyncedConversationAgentNames(synced);
    set({ members, conversations: synced.conversations });
  },

  async reloadMemberRuntimeOverrides() {
    // Re-read the persisted runtime-override map (e.g. the ButlerBuddy adapter
    // chosen in Settings) and rebuild members. The floating ButlerBuddy chat is
    // a separate renderer with its own store; without this, an adapter change
    // made in the main window never reaches the companion, so sendMessage keeps
    // using the stale adapter.
    if (!cliClient.isAvailable()) return;
    const memberRuntimeOverrides = await loadMemberOverrideMap(
      MEMBER_RUNTIME_OVERRIDES_KEY
    );
    const members = buildConversationMembers(memberRuntimeOverrides);
    set({ members, memberRuntimeOverrides });
  },

  requestFreshContext(id) {
    // Force the next sendMessage for this conversation to start a fresh agent
    // session (no toolSession resume). Used by the ButlerBuddy model picker so a
    // newly chosen model reliably takes effect at session/new time.
    set((s) => ({
      pendingFreshContext: { ...s.pendingFreshContext, [id]: true }
    }));
  },

  async setMemberRuntimeOverride(memberId, runtimeKey) {
    const memberRuntimeOverrides = {
      ...get().memberRuntimeOverrides,
      [memberId]: runtimeKey
    };
    await cliClient.setSetting(
      MEMBER_RUNTIME_OVERRIDES_KEY,
      JSON.stringify(memberRuntimeOverrides)
    );
    const members = buildConversationMembers(memberRuntimeOverrides);
    const synced = syncConversationAgentNames(get().conversations, members);
    persistSyncedConversationAgentNames(synced);
    set({ members, memberRuntimeOverrides, conversations: synced.conversations });
  },

  async setActive(id) {
    setStoredActiveId(id);
    if (id && get().unreadConversations[id]) {
      const unreadConversations = { ...get().unreadConversations };
      delete unreadConversations[id];
      persistUnreadConversations(unreadConversations);
      set({ activeId: id, unreadConversations });
    } else {
      set({ activeId: id });
    }
    const cachedMessages = id ? get().messages[id] : undefined;
    // Always reload when the conversation has an in-flight assistant turn
    // (delegation handoffs included). Missing this made background teams look
    // frozen after switching away and back.
    if (id && (!cachedMessages || hasActiveStreamingMessages(cachedMessages))) {
      await get().loadMessages(id);
    }
    ensureWorkflowMessageSubscription(id, async (cid, messageIds) => {
      await get().loadMessages(cid, messageIds);
    });
    pruneIdleWorkflowMessageSubscriptions(id, get().messages);
    if (id) {
      const conv = get().conversations.find((c) => c.id === id);
      if (conv?.cwd) {
        void cliClient.ensureAgentGuides(conv.cwd, {
          nativeBrowserTools:
            useCliExecutorStore.getState().resolve(conv.adapter)?.protocol === "acp"
        }).catch((err) => {
          // best-effort: guide files are optional
          if (import.meta.env?.DEV) {
            console.warn("[FreeBuddy] Failed to ensure agent guides:", err);
          }
        });
      }
    }
  },

  markConversationUnread(id) {
    if ((get().activeId === id && !isAppInBackground()) || get().unreadConversations[id]) return;
    const unreadConversations: UnreadConversationMap = {
      ...get().unreadConversations,
      [id]: { kind: "message", at: new Date().toISOString() }
    };
    persistUnreadConversations(unreadConversations);
    set({ unreadConversations });
  },

  markConversationCompletedUnread(id, result) {
    if (get().activeId === id && !isAppInBackground()) return;
    const current = get().unreadConversations[id];
    if (current?.kind === result) return;
    const unreadConversations: UnreadConversationMap = {
      ...get().unreadConversations,
      [id]: { kind: result, at: new Date().toISOString() }
    };
    persistUnreadConversations(unreadConversations);
    set({ unreadConversations });
  },

  markConversationRead(id) {
    if (!get().unreadConversations[id]) return;
    const unreadConversations = { ...get().unreadConversations };
    delete unreadConversations[id];
    persistUnreadConversations(unreadConversations);
    set({ unreadConversations });
  },

  async loadMessages(id, messageIds) {
    if (!cliClient.isAvailable()) return;
    if (messageIds?.length) {
      const loaded = (
        await Promise.all(messageIds.map((messageId) => cliClient.listMessage(messageId)))
      ).filter((message): message is ConversationMessage =>
        Boolean(message && message.conversationId === id)
      );
      if (!loaded.length) return;
      set((s) => ({
        messages: {
          ...s.messages,
          [id]: mergeConversationMessages(s.messages[id] ?? [], loaded)
        }
      }));
      return;
    }

    const list = await cliClient.listMessages(id);
    set((s) => {
      const sessionInfo = latestSessionInfoFromMessages(list);
      const agentTitle = sessionInfo?.title?.trim();
      const feedArticleTitle = feedArticleTitleFromMessages(list);
      let conversations = s.conversations;
      if (agentTitle) {
        const conversation = conversations.find((entry) => entry.id === id);
        const nextTitle =
          conversation &&
          feedArticleTitle &&
          conversation.title === agentTitle &&
          feedArticleTitle !== conversation.title
            ? feedArticleTitle
            : undefined;
        if (conversation && nextTitle) {
          conversations = conversations.map((entry) =>
            entry.id === id
              ? { ...entry, title: nextTitle, titleSource: "user" as const }
              : entry
          );
          void cliClient.renameConversation(id, nextTitle, "user");
        } else if (
          conversation &&
          shouldApplyAgentSessionTitle(conversation, list, agentTitle)
        ) {
          conversations = conversations.map((entry) =>
            entry.id === id
              ? { ...entry, title: agentTitle, titleSource: "agent" as const }
              : entry
          );
          void cliClient.renameConversation(id, agentTitle, "agent");
        }
      }
      return {
        messages: {
          ...s.messages,
          [id]: mergeConversationMessages(s.messages[id] ?? [], list)
        },
        conversations
      };
    });
  },

  async newConversation({
    member,
    cwd,
    projectId,
    title,
    kind,
    metadata,
    approvalMode,
    configOptionOverrides,
    skillIds
  }) {
    const id = nanoid();
    const conv = await cliClient.createConversation({
      id,
      title: title ?? defaultTitleFor(member, cwd),
      agentId: member.id,
      agentName: member.name,
      adapter: member.cli.adapter,
      kind: kind ?? "default",
      metadata,
      cwd,
      projectId,
      approvalMode: approvalMode ?? member.cli.approvalMode,
      ...(configOptionOverrides && Object.keys(configOptionOverrides).length > 0
        ? { configOptionOverrides }
        : {}),
      skillIds: mergeMemberSkillIds(
        skillIds ?? member.cli.skillIds,
        member.requiredSkillIds
      ),
      titleSource: title ? "prompt" : "default"
    });
    setStoredActiveId(conv.id);
    set((s) => ({
      conversations: [conv, ...s.conversations.filter((c) => c.id !== conv.id)],
      activeId: conv.id,
      messages: { ...s.messages, [conv.id]: [] },
      pendingFreshContext: { ...s.pendingFreshContext, [conv.id]: true }
    }));
    ensureWorkflowMessageSubscription(conv.id, async (cid, messageIds) => {
      await get().loadMessages(cid, messageIds);
    });
    if (conv.cwd) {
      void cliClient.ensureAgentGuides(conv.cwd, {
        nativeBrowserTools:
          useCliExecutorStore.getState().resolve(conv.adapter)?.protocol === "acp"
      }).catch((err) => {
        // best-effort: guide files are optional
        if (import.meta.env?.DEV) {
          console.warn("[FreeBuddy] Failed to ensure agent guides:", err);
        }
      });
    }
    return conv;
  },

  async transferConversation({ sourceConversationId, targetMember }) {
    if (transferInFlight) {
      throw new Error("Another transfer is in progress");
    }
    transferInFlight = true;
    try {
      const targetConversationId = nanoid();
      const result = await cliClient.transferConversation({
        sourceConversationId,
        targetConversationId,
        targetAgentId: targetMember.id,
        targetAgentName: targetMember.name,
        targetAdapter: targetMember.cli.adapter
      });
      set((s) => ({
        conversations: [
          result.conversation,
          ...s.conversations.filter((c) => c.id !== result.conversation.id)
        ],
        activeId: result.conversation.id,
        messages: { ...s.messages, [result.conversation.id]: [] },
        pendingFreshContext: {
          ...s.pendingFreshContext,
          [result.conversation.id]: true
        }
      }));
      ensureWorkflowMessageSubscription(result.conversation.id, async (cid, messageIds) => {
        await get().loadMessages(cid, messageIds);
      });
      let startError: string | undefined;
      try {
        await get().sendMessage({
          conversationId: result.conversation.id,
          prompt: result.seedPrompt,
          preserveConversationTitle: true,
          internalPrompt: true
        });
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
      return {
        conversation: result.conversation,
        warning: result.warning,
        startError
      };
    } finally {
      transferInFlight = false;
    }
  },

  async importCodexSession(sessionId) {
    const result = await cliClient.importCodexSession(sessionId);
    set((s) => ({
      conversations: [
        result.conversation,
        ...s.conversations.filter((c) => c.id !== result.conversation.id)
      ],
      activeId: result.conversation.id,
      messages: { ...s.messages, [result.conversation.id]: [] },
      pendingFreshContext: {
        ...s.pendingFreshContext,
        [result.conversation.id]: true
      }
    }));
    ensureWorkflowMessageSubscription(result.conversation.id, async (cid, messageIds) => {
      await get().loadMessages(cid, messageIds);
    });
    await get().loadMessages(result.conversation.id);
    return result;
  },

  async renameConversation(id, title) {
    await cliClient.renameConversation(id, title, "user");
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, title, titleSource: "user" as const } : c
      )
    }));
  },

  async deleteConversation(id) {
    // Stop any in-flight agent run before removing the conversation so the
    // child process and its IPC event subscription don't keep running
    // orphaned. The eventual "done" event finalizes and cleans up runCtxMap.
    if (get().isRunning(id)) {
      try {
        await get().stopActive(id);
      } catch {
        /* best-effort: still remove the conversation */
      }
    }
    await cliClient.deleteConversation(id);
    set((s) => {
      const next = s.conversations.filter((c) => c.id !== id);
      const nextMessages = { ...s.messages };
      const unreadConversations = { ...s.unreadConversations };
      const pendingFreshContext = { ...s.pendingFreshContext };
      delete nextMessages[id];
      delete unreadConversations[id];
      delete pendingFreshContext[id];
      persistUnreadConversations(unreadConversations);
      return {
        conversations: next,
        messages: nextMessages,
        unreadConversations,
        pendingFreshContext,
        activeId: s.activeId === id ? next[0]?.id : s.activeId
      };
    });
  },

  async archiveConversation(id, archived) {
    await cliClient.archiveConversation(id, archived);
    set((s) => {
      const pendingFreshContext = { ...s.pendingFreshContext };
      if (archived) {
        delete pendingFreshContext[id];
      }
      return {
        conversations: archived
          ? s.conversations.filter((c) => c.id !== id)
          : s.conversations.map((c) =>
              c.id === id ? { ...c, archived } : c
            ),
        pendingFreshContext
      };
    });
  },

  async setConversationApprovalMode(id, approvalMode) {
    await cliClient.setConversationApprovalMode(id, approvalMode);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, approvalMode } : c
      )
    }));
  },

  async setConversationConfigOptionOverrides(id, overrides) {
    const next =
      Object.keys(overrides).length > 0 ? overrides : null;
    const updated = await cliClient.setConversationConfigOptionOverrides(
      id,
      next
    );
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        if (updated) return updated;
        return {
          ...c,
          configOptionOverrides: next ?? undefined
        };
      })
    }));
  },

  async setConversationSkills(id, skillIds) {
    const updated = await cliClient.setConversationSkills(id, skillIds);
    if (!updated) return;
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === id ? updated : conversation
      ),
      pendingFreshContext: { ...state.pendingFreshContext, [id]: true }
    }));
  },

  isRunning(id) {
    const live = get().live[id];
    return !!live && (live.status === "starting" || live.status === "running");
  },

  async sendMessage({
    conversationId,
    prompt,
    attachments = [],
    userMessageId,
    assistantMessageId,
    approvalModeOverride,
    preserveConversationTitle,
    internalPrompt = false,
    memberOverride,
    configOptionOverrides
  }) {
    const trimmed = prompt.trim();
    if (!trimmed && attachments.length === 0) return;
    if (get().isRunning(conversationId)) return;

    const userMsgId = userMessageId ?? nanoid();
    const assistantMsgId = assistantMessageId ?? nanoid();
    const now = new Date().toISOString();
    const taskSessionId = nanoid();

    // Claim the live stream synchronously before any async await points.
    set((s) => ({
      live: {
        ...s.live,
        [conversationId]: {
          messageId: assistantMsgId,
          taskSessionId,
          items: [],
          status: "starting",
          preserveConversationTitle
        }
      }
    }));

    const releaseClaimedLive = () => {
      set((s) => {
        const live = s.live[conversationId];
        if (!live || live.taskSessionId !== taskSessionId) return s;
        if (live.status !== "starting") return s;
        const next = { ...s.live };
        delete next[conversationId];
        return { live: next };
      });
    };

    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv) {
      releaseClaimedLive();
      return;
    }
    const workflowRun = await workflowRunForConversation(conversationId);
    const member =
      memberOverride ??
      (memberForWorkflowFollowup(workflowRun, get().members) ??
      get().members.find((m) => m.id === conv.agentId));
    if (!member) {
      releaseClaimedLive();
      throw new Error(`Member ${conv.agentId} not found`);
    }

    try {
    if (!internalPrompt) {
      const userMsg: ConversationMessage = {
        id: userMsgId,
        conversationId,
        role: "user",
        status: "sent",
        content: trimmed,
        ...(attachments.length ? { attachments } : {}),
        authorUsername: get().currentUser?.username ?? null,
        createdAt: now,
        updatedAt: now
      };
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: upsertConversationMessage(
            s.messages[conversationId] ?? [],
            userMsg
          )
        }
      }));
      const savedUser = await cliClient.appendMessage({
        id: userMsgId,
        conversationId,
        role: "user",
        status: "sent",
        content: trimmed,
        attachments
      });
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: upsertConversationMessage(
            s.messages[conversationId] ?? [],
            {
              ...userMsg,
              attachments: savedUser.attachments ?? userMsg.attachments,
              authorUsername: savedUser.authorUsername ?? userMsg.authorUsername
            }
          )
        }
      }));
    }

    const assistantMsg: ConversationMessage = {
      id: assistantMsgId,
      conversationId,
      role: "assistant",
      status: "running",
      content: "[]",
      agentId: member.id,
      agentName: member.name,
      adapter: member.cli.adapter,
      createdAt: now,
      updatedAt: now
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: upsertConversationMessage(
          s.messages[conversationId] ?? [],
          assistantMsg
        )
      }
    }));
    await cliClient.appendMessage({
      id: assistantMsgId,
      conversationId,
      role: "assistant",
      status: "running",
      content: "[]",
      agentId: member.id,
      agentName: member.name,
      adapter: member.cli.adapter
    });

    const wantFresh = get().pendingFreshContext[conversationId] === true;
    const resolved = useCliExecutorStore
      .getState()
      .resolve(member.cli.adapter);
    const binary = member.cli.binary || resolved?.binary;
    const extraArgs = [
      ...(resolved?.extraArgs ?? []),
      ...(member.cli.extraArgs ?? [])
    ];
    const toolSessionScope = workflowRun
      ? workflowFollowupToolSessionScope(workflowRun, member)
      : `conversation:${conv.id}`;

    let resumedFromSessionId: string | undefined;
    if (!wantFresh) {
      const prev = await cliClient.getToolSession(member.id, toolSessionScope);
      if (prev && prev.adapter === member.cli.adapter) {
        resumedFromSessionId = prev.sessionId;
      }
      if (!workflowRun) {
        resumedFromSessionId ??= latestSessionIdFromMessages(
          get().messages[conversationId] ?? [],
          member.cli.adapter
        );
      }
    }
    const userPrompt = composeMessageWithAttachments(trimmed, attachments);
    const workflowFollowupContext =
      workflowRun && (wantFresh || !resumedFromSessionId)
        ? await workflowFollowupContextForRun(workflowRun)
        : undefined;
    // No resumable agent session (common after a failed first turn): inject
    // FreeBuddy chat history so short follow-ups like "continue" keep prior asks.
    const orphanFollowupContext =
      !workflowRun && !wantFresh && !resumedFromSessionId
        ? buildOrphanFollowupContext(get().messages[conversationId] ?? [], {
            excludeMessageIds: [userMsgId, assistantMsgId]
          })
        : undefined;
    const promptWithWorkflowContext = workflowFollowupContext
      ? `${workflowFollowupContext}\n\nUser follow-up:\n${userPrompt}`
      : composeOrphanFollowupPrompt(userPrompt, orphanFollowupContext);

    const msgs = get().messages[conversationId] ?? [];
    const liveItems = get().live[conversationId]?.items;
    const fromMessages = latestConfigOptionsFromMessages(msgs);
    const fromLive = latestConfigOptionsFromItems(liveItems ?? []);
    const configOptions = fromLive.length > 0 ? fromLive : fromMessages;
    const activeOverrides = configOptionOverrides ?? conv.configOptionOverrides;
    const overridesToSend = resolveConfigOptionOverrides(
      activeOverrides,
      configOptions
    );
    const combinedOverrides = {
      ...(overridesToSend ?? {}),
      ...(configOptionOverrides ?? {})
    };

    const runArgs: CliRunArgs = {
      sessionId: taskSessionId,
      conversationId,
      agentId: member.id,
      agentName: member.name,
      adapter: member.cli.adapter,
      binary,
      extraArgs,
      prompt: promptWithWorkflowContext,
      promptAttachments: attachments.map((attachment) => ({
        path: attachment.path,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        name: attachment.name
      })),
      cwd: conv.cwd,
      workspaceRoots: resolveWorkspaceRootsForConversation(conv),
      toolSessionScope,
      toolSessionId: resumedFromSessionId,
      env: { ...(resolved?.env ?? {}), ...(member.cli.env ?? {}) },
      approvalMode:
        approvalModeOverride ?? conv.approvalMode ?? member.cli.approvalMode,
      ...(Object.keys(combinedOverrides).length > 0
        ? { configOptionOverrides: combinedOverrides }
        : {}),
      showStderr: member.cli.showStderr,
      resumeToolSession: !wantFresh,
      userMessageId: userMsgId,
      knownStreamMessageIds: collectStreamMessageIds(
        get().messages[conversationId] ?? []
      ),
      // Content signatures suppress history replay from resumed ACP sessions.
      // A fresh session cannot replay history, so every live chunk must pass.
      ...(resumedFromSessionId
        ? {
            knownStreamContentSignatures: collectStreamContentSignatures(msgs)
          }
        : {}),
      knownAgentStreamMessageIds: collectStreamAgentMessageIds(
        get().messages[conversationId] ?? []
      ),
      skills: conv.skillSnapshot,
      announceSkills: wantFresh || !resumedFromSessionId
    };

    const parser = getParser(resolved?.streamMode ?? "raw");
    const parseCtx: ParseContext = {};

    set((s) => ({
      live: {
        ...s.live,
        [conversationId]: {
          messageId: assistantMsgId,
          taskSessionId,
          items: [],
          status: "starting",
          resumedFromSessionId,
          preserveConversationTitle
        }
      },
      pendingFreshContext: {
        ...s.pendingFreshContext,
        [conversationId]: false
      }
    }));

    // Update assistant message in DB with task id binding.
    await cliClient.updateMessage({
      id: assistantMsgId,
      taskId: taskSessionId
    });

    const unsubscribe = cliClient.onEvent(taskSessionId, (e: CliEvent) => {
      handleStreamEvent(
        set,
        get,
        conversationId,
        e,
        parser,
        parseCtx,
        preserveConversationTitle
      );
    });
    runCtxMap.set(taskSessionId, {
      conversationId,
      messageId: assistantMsgId,
      parser,
      parseCtx,
      unsubscribe
    });

    try {
      await cliClient.run(runArgs);
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      debugLogClient.error("chat", "agent run failed", { errorMessage: msg });
      const failedItems = appendItems(
        get().live[conversationId]?.items ?? [],
        [{ kind: "error", message: msg }]
      );
      set((s) => {
        const live = s.live[conversationId];
        if (!live) return s;
        return {
          live: {
            ...s.live,
            [conversationId]: {
              ...live,
              items: failedItems,
              status: "failed",
              errorMessage: msg
            }
          }
        };
      });
      const failedContent = JSON.stringify(failedItems);
      runCtxMap.get(taskSessionId)?.unsubscribe();
      runCtxMap.delete(taskSessionId);
      set((s) => {
        const nextLive = { ...s.live };
        if (nextLive[conversationId]?.taskSessionId === taskSessionId) {
          delete nextLive[conversationId];
        }
        const messageList = s.messages[conversationId] ?? [];
        const messageIndex = messageList.findIndex(
          (message) => message.id === assistantMsgId
        );
        if (messageIndex < 0) return { live: nextLive };
        const updated = [...messageList];
        updated[messageIndex] = {
          ...updated[messageIndex],
          status: "failed",
          content: failedContent,
          updatedAt: new Date().toISOString()
        };
        return {
          live: nextLive,
          messages: { ...s.messages, [conversationId]: updated }
        };
      });
      try {
        await cliClient.updateMessage({
          id: assistantMsgId,
          status: "failed",
          content: failedContent
        });
      } catch (persistError) {
        debugLogClient.error("chat", "failed to persist rejected agent run", {
          conversationId,
          taskSessionId,
          errorMessage:
            (persistError as Error)?.message || String(persistError)
        });
      }
    }
    } catch (err) {
      releaseClaimedLive();
      throw err;
    }
  },

  async stopActive(conversationId) {
    await killConversation(set, get, conversationId);
  }
}));

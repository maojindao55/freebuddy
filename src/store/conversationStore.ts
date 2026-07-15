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
  ConversationMessage
} from "@/services/cli/types";
import type {
  WorkflowRunRow,
  WorkflowStepRow
} from "@/services/workflows/types";
import { workflowFollowupAgentId } from "@/services/workflows/types";
import { workflowClient } from "@/services/workflows/client";
import { composeMessageWithAttachments } from "@/utils/chatAttachments";
import {
  filterSessionConfigPickerOptions,
  pruneConfigOptionOverrides
} from "@/utils/sessionConfigOptions";

import { useCliExecutorStore } from "./cliExecutorStore";
import {
  collectStreamMessageIds,
  defaultTitleFor,
  feedArticleTitleFromMessages,
  mergeConversationMessages,
  shouldApplyAgentSessionTitle,
  upsertConversationMessage
} from "./conversationUtils";
import { handleStreamEvent, killConversation } from "./conversationHandlers";
import {
  latestConfigOptionsFromItems,
  latestConfigOptionsFromMessages,
  latestSessionInfoFromMessages
} from "./sessionMetaUtils";

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
  conversations: Conversation[];
  activeId?: string;
  messages: Record<string, ConversationMessage[]>;
  live: Record<string, LiveAssistant>;
  pendingFreshContext: Record<string, boolean>;

  load(): Promise<void>;
  refreshMembers(): void;
  setActive(id: string | undefined): Promise<void>;
  loadMessages(id: string, messageIds?: string[]): Promise<void>;

  newConversation(input: {
    member: CLIMember;
    cwd?: string;
    title?: string;
    approvalMode?: "auto" | "ask";
    configOptionOverrides?: Record<string, string>;
    skillIds?: string[];
  }): Promise<Conversation>;
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

let workflowMessageUnsubscribe: (() => void) | null = null;
let workflowMessageConversationId: string | null = null;
let workflowRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const workflowPendingMessageIds = new Set<string>();

function hasActiveWorkflowMessages(messages: ConversationMessage[] | undefined): boolean {
  return (
    messages?.some(
      (message) =>
        Boolean(message.workflowRunId && message.workflowStepRowId) &&
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
  if (workflowMessageConversationId === conversationId) return;
  if (workflowMessageUnsubscribe) {
    try {
      workflowMessageUnsubscribe();
    } catch {
      /* noop */
    }
    workflowMessageUnsubscribe = null;
  }
  if (workflowRefreshTimer) {
    clearTimeout(workflowRefreshTimer);
    workflowRefreshTimer = null;
  }
  workflowPendingMessageIds.clear();
  workflowMessageConversationId = conversationId ?? null;
  if (!conversationId) return;
  workflowMessageUnsubscribe = api.onStepMessage(conversationId, (event: { messageId?: string }) => {
    if (event.messageId) workflowPendingMessageIds.add(event.messageId);
    if (workflowRefreshTimer) return;
    workflowRefreshTimer = setTimeout(() => {
      workflowRefreshTimer = null;
      const ids = [...workflowPendingMessageIds];
      workflowPendingMessageIds.clear();
      void refresh(conversationId, ids.length ? ids : undefined);
    }, 300);
  });
}

function latestSessionIdFromMessages(messages: ConversationMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
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

function buildConversationMembers(): CLIMember[] {
  const executorStore = useCliExecutorStore.getState();
  const builtinMembers = builtinCliMembers.map((member) => ({
    ...member,
    cli: {
      ...member.cli,
      skillIds: executorStore.resolve(member.cli.adapter)?.skillIds
    }
  }));
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

export const useConversationStore = create<ConversationState>((set, get) => ({
  members: buildConversationMembers(),
  conversations: [],
  activeId: undefined,
  messages: {},
  live: {},
  pendingFreshContext: {},

  async load() {
    if (!cliClient.isAvailable()) return;
    const members = buildConversationMembers();
    const list = await cliClient.listConversations({ archived: false });
    const synced = syncConversationAgentNames(list, members);
    persistSyncedConversationAgentNames(synced);
    set({ members, conversations: synced.conversations });
    const cur = get().activeId;
    if (cur && !list.find((c) => c.id === cur)) {
      set({ activeId: list[0]?.id });
    } else if (!cur && list.length) {
      set({ activeId: list[0].id });
    }
    const active = get().activeId;
    if (active && !get().messages[active]) {
      await get().loadMessages(active);
    }
    ensureWorkflowMessageSubscription(active, async (cid, messageIds) => {
      await get().loadMessages(cid, messageIds);
    });
  },

  refreshMembers() {
    const members = buildConversationMembers();
    const synced = syncConversationAgentNames(get().conversations, members);
    persistSyncedConversationAgentNames(synced);
    set({ members, conversations: synced.conversations });
  },

  async setActive(id) {
    set({ activeId: id });
    const cachedMessages = id ? get().messages[id] : undefined;
    if (id && (!cachedMessages || hasActiveWorkflowMessages(cachedMessages))) {
      await get().loadMessages(id);
    }
    ensureWorkflowMessageSubscription(id, async (cid, messageIds) => {
      await get().loadMessages(cid, messageIds);
    });
    if (id) {
      const conv = get().conversations.find((c) => c.id === id);
      if (conv?.cwd) {
        void cliClient.ensureAgentGuides(conv.cwd, {
          nativeDraftTools:
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
    title,
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
      cwd,
      approvalMode: approvalMode ?? member.cli.approvalMode,
      ...(configOptionOverrides && Object.keys(configOptionOverrides).length > 0
        ? { configOptionOverrides }
        : {}),
      skillIds: skillIds ?? member.cli.skillIds ?? [],
      titleSource: title ? "prompt" : "default"
    });
    set((s) => ({
      conversations: [conv, ...s.conversations.filter((c) => c.id !== conv.id)],
      activeId: conv.id,
      messages: { ...s.messages, [conv.id]: [] },
      pendingFreshContext: { ...s.pendingFreshContext, [conv.id]: true }
    }));
    ensureWorkflowMessageSubscription(conv.id, async (cid, messageIds) => {
      await get().loadMessages(cid, messageIds);
    });
    if (cwd) {
      void cliClient.ensureAgentGuides(cwd, {
        nativeDraftTools:
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
      delete nextMessages[id];
      return {
        conversations: next,
        messages: nextMessages,
        activeId: s.activeId === id ? next[0]?.id : s.activeId
      };
    });
  },

  async archiveConversation(id, archived) {
    await cliClient.archiveConversation(id, archived);
    set((s) => ({
      conversations: archived
        ? s.conversations.filter((c) => c.id !== id)
        : s.conversations.map((c) =>
            c.id === id ? { ...c, archived } : c
          )
    }));
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
    preserveConversationTitle
  }) {
    const trimmed = prompt.trim();
    if (!trimmed && attachments.length === 0) return;
    if (get().isRunning(conversationId)) return;

    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const workflowRun = await workflowRunForConversation(conversationId);
    const member =
      memberForWorkflowFollowup(workflowRun, get().members) ??
      get().members.find((m) => m.id === conv.agentId);
    if (!member) throw new Error(`Member ${conv.agentId} not found`);

    const userMsgId = userMessageId ?? nanoid();
    const now = new Date().toISOString();
    const userMsg: ConversationMessage = {
      id: userMsgId,
      conversationId,
      role: "user",
      status: "sent",
      content: trimmed,
      ...(attachments.length ? { attachments } : {}),
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
            attachments: savedUser.attachments ?? userMsg.attachments
          }
        )
      }
    }));

    const assistantMsgId = assistantMessageId ?? nanoid();
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

    const taskSessionId = nanoid();
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
          get().messages[conversationId] ?? []
        );
      }
    }
    const userPrompt = composeMessageWithAttachments(trimmed, attachments);
    const workflowFollowupContext =
      workflowRun && (wantFresh || !resumedFromSessionId)
        ? await workflowFollowupContextForRun(workflowRun)
        : undefined;
    const promptWithWorkflowContext = workflowFollowupContext
      ? `${workflowFollowupContext}\n\nUser follow-up:\n${userPrompt}`
      : userPrompt;

    const msgs = get().messages[conversationId] ?? [];
    const liveItems = get().live[conversationId]?.items;
    const fromMessages = latestConfigOptionsFromMessages(msgs);
    const fromLive = latestConfigOptionsFromItems(liveItems ?? []);
    const configOptions = fromLive.length > 0 ? fromLive : fromMessages;
    const pickerOptions = filterSessionConfigPickerOptions(configOptions);
    const prunedOverrides = pruneConfigOptionOverrides(
      conv.configOptionOverrides,
      pickerOptions.length ? pickerOptions : configOptions
    );
    const overridesToSend =
      Object.keys(prunedOverrides).length > 0
        ? prunedOverrides
        : conv.configOptionOverrides &&
            Object.keys(conv.configOptionOverrides).length > 0
          ? conv.configOptionOverrides
          : undefined;

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
      toolSessionScope,
      toolSessionId: resumedFromSessionId,
      env: { ...(resolved?.env ?? {}), ...(member.cli.env ?? {}) },
      approvalMode:
        approvalModeOverride ?? conv.approvalMode ?? member.cli.approvalMode,
      ...(overridesToSend && Object.keys(overridesToSend).length
        ? { configOptionOverrides: overridesToSend }
        : {}),
      showStderr: member.cli.showStderr,
      resumeToolSession: !wantFresh,
      userMessageId: userMsgId,
      knownStreamMessageIds: collectStreamMessageIds(
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
      set((s) => {
        const live = s.live[conversationId];
        if (!live) return s;
        return {
          live: {
            ...s.live,
            [conversationId]: {
              ...live,
              status: "failed",
              errorMessage: msg
            }
          }
        };
      });
      await cliClient.updateMessage({
        id: assistantMsgId,
        status: "failed",
        content: JSON.stringify([{ kind: "error", message: msg }])
      });
      runCtxMap.get(taskSessionId)?.unsubscribe();
      runCtxMap.delete(taskSessionId);
    }
  },

  async stopActive(conversationId) {
    await killConversation(set, get, conversationId);
  }
}));

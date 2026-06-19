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
import { composeMessageWithAttachments } from "@/utils/chatAttachments";

import { useCliExecutorStore } from "./cliExecutorStore";
import { defaultTitleFor } from "./conversationUtils";
import { handleStreamEvent, killConversation } from "./conversationHandlers";

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
}

export interface ConversationState {
  members: CLIMember[];
  conversations: Conversation[];
  activeId?: string;
  messages: Record<string, ConversationMessage[]>;
  live: Record<string, LiveAssistant>;
  pendingFreshContext: Record<string, boolean>;

  load(): Promise<void>;
  setActive(id: string | undefined): Promise<void>;
  loadMessages(id: string): Promise<void>;

  newConversation(input: {
    member: CLIMember;
    cwd?: string;
    title?: string;
    approvalMode?: "auto" | "ask";
  }): Promise<Conversation>;
  renameConversation(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  archiveConversation(id: string, archived: boolean): Promise<void>;
  setConversationApprovalMode(
    id: string,
    approvalMode: "auto" | "ask"
  ): Promise<void>;

  sendMessage(input: {
    conversationId: string;
    prompt: string;
    attachments?: ChatAttachment[];
    userMessageId?: string;
    assistantMessageId?: string;
    approvalModeOverride?: "auto" | "ask";
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

export const useConversationStore = create<ConversationState>((set, get) => ({
  members: builtinCliMembers,
  conversations: [],
  activeId: undefined,
  messages: {},
  live: {},
  pendingFreshContext: {},

  async load() {
    if (!cliClient.isAvailable()) return;
    const list = await cliClient.listConversations({ archived: false });
    set({ conversations: list });
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
  },

  async setActive(id) {
    set({ activeId: id });
    if (id && !get().messages[id]) {
      await get().loadMessages(id);
    }
  },

  async loadMessages(id) {
    if (!cliClient.isAvailable()) return;
    const list = await cliClient.listMessages(id);
    set((s) => ({ messages: { ...s.messages, [id]: list } }));
  },

  async newConversation({ member, cwd, title, approvalMode }) {
    const id = nanoid();
    const conv = await cliClient.createConversation({
      id,
      title: title ?? defaultTitleFor(member, cwd),
      agentId: member.id,
      agentName: member.name,
      adapter: member.cli.adapter,
      cwd,
      approvalMode: approvalMode ?? member.cli.approvalMode
    });
    set((s) => ({
      conversations: [conv, ...s.conversations.filter((c) => c.id !== conv.id)],
      activeId: conv.id,
      messages: { ...s.messages, [conv.id]: [] },
      pendingFreshContext: { ...s.pendingFreshContext, [conv.id]: true }
    }));
    return conv;
  },

  async renameConversation(id, title) {
    await cliClient.renameConversation(id, title);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, title } : c
      )
    }));
  },

  async deleteConversation(id) {
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
    approvalModeOverride
  }) {
    const trimmed = prompt.trim();
    if (!trimmed && attachments.length === 0) return;
    if (get().isRunning(conversationId)) return;

    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const member = get().members.find((m) => m.id === conv.agentId);
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
        [conversationId]: [...(s.messages[conversationId] ?? []), userMsg]
      }
    }));
    await cliClient.appendMessage({
      id: userMsgId,
      conversationId,
      role: "user",
      status: "sent",
      content: trimmed,
      attachments,
    });

    const assistantMsgId = assistantMessageId ?? nanoid();
    const assistantMsg: ConversationMessage = {
      id: assistantMsgId,
      conversationId,
      role: "assistant",
      status: "running",
      content: "[]",
      createdAt: now,
      updatedAt: now
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [
          ...(s.messages[conversationId] ?? []),
          assistantMsg
        ]
      }
    }));
    await cliClient.appendMessage({
      id: assistantMsgId,
      conversationId,
      role: "assistant",
      status: "running",
      content: "[]"
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
    const toolSessionScope = conv.cwd ?? `conversation:${conv.id}`;

    let resumedFromSessionId: string | undefined;
    if (!wantFresh) {
      const prev = await cliClient.getToolSession(member.id, toolSessionScope);
      if (prev && prev.adapter === member.cli.adapter) {
        resumedFromSessionId = prev.sessionId;
      }
      resumedFromSessionId ??= latestSessionIdFromMessages(
        get().messages[conversationId] ?? []
      );
    }

    const runArgs: CliRunArgs = {
      sessionId: taskSessionId,
      agentId: member.id,
      agentName: member.name,
      adapter: member.cli.adapter,
      binary,
      extraArgs,
      prompt: composeMessageWithAttachments(trimmed, attachments),
      cwd: conv.cwd,
      toolSessionScope,
      toolSessionId: resumedFromSessionId,
      env: { ...(resolved?.env ?? {}), ...(member.cli.env ?? {}) },
      approvalMode:
        approvalModeOverride ?? conv.approvalMode ?? member.cli.approvalMode,
      showStderr: member.cli.showStderr,
      resumeToolSession: !wantFresh
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
          resumedFromSessionId
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
      handleStreamEvent(set, get, conversationId, e, parser, parseCtx);
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

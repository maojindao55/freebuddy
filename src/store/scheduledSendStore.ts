import { create } from "zustand";
import type { ConversationReferenceDraft } from "@/utils/conversationReferences";

import type { ChatAttachment } from "@/services/cli/types";
import { scheduledTasksClient } from "@/services/scheduledTasks/client";
import type { ScheduledTask } from "@/services/scheduledTasks/types";
import type { SkillSnapshot } from "@/services/skills/types";
import {
  toLocalDateAndTime,
  truncatePromptPreview,
  type ScheduledSendStatus,
  type ScheduledSendTriggerKind
} from "@/utils/scheduledSend";

export interface ScheduledSend {
  /** Backing SQLite scheduled_tasks.id when persisted via Electron/WebUI bridge. */
  taskId?: string;
  conversationId: string;
  prompt: string;
  attachments: ChatAttachment[];
  messageSkills?: SkillSnapshot[];
  conversationReferences?: ConversationReferenceDraft[];
  approvalMode?: "auto" | "ask";
  triggerKind?: ScheduledSendTriggerKind;
  /** Epoch milliseconds at which the message should be sent. */
  fireAt: number;
  createdAt: number;
  status: ScheduledSendStatus;
  error?: string;
}

export interface ScheduleSendInput {
  conversationId: string;
  agentId?: string;
  title?: string;
  prompt: string;
  attachments: ChatAttachment[];
  messageSkills?: SkillSnapshot[];
  conversationReferences?: ConversationReferenceDraft[];
  approvalMode?: "auto" | "ask";
  triggerKind?: ScheduledSendTriggerKind;
  fireAt: number;
}

function mapTaskStatus(task: ScheduledTask): ScheduledSendStatus {
  switch (task.lastStatus) {
    case "running":
      return "sending";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "missed":
      return "missed";
    default:
      return task.enabled ? "pending" : "missed";
  }
}

export function scheduledTaskToScheduledSend(
  task: ScheduledTask
): ScheduledSend | undefined {
  if (task.targetKind !== "conversation_message" || !task.targetConversationId) {
    return undefined;
  }
  if (task.lastStatus === "completed" && !task.enabled) {
    return undefined;
  }
  const fireAt =
    task.fireAtMs ??
    (task.nextRunAt ? Date.parse(task.nextRunAt) : Date.parse(task.updatedAt));
  const createdAt = Date.parse(task.createdAt);
  return {
    taskId: task.id,
    conversationId: task.targetConversationId,
    prompt: task.prompt,
    attachments: task.attachments ?? [],
    messageSkills: task.payload?.messageSkills,
    conversationReferences: task.payload?.conversationReferences,
    approvalMode: task.payload?.approvalMode,
    triggerKind: task.triggerKind,
    fireAt: Number.isFinite(fireAt) ? fireAt : Date.now(),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    status: mapTaskStatus(task),
    error: task.lastError
  };
}

interface ScheduledSendState {
  /** One scheduled send per conversation. */
  entries: Record<string, ScheduledSend>;
  /** Clock driven by the runner so countdown UIs re-render once per second. */
  now: number;
  hydrated: boolean;
  hydrate(): Promise<void>;
  syncFromTasks(tasks: ScheduledTask[]): void;
  upsertFromTask(task: ScheduledTask): void;
  schedule(input: ScheduleSendInput): Promise<ScheduledSend>;
  /** Moves the fire time to now; the runner sends it on its next tick. */
  fireNow(conversationId: string): Promise<void>;
  /** Re-arms a failed or missed entry so the runner retries immediately. */
  retry(conversationId: string): Promise<void>;
  setStatus(conversationId: string, status: ScheduledSendStatus, error?: string): void;
  remove(
    conversationId: string,
    options?: { preserveAttachments?: boolean; localOnly?: boolean }
  ): Promise<ScheduledSend | undefined>;
  tick(now?: number): void;
}

export const useScheduledSendStore = create<ScheduledSendState>((set, get) => ({
  entries: {},
  now: Date.now(),
  hydrated: false,

  async hydrate() {
    if (!scheduledTasksClient.isAvailable()) {
      set({ hydrated: true });
      return;
    }
    try {
      const tasks = await scheduledTasksClient.list();
      get().syncFromTasks(tasks);
      set({ hydrated: true });
    } catch {
      // Keep current snapshot on transient IPC failure.
    }
  },

  syncFromTasks(tasks) {
    const nextEntries: Record<string, ScheduledSend> = {};
    // Tasks come ordered created_at DESC; keep the newest per conversation.
    for (const task of tasks) {
      const mapped = scheduledTaskToScheduledSend(task);
      if (!mapped) continue;
      if (!nextEntries[mapped.conversationId]) {
        nextEntries[mapped.conversationId] = mapped;
      }
    }
    set({ entries: nextEntries, now: Date.now() });
  },

  upsertFromTask(task) {
    if (task.targetKind !== "conversation_message" || !task.targetConversationId) return;
    const mapped = scheduledTaskToScheduledSend(task);
    set((state) => {
      const next = { ...state.entries };
      if (!mapped) {
        if (next[task.targetConversationId!]?.taskId === task.id) {
          delete next[task.targetConversationId!];
        }
      } else {
        next[mapped.conversationId] = mapped;
      }
      return { entries: next, now: Date.now() };
    });
  },

  async schedule({
    conversationId,
    agentId,
    title,
    prompt,
    attachments,
    messageSkills,
    conversationReferences,
    approvalMode,
    triggerKind = "schedule",
    fireAt
  }) {
    const now = Date.now();
    if (scheduledTasksClient.isAvailable()) {
      const { scheduleDate, timeLocal } = toLocalDateAndTime(fireAt);
      const derivedTitle =
        title?.trim() ||
        truncatePromptPreview(prompt || attachments[0]?.name || "Scheduled message", 80);
      const result = await scheduledTasksClient.create({
        title: derivedTitle,
        prompt,
        agentId: agentId ?? "",
        scheduleType: "once",
        scheduleDate,
        timeLocal,
        executionMode: "continuous",
        targetKind: "conversation_message",
        targetConversationId: conversationId,
        triggerKind,
        fireAtMs: fireAt,
        cleanupAfterRun: true,
        attachments: attachments.length > 0 ? attachments : undefined,
        payload:
          messageSkills?.length || conversationReferences?.length || approvalMode
            ? {
                ...(messageSkills?.length ? { messageSkills } : {}),
                ...(conversationReferences?.length ? { conversationReferences } : {}),
                ...(approvalMode ? { approvalMode } : {})
              }
            : undefined,
        enabled: true
      });
      if (!result.ok) {
        throw new Error(result.errors.join("; ") || "Failed to schedule message");
      }
      const mapped = scheduledTaskToScheduledSend(result.task)!;
      set((state) => ({
        now,
        entries: { ...state.entries, [conversationId]: mapped }
      }));
      return mapped;
    }

    const entry: ScheduledSend = {
      conversationId,
      prompt,
      attachments,
      messageSkills,
      conversationReferences,
      approvalMode,
      triggerKind,
      fireAt,
      createdAt: now,
      status: "pending"
    };
    set((state) => ({
      now,
      entries: { ...state.entries, [conversationId]: entry }
    }));
    return entry;
  },

  async fireNow(conversationId) {
    const entry = get().entries[conversationId];
    if (!entry || entry.status === "sending") return;
    const now = Date.now();
    set((state) => {
      const current = state.entries[conversationId];
      if (!current || current.status === "sending") return state;
      return {
        now,
        entries: {
          ...state.entries,
          [conversationId]: {
            ...current,
            fireAt: now,
            status: "pending",
            error: undefined
          }
        }
      };
    });
    if (entry.taskId && scheduledTasksClient.isAvailable()) {
      await scheduledTasksClient.run(entry.taskId).catch(() => {});
    }
  },

  async retry(conversationId) {
    const entry = get().entries[conversationId];
    if (!entry || (entry.status !== "failed" && entry.status !== "missed")) return;
    await get().fireNow(conversationId);
  },

  setStatus(conversationId, status, error) {
    set((state) => {
      const entry = state.entries[conversationId];
      if (!entry) return state;
      return {
        entries: {
          ...state.entries,
          [conversationId]: { ...entry, status, error }
        }
      };
    });
  },

  async remove(conversationId, options) {
    const entry = get().entries[conversationId];
    if (!entry) return undefined;
    if (!options?.localOnly && entry.taskId && scheduledTasksClient.isAvailable()) {
      const deleted = await scheduledTasksClient
        .delete(
          entry.taskId,
          options?.preserveAttachments ? { preserveAttachments: true } : undefined
        )
        .catch(() => false);
      if (!deleted) {
        // Re-sync in case the task was already consumed or deleted elsewhere.
        void get().hydrate();
      }
    }
    set((state) => {
      const next = { ...state.entries };
      if (next[conversationId]?.taskId === entry.taskId) {
        delete next[conversationId];
      }
      return { entries: next };
    });
    return entry;
  },

  tick(now = Date.now()) {
    set({ now });
  }
}));

export function dueScheduledSends(
  entries: Record<string, ScheduledSend>,
  now: number
): ScheduledSend[] {
  return Object.values(entries).filter(
    (entry) =>
      (entry.status === "pending" || entry.status === "waiting") &&
      entry.fireAt <= now
  );
}

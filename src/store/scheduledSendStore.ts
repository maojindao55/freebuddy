import { create } from "zustand";

import type { ChatAttachment } from "@/services/cli/types";
import type { ScheduledSendStatus } from "@/utils/scheduledSend";

export interface ScheduledSend {
  conversationId: string;
  prompt: string;
  attachments: ChatAttachment[];
  /** Epoch milliseconds at which the message should be sent. */
  fireAt: number;
  createdAt: number;
  status: ScheduledSendStatus;
  error?: string;
}

interface ScheduledSendState {
  /** One scheduled send per conversation. */
  entries: Record<string, ScheduledSend>;
  /** Clock driven by the runner so countdown UIs re-render once per second. */
  now: number;
  schedule(input: {
    conversationId: string;
    prompt: string;
    attachments: ChatAttachment[];
    fireAt: number;
  }): ScheduledSend;
  /** Moves the fire time to now; the runner sends it on its next tick. */
  fireNow(conversationId: string): void;
  /** Re-arms a failed entry so the runner retries immediately. */
  retry(conversationId: string): void;
  setStatus(conversationId: string, status: ScheduledSendStatus, error?: string): void;
  remove(conversationId: string): ScheduledSend | undefined;
  tick(now?: number): void;
}

export const useScheduledSendStore = create<ScheduledSendState>((set, get) => ({
  entries: {},
  now: Date.now(),

  schedule({ conversationId, prompt, attachments, fireAt }) {
    const now = Date.now();
    const entry: ScheduledSend = {
      conversationId,
      prompt,
      attachments,
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

  fireNow(conversationId) {
    set((state) => {
      const entry = state.entries[conversationId];
      if (!entry || entry.status === "sending") return state;
      return {
        entries: {
          ...state.entries,
          [conversationId]: {
            ...entry,
            fireAt: Date.now(),
            status: "pending",
            error: undefined
          }
        }
      };
    });
  },

  retry(conversationId) {
    const entry = get().entries[conversationId];
    if (!entry || entry.status !== "failed") return;
    get().fireNow(conversationId);
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

  remove(conversationId) {
    const entry = get().entries[conversationId];
    if (!entry) return undefined;
    set((state) => {
      const next = { ...state.entries };
      delete next[conversationId];
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

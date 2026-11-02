import { create } from "zustand";
import type { ConversationOverview } from "@freebuddy/protocol";

import { cliClient } from "@/services/cli/client";

interface ConversationOverviewState {
  overviews: Record<string, ConversationOverview>;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  refresh(ids: string[]): Promise<void>;
}

const pending = new Set<string>();
const dirty = new Set<string>();

/** Lightweight snapshots only; this never fetches or retains full message histories. */
export const useConversationOverviewStore = create<ConversationOverviewState>((set, get) => ({
  overviews: {},
  loading: {},
  errors: {},
  async refresh(ids) {
    const requested = [...new Set(ids)].filter((id) => {
      if (!id) return false;
      if (pending.has(id)) { dirty.add(id); return false; }
      return true;
    });
    if (!requested.length) return;
    for (const id of requested) pending.add(id);
    set((state) => ({
      loading: { ...state.loading, ...Object.fromEntries(requested.map((id) => [id, true])) },
      errors: Object.fromEntries(Object.entries(state.errors).filter(([id]) => !requested.includes(id)))
    }));
    for (let offset = 0; offset < requested.length; offset += 100) {
      const batch = requested.slice(offset, offset + 100);
      try {
        const snapshots = await cliClient.listConversationOverviews(batch);
        const received = new Set(snapshots.map((snapshot) => snapshot.conversationId));
        set((state) => ({
          overviews: { ...state.overviews, ...Object.fromEntries(snapshots.map((snapshot) => [snapshot.conversationId, snapshot])) },
          errors: {
            ...state.errors,
            ...Object.fromEntries(batch.filter((id) => !received.has(id)).map((id) => [id, "Overview unavailable"]))
          }
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ errors: { ...state.errors, ...Object.fromEntries(batch.map((id) => [id, message])) } }));
      } finally {
        for (const id of batch) pending.delete(id);
        set((state) => ({
          loading: Object.fromEntries(Object.entries(state.loading).filter(([id]) => !batch.includes(id)))
        }));
        // Messages may change while a batch is in flight. Replay once after it
        // resolves so the new event cannot be swallowed by request deduping.
        const replay = batch.filter((id) => dirty.delete(id));
        if (replay.length) await get().refresh(replay);
      }
    }
  }
}));

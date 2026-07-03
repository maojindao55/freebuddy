import { create } from "zustand";

import { feedClient } from "@/services/feed/client";
import type {
  AddFeedSourceInput,
  FeedItem,
  FeedRefreshResult,
  FeedSource,
  UpdateFeedSourceInput
} from "@/services/feed/types";

interface FeedState {
  sources: FeedSource[];
  items: FeedItem[];
  loaded: boolean;
  loading: boolean;
  refreshing: boolean;
  error?: string;

  load(): Promise<void>;
  loadItems(): Promise<void>;
  addSource(input: AddFeedSourceInput): Promise<FeedSource>;
  updateSource(input: UpdateFeedSourceInput): Promise<FeedSource | undefined>;
  deleteSource(id: string): Promise<boolean>;
  refreshSource(id: string): Promise<FeedRefreshResult>;
  refreshAll(): Promise<FeedRefreshResult[]>;
  markInterpreted(id: string): Promise<void>;
}

export const useFeedStore = create<FeedState>((set, get) => ({
  sources: [],
  items: [],
  loaded: false,
  loading: false,
  refreshing: false,
  error: undefined,

  async load() {
    if (!feedClient.isAvailable()) return;
    set({ loading: true, error: undefined });
    try {
      const [sources, items] = await Promise.all([
        feedClient.listSources(),
        feedClient.listItems({ limit: 60 })
      ]);
      set({ sources, items, loaded: true });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  async loadItems() {
    if (!feedClient.isAvailable()) return;
    const items = await feedClient.listItems({ limit: 60 });
    set({ items });
  },

  async addSource(input) {
    const source = await feedClient.addSource(input);
    set((state) => ({
      sources: [source, ...state.sources.filter((entry) => entry.id !== source.id)]
    }));
    return source;
  },

  async updateSource(input) {
    const source = await feedClient.updateSource(input);
    if (source) {
      set((state) => ({
        sources: state.sources.map((entry) =>
          entry.id === source.id ? source : entry
        )
      }));
    }
    return source;
  },

  async deleteSource(id) {
    const ok = await feedClient.deleteSource(id);
    if (ok) {
      set((state) => ({
        sources: state.sources.filter((entry) => entry.id !== id),
        items: state.items.filter((entry) => entry.sourceId !== id)
      }));
    }
    return ok;
  },

  async refreshSource(id) {
    set({ refreshing: true, error: undefined });
    try {
      const result = await feedClient.refreshSource(id);
      const [sources, items] = await Promise.all([
        feedClient.listSources(),
        feedClient.listItems({ limit: 60 })
      ]);
      set({ sources, items });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      return { sourceId: id, ok: false, added: 0, updated: 0, error: message };
    } finally {
      set({ refreshing: false });
    }
  },

  async refreshAll() {
    set({ refreshing: true, error: undefined });
    try {
      const results = await feedClient.refreshAll();
      const [sources, items] = await Promise.all([
        feedClient.listSources(),
        feedClient.listItems({ limit: 60 })
      ]);
      set({ sources, items });
      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      return [];
    } finally {
      set({ refreshing: false });
    }
  },

  async markInterpreted(id) {
    const item = await feedClient.markInterpreted(id);
    if (!item) return;
    set((state) => ({
      items: state.items.map((entry) => (entry.id === id ? item : entry))
    }));
    void get().loadItems().catch(() => {
      // best-effort refresh only
    });
  }
}));

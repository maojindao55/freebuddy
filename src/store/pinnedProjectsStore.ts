import { create } from "zustand";

const STORAGE_KEY = "freebuddy.projects.pinned.v1";

function loadPinnedKeys(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string" && key.length > 0);
  } catch {
    return [];
  }
}

function persistPinnedKeys(keys: string[]) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Pin state is progressive enhancement.
  }
}

interface PinnedProjectsState {
  pinnedKeys: string[];
  isPinned(key: string): boolean;
  pin(key: string): void;
  unpin(key: string): void;
  toggle(key: string): void;
}

export const usePinnedProjectsStore = create<PinnedProjectsState>((set, get) => ({
  pinnedKeys: loadPinnedKeys(),

  isPinned(key) {
    return get().pinnedKeys.includes(key);
  },

  pin(key) {
    set((state) => {
      if (state.pinnedKeys.includes(key)) return state;
      const pinnedKeys = [key, ...state.pinnedKeys];
      persistPinnedKeys(pinnedKeys);
      return { pinnedKeys };
    });
  },

  unpin(key) {
    set((state) => {
      if (!state.pinnedKeys.includes(key)) return state;
      const pinnedKeys = state.pinnedKeys.filter((entry) => entry !== key);
      persistPinnedKeys(pinnedKeys);
      return { pinnedKeys };
    });
  },

  toggle(key) {
    if (get().isPinned(key)) get().unpin(key);
    else get().pin(key);
  }
}));

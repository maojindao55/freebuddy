import { create } from "zustand";

const KEY = "freebuddy.skills.recent.v1";
function readRecent(): string[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(id => typeof id === "string").slice(0, 20) : [];
  } catch { return []; }
}

export const useSkillUsageStore = create<{ recentIds: string[]; remember(id: string): void }>((set) => ({
  recentIds: readRecent(),
  remember(id) {
    set(state => {
      const recentIds = [id, ...state.recentIds.filter(entry => entry !== id)].slice(0, 20);
      try { globalThis.localStorage?.setItem(KEY, JSON.stringify(recentIds)); } catch { /* optional preference */ }
      return { recentIds };
    });
  }
}));

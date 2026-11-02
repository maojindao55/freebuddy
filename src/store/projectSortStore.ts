import { create } from "zustand";
import type { ProjectSortMode } from "@/components/CLI/conversationProjectGrouping";

const STORAGE_KEY = "freebuddy.projects.sort.v1";

interface ProjectSortPreference {
  mode: ProjectSortMode;
  fixedOrder: string[];
}

interface ProjectSortState {
  preferences: Record<string, ProjectSortPreference>;
  setMode(username: string | undefined, mode: ProjectSortMode, projectKeys: string[]): void;
  rememberProjects(username: string | undefined, projectKeys: string[]): void;
}

const DEFAULT_PREFERENCE: ProjectSortPreference = { mode: "activity", fixedOrder: [] };
const userKey = (username: string | undefined) => username ? `user:${username}` : "local";

function uniqueKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0))]
    : [];
}

function loadPreferences(): ProjectSortState["preferences"] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (!value || typeof value !== "object" ||
          (value.mode !== "activity" && value.mode !== "fixed")) return [];
      return [[key, { mode: value.mode, fixedOrder: uniqueKeys(value.fixedOrder) }]];
    }));
  } catch {
    return {};
  }
}

function persistPreferences(preferences: ProjectSortState["preferences"]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Keep the preference usable for this session if storage is unavailable.
  }
}

export function projectSortPreferenceForUser(
  state: Pick<ProjectSortState, "preferences">,
  username: string | undefined
): ProjectSortPreference {
  return state.preferences[userKey(username)] ?? DEFAULT_PREFERENCE;
}

export const useProjectSortStore = create<ProjectSortState>((set) => ({
  preferences: loadPreferences(),

  setMode(username, mode, projectKeys) {
    set((state) => {
      const current = projectSortPreferenceForUser(state, username);
      if (current.mode === mode) return state;
      const preferences = {
        ...state.preferences,
        [userKey(username)]: {
          mode,
          fixedOrder: mode === "fixed" ? uniqueKeys(projectKeys) : current.fixedOrder
        }
      };
      persistPreferences(preferences);
      return { preferences };
    });
  },

  // Call only with the full, successfully loaded project list, before UI filtering.
  rememberProjects(username, projectKeys) {
    set((state) => {
      const current = projectSortPreferenceForUser(state, username);
      if (current.mode !== "fixed") return state;
      const available = new Set(projectKeys);
      const fixedOrder = uniqueKeys([
        ...current.fixedOrder.filter((key) => available.has(key)),
        ...projectKeys
      ]);
      if (fixedOrder.length === current.fixedOrder.length &&
          fixedOrder.every((key, index) => key === current.fixedOrder[index])) return state;
      const preferences = {
        ...state.preferences,
        [userKey(username)]: { ...current, fixedOrder }
      };
      persistPreferences(preferences);
      return { preferences };
    });
  }
}));

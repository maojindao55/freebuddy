import { create } from "zustand";

export type ConversationPanelFilter = "all" | "running" | "attention" | "unread";
export type ConversationPreferredView = "list" | "panel";
const STORAGE_KEY = "freebuddy.conversations.view.v1";

function loadPreferredView(): ConversationPreferredView {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "panel" ? "panel" : "list";
  } catch {
    return "list";
  }
}

interface ConversationPanelUiState {
  preferredView: ConversationPreferredView;
  query: string;
  filter: ConversationPanelFilter;
  projectKey: string;
  scrollOffset: number;
  visibleCount: number;
  orderedIds: string[];
  setPreferredView(view: ConversationPreferredView): void;
  setQuery(query: string): void;
  setFilter(filter: ConversationPanelFilter): void;
  setProjectKey(projectKey: string): void;
  setScrollOffset(scrollOffset: number): void;
  showMore(): void;
  setOrderedIds(orderedIds: string[]): void;
}

/** Navigation through a card never changes the user's explicit view preference. */
export const useConversationPanelUiStore = create<ConversationPanelUiState>((set) => ({
  preferredView: loadPreferredView(),
  query: "",
  filter: "all",
  projectKey: "",
  scrollOffset: 0,
  visibleCount: 24,
  orderedIds: [],
  setPreferredView(preferredView) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, preferredView);
    } catch {
      // The view remains usable when storage is unavailable.
    }
    set({ preferredView });
  },
  setQuery(query) { set({ query, scrollOffset: 0, visibleCount: 24 }); },
  setFilter(filter) { set({ filter, scrollOffset: 0, visibleCount: 24 }); },
  setProjectKey(projectKey) { set({ projectKey, scrollOffset: 0, visibleCount: 24 }); },
  setScrollOffset(scrollOffset) { set({ scrollOffset: Math.max(0, scrollOffset) }); },
  showMore() { set((state) => ({ visibleCount: state.visibleCount + 24 })); },
  setOrderedIds(orderedIds) { set({ orderedIds }); }
}));

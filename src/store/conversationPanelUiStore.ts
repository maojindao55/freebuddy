import { create, type StoreApi } from "zustand";

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

export interface ConversationBoardFilterUiState {
  query: string;
  filter: ConversationPanelFilter;
  projectKey: string;
  scrollOffset: number;
  visibleCount: number;
  orderedIds: string[];
  setQuery(query: string): void;
  setFilter(filter: ConversationPanelFilter): void;
  setProjectKey(projectKey: string): void;
  setScrollOffset(scrollOffset: number): void;
  showMore(): void;
  setOrderedIds(orderedIds: string[]): void;
}

interface ConversationPanelUiState extends ConversationBoardFilterUiState {
  preferredView: ConversationPreferredView;
  setPreferredView(view: ConversationPreferredView): void;
}

function createBoardFilterUiSlice<T extends ConversationBoardFilterUiState>(
  set: StoreApi<T>["setState"]
): ConversationBoardFilterUiState {
  return {
    query: "",
    filter: "all",
    projectKey: "",
    scrollOffset: 0,
    visibleCount: 24,
    orderedIds: [],
    setQuery(query) { set({ query, scrollOffset: 0, visibleCount: 24 } as Partial<T>); },
    setFilter(filter) { set({ filter, scrollOffset: 0, visibleCount: 24 } as Partial<T>); },
    setProjectKey(projectKey) { set({ projectKey, scrollOffset: 0, visibleCount: 24 } as Partial<T>); },
    setScrollOffset(scrollOffset) { set({ scrollOffset: Math.max(0, scrollOffset) } as Partial<T>); },
    showMore() { set((state) => ({ visibleCount: state.visibleCount + 24 }) as Partial<T>); },
    setOrderedIds(orderedIds) { set({ orderedIds } as Partial<T>); }
  };
}

/** Navigation through a card never changes the user's explicit view preference. */
export const useConversationPanelUiStore = create<ConversationPanelUiState>((set) => ({
  preferredView: loadPreferredView(),
  setPreferredView(preferredView) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, preferredView);
    } catch {
      // The view remains usable when storage is unavailable.
    }
    set({ preferredView });
  },
  ...createBoardFilterUiSlice(set)
}));

/** Independent filter/scroll state for the Todos board view. */
export const useTodoPanelUiStore = create<ConversationBoardFilterUiState>((set) =>
  createBoardFilterUiSlice(set)
);

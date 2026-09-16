/**
 * Conversation list cache with bounded cursor pagination.
 *
 * Rules that matter:
 * - items are capped (`MAX_CONVERSATION_ITEMS`); the list cannot grow without bound during a
 *   long session, and exceeding the cap is visible through `truncated`;
 * - every fetch carries a monotonically increasing `fetchSeq`; a page that arrives after a newer
 *   fetch started is **dropped**, so tapping "load more" twice cannot interleave pages;
 * - individual entities merge through `updatedAt`, so an old page can never overwrite a newer
 *   `conversation.updated` event that arrived while the request was in flight.
 */

import type { ConversationSummary, RemoteId, RemotePageResult } from "../protocol/remote.generated";
import { capTail, createStore, type Store } from "./createStore";
import { isNewerTimestamp } from "../utils/order";

export const MAX_CONVERSATION_ITEMS = 200;

export interface ConversationListState {
  readonly items: readonly ConversationSummary[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly fetchSeq: number;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly loaded: boolean;
  /** Redacted, user-facing error text for the last failed fetch. */
  readonly error: string | null;
  readonly truncated: boolean;
}

export interface ConversationStore extends Store<ConversationListState> {
  beginFetch(refresh: boolean): number;
  applyPage(fetchSeq: number, page: RemotePageResult<ConversationSummary>, refresh: boolean): void;
  fail(fetchSeq: number, message: string): void;
  upsert(summary: ConversationSummary): void;
  remove(conversationId: RemoteId): void;
  replaceFromSnapshot(items: readonly ConversationSummary[]): void;
  reset(): void;
}

function initialState(): ConversationListState {
  return {
    items: [],
    cursor: null,
    hasMore: false,
    fetchSeq: 0,
    loading: false,
    refreshing: false,
    loaded: false,
    error: null,
    truncated: false
  };
}

export function createConversationStore(): ConversationStore {
  const store = createStore<ConversationListState>(initialState());

  return {
    getState: store.getState,
    setState: store.setState,
    subscribe: store.subscribe,

    beginFetch(refresh) {
      const fetchSeq = store.getState().fetchSeq + 1;
      store.setState((previous) => ({
        ...previous,
        fetchSeq,
        loading: true,
        refreshing: refresh,
        error: null
      }));
      return fetchSeq;
    },

    applyPage(fetchSeq, page, refresh) {
      const state = store.getState();
      if (fetchSeq !== state.fetchSeq) {
        // A newer fetch already started: this page is stale by definition.
        return;
      }
      const baseItems = refresh ? [] : state.items;
      const incoming = Array.isArray(page.items) ? page.items : [];
      const merged = [...baseItems];

      for (const candidate of incoming) {
        const index = merged.findIndex((item) => item.conversationId === candidate.conversationId);
        if (index === -1) {
          merged.push(candidate);
          continue;
        }
        if (isNewerTimestamp(candidate.updatedAt, merged[index].updatedAt)) {
          merged[index] = candidate;
        }
      }

      const nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      const capped = capTail(merged, MAX_CONVERSATION_ITEMS);

      store.setState((previous) => ({
        ...previous,
        items: capped,
        cursor: nextCursor,
        hasMore: nextCursor !== null,
        loading: false,
        refreshing: false,
        loaded: true,
        error: null,
        truncated: capped.length < merged.length
      }));
    },

    fail(fetchSeq, message) {
      if (fetchSeq !== store.getState().fetchSeq) {
        return;
      }
      store.setState((previous) => ({
        ...previous,
        loading: false,
        refreshing: false,
        error: message
      }));
    },

    upsert(summary) {
      store.setState((previous) => {
        const index = previous.items.findIndex((item) => item.conversationId === summary.conversationId);
        if (index === -1) {
          const merged = [summary, ...previous.items];
          const capped = capTail(merged, MAX_CONVERSATION_ITEMS);
          return {
            ...previous,
            items: capped,
            truncated: capped.length < merged.length
          };
        }
        if (!isNewerTimestamp(summary.updatedAt, previous.items[index].updatedAt)) {
          return previous;
        }
        const items = [...previous.items];
        items[index] = summary;
        return { ...previous, items };
      });
    },

    remove(conversationId) {
      store.setState((previous) => ({
        ...previous,
        items: previous.items.filter((item) => item.conversationId !== conversationId)
      }));
    },

    replaceFromSnapshot(items) {
      const capped = capTail(items, MAX_CONVERSATION_ITEMS);
      store.setState((previous) => ({
        ...previous,
        items: capped,
        cursor: null,
        hasMore: false,
        loading: false,
        refreshing: false,
        loaded: true,
        error: null,
        truncated: capped.length < items.length
      }));
    },

    reset() {
      store.setState(() => initialState());
    }
  };
}

let singleton: ConversationStore | null = null;

export function getConversationStore(): ConversationStore {
  if (!singleton) {
    singleton = createConversationStore();
  }
  return singleton;
}

export function resetConversationStore(): void {
  singleton = null;
}

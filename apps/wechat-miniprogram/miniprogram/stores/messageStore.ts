/**
 * Per-conversation message cache.
 *
 * Bounded in two dimensions: messages per thread (the newest window is kept, older ones are
 * reported as `truncated` rather than silently disappearing) and threads per session (least
 * recently used first), so browsing many conversations cannot grow memory forever.
 *
 * Message pages are appended or replaced according to how they were requested, and duplicates
 * never double-render. `message.created` / `message.updated` events merge by `messageId`, which
 * also means a late page cannot resurrect deleted styling of an already known message.
 *
 * A live event is always newer than a read: `message.updated` replaces unconditionally, while a
 * page only replaces a message it already holds when `createdAt` proves it is strictly newer
 * (which, for an existing message, it never is). So a slow page cannot roll back content a stream
 * already delivered.
 */

import type { MessageSummary, RemoteId, RemotePageResult } from "../protocol/remote.generated";
import { createStore, type Store } from "./createStore";
import { compareMessagesByCreation, isNewerTimestamp } from "../utils/order";

export const MAX_MESSAGES_PER_THREAD = 200;
export const MAX_THREADS = 12;

export interface MessageThreadState {
  readonly conversationId: RemoteId;
  readonly items: readonly MessageSummary[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly fetchSeq: number;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly loadedOlder: boolean;
  readonly error: string | null;
  readonly truncated: boolean;
}

export interface MessageStoreState {
  readonly threads: Readonly<Record<string, MessageThreadState>>;
  /** Most recently used first. Drives thread eviction. */
  readonly order: readonly RemoteId[];
}

export interface MessageStore extends Store<MessageStoreState> {
  thread(conversationId: RemoteId): MessageThreadState;
  beginFetch(conversationId: RemoteId, refresh: boolean): number;
  applyPage(
    conversationId: RemoteId,
    fetchSeq: number,
    page: RemotePageResult<MessageSummary>,
    refresh: boolean
  ): void;
  fail(conversationId: RemoteId, fetchSeq: number, message: string): void;
  upsert(message: MessageSummary): void;
  clearThread(conversationId: RemoteId): void;
  /** Drops every thread that is not in `conversationIds`; a snapshot owns the full list. */
  retainOnly(conversationIds: readonly RemoteId[]): void;
  reset(): void;
}

function createThread(conversationId: RemoteId): MessageThreadState {
  return {
    conversationId,
    items: [],
    cursor: null,
    hasMore: false,
    fetchSeq: 0,
    loading: false,
    loaded: false,
    loadedOlder: false,
    error: null,
    truncated: false
  };
}

function initialState(): MessageStoreState {
  return { threads: {}, order: [] };
}

function sortMessages(items: readonly MessageSummary[]): readonly MessageSummary[] {
  return [...items].sort(compareMessagesByCreation);
}

export function createMessageStore(): MessageStore {
  const store = createStore<MessageStoreState>(initialState());

  function touch(conversationId: RemoteId): readonly RemoteId[] {
    const order = [conversationId, ...store.getState().order.filter((id) => id !== conversationId)];
    return order.slice(0, MAX_THREADS);
  }

  function writeThread(conversationId: RemoteId, patch: Partial<MessageThreadState>): void {
    store.setState((previous) => {
      const current = previous.threads[conversationId] ?? createThread(conversationId);
      const threads = { ...previous.threads, [conversationId]: { ...current, ...patch } };
      const order = touch(conversationId);

      const overflow = Object.keys(threads).filter((id) => !order.includes(id));
      for (const id of overflow) {
        delete threads[id];
      }
      return { threads, order };
    });
  }

  return {
    getState: store.getState,
    setState: store.setState,
    subscribe: store.subscribe,

    thread(conversationId) {
      return store.getState().threads[conversationId] ?? createThread(conversationId);
    },

    beginFetch(conversationId, refresh) {
      const current = store.getState().threads[conversationId] ?? createThread(conversationId);
      const fetchSeq = current.fetchSeq + 1;
      writeThread(conversationId, {
        // A refresh re-reads the newest window, so older-history paging starts over.
        ...(refresh ? { cursor: null, hasMore: false, loadedOlder: false } : {}),
        fetchSeq,
        loading: true,
        error: null
      });
      return fetchSeq;
    },

    applyPage(conversationId, fetchSeq, page, refresh) {
      const current = store.getState().threads[conversationId] ?? createThread(conversationId);
      if (fetchSeq !== current.fetchSeq) {
        return;
      }
      const incoming = Array.isArray(page.items) ? page.items : [];
      const base = refresh ? [] : current.items;
      const merged = [...base];
      for (const candidate of incoming) {
        const index = merged.findIndex((item) => item.messageId === candidate.messageId);
        if (index === -1) {
          merged.push(candidate);
        } else if (isNewerTimestamp(candidate.createdAt, merged[index].createdAt)) {
          // A message we already hold came back from a page. `message.updated` is the live,
          // authoritative channel and `createdAt` never changes for an existing message, so the
          // page must not roll the cached one back — that is exactly the "stale page wins" bug.
          merged[index] = candidate;
        }
      }
      const sorted = sortMessages(merged);
      // Keep the newest window: the host pages older history through cursors.
      const windowed = sorted.length > MAX_MESSAGES_PER_THREAD ? sorted.slice(sorted.length - MAX_MESSAGES_PER_THREAD) : sorted;
      const nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : null;

      writeThread(conversationId, {
        items: windowed,
        cursor: nextCursor,
        hasMore: nextCursor !== null,
        loading: false,
        loaded: true,
        loadedOlder: !refresh,
        error: null,
        truncated: windowed.length < merged.length
      });
    },

    fail(conversationId, fetchSeq, message) {
      const current = store.getState().threads[conversationId] ?? createThread(conversationId);
      if (fetchSeq !== current.fetchSeq) {
        return;
      }
      writeThread(conversationId, { loading: false, error: message });
    },

    upsert(message) {
      const current = store.getState().threads[message.conversationId] ?? createThread(message.conversationId);
      const index = current.items.findIndex((item) => item.messageId === message.messageId);
      const merged = index === -1 ? [...current.items, message] : current.items.map((item, i) => (i === index ? message : item));
      const sorted = sortMessages(merged);
      const windowed = sorted.length > MAX_MESSAGES_PER_THREAD ? sorted.slice(sorted.length - MAX_MESSAGES_PER_THREAD) : sorted;
      writeThread(message.conversationId, {
        items: windowed,
        truncated: windowed.length < merged.length
      });
    },

    clearThread(conversationId) {
      store.setState((previous) => {
        if (!previous.threads[conversationId]) {
          return previous;
        }
        const threads = { ...previous.threads };
        delete threads[conversationId];
        return { threads, order: previous.order.filter((id) => id !== conversationId) };
      });
    },

    retainOnly(conversationIds) {
      const keep = new Set(conversationIds);
      store.setState((previous) => {
        const threads: Record<string, MessageThreadState> = {};
        for (const [id, thread] of Object.entries(previous.threads)) {
          if (keep.has(id)) {
            threads[id] = thread;
          }
        }
        if (Object.keys(threads).length === Object.keys(previous.threads).length) {
          return previous;
        }
        return { threads, order: previous.order.filter((id) => keep.has(id)) };
      });
    },

    reset() {
      store.setState(() => initialState());
    }
  };
}

let singleton: MessageStore | null = null;

export function getMessageStore(): MessageStore {
  if (!singleton) {
    singleton = createMessageStore();
  }
  return singleton;
}

export function resetMessageStore(): void {
  singleton = null;
}

/**
 * Minimal observable store.
 *
 * Stores are App-scoped caches of server state, never a source of truth. Subscribers are
 * notified synchronously after a state replacement; notifications are best-effort (a throwing
 * subscriber cannot corrupt another one).
 */

export interface Store<T> {
  getState(): T;
  setState(updater: (previous: T) => T): void;
  subscribe(listener: (state: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<(state: T) => void>();

  return {
    getState() {
      return state;
    },

    setState(updater) {
      const next = updater(state);
      if (next === state) {
        return;
      }
      state = next;
      for (const listener of [...listeners]) {
        try {
          listener(state);
        } catch {
          // A broken subscriber must not break the store or its peers.
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/** Keeps the newest `max` entries of a list, preserving order. */
export function capTail<T>(items: readonly T[], max: number): readonly T[] {
  return items.length > max ? items.slice(0, max) : items;
}

/** Keeps the oldest `max` entries of a list, preserving order. */
export function capHead<T>(items: readonly T[], max: number): readonly T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

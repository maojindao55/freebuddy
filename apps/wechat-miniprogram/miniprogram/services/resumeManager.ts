/**
 * Event sequence tracking, gap detection and snapshot fallback.
 *
 * The host owns the authoritative per-admin sequence. This client only remembers what it
 * applied, so a resumed connection asks for everything after `lastSeq`:
 *
 * - `seq === lastSeq` (or older, down to the snapshot baseline) is a duplicate: idempotently
 *   ignored, never re-applied;
 * - `seq === lastSeq + 1` is the next event and is applied;
 * - a larger `seq` means events were missed: nothing further is applied until a snapshot
 *   arrives, because applying a hole would silently corrupt the view;
 * - `seq` below the snapshot baseline means the host's sequence went *backwards* (the host
 *   restarted, or a cursor from another host generation was restored): stale, snapshot required;
 * - a snapshot is authoritative: recording it replaces the cursor atomically (`baseSeq`), and
 *   later events must continue above that base.
 *
 * **A cursor is only usable together with the state it describes.** `materialized` records that
 * this process still holds the authoritative entities for the host (i.e. a snapshot was applied
 * since the process started). A persisted cursor therefore never authorises a resume on its own:
 * after a cold start the entity cache is empty, so `resumeFrom` answers `null` and the client
 * takes the full snapshot instead of resuming with a cursor it cannot back up with entities.
 *
 * State lives per host and is owned by the App, not by a page, so navigating between pages can
 * never reset recovery.
 */

import {
  MAX_PERSISTED_HOSTS,
  type ResumeCursorMap,
  type ResumeCursorStorage
} from "./resumeCursorStorage";

export type EventObservation =
  | { readonly kind: "applied"; readonly hostId: string; readonly seq: number }
  | { readonly kind: "duplicate"; readonly hostId: string; readonly seq: number }
  | { readonly kind: "gap"; readonly hostId: string; readonly expected: number; readonly received: number }
  | { readonly kind: "awaiting_snapshot"; readonly hostId: string; readonly seq: number }
  /** Older than the snapshot baseline: the host sequence regressed, so the cache is untrustworthy. */
  | { readonly kind: "stale"; readonly hostId: string; readonly seq: number }
  /** No snapshot applied for this host yet: there is nothing to apply an event *onto*. */
  | { readonly kind: "unprimed"; readonly hostId: string; readonly seq: number }
  | { readonly kind: "invalid"; readonly hostId: string };

export interface HostResumeState {
  readonly hostId: string;
  readonly baseSeq: number | null;
  readonly lastSeq: number | null;
  /** True while this process holds the entities that `lastSeq` describes. */
  readonly materialized: boolean;
  readonly awaitingSnapshot: boolean;
  readonly duplicateCount: number;
  readonly gapCount: number;
  readonly staleCount: number;
  readonly unprimedCount: number;
  readonly snapshotCount: number;
}

export interface ResumeManagerOptions {
  /** Optional cursor persistence. Nothing is written when omitted. */
  readonly storage?: ResumeCursorStorage;
}

export interface ResumeManager {
  observe(hostId: string, seq: unknown): EventObservation;
  applySnapshot(hostId: string, baseSeq: unknown): boolean;
  /** The entity cache for this host was dropped: the cursor alone may no longer be used. */
  dematerialize(hostId: string): void;
  /** Cursor to resume from, or `null` when a full snapshot is required. */
  resumeFrom(hostId: string): number | null;
  needsSnapshot(hostId: string): boolean;
  state(hostId: string): HostResumeState;
  states(): readonly HostResumeState[];
  /** Persists the current cursors. Called at snapshot boundaries and on lifecycle pauses. */
  flush(): void;
  reset(hostId?: string): void;
}

interface MutableHostState {
  baseSeq: number | null;
  lastSeq: number | null;
  materialized: boolean;
  awaitingSnapshot: boolean;
  duplicateCount: number;
  gapCount: number;
  staleCount: number;
  unprimedCount: number;
  snapshotCount: number;
}

function isValidSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createResumeManager(options: ResumeManagerOptions = {}): ResumeManager {
  const storage = options.storage;
  const byHost = new Map<string, MutableHostState>();

  // Persisted cursors are loaded *without* the entities they describe, so `materialized` stays
  // false until a snapshot is applied in this process.
  const persisted = storage?.read() ?? null;
  if (persisted !== null) {
    for (const [hostId, record] of Object.entries(persisted)) {
      byHost.set(hostId, {
        baseSeq: record.baseSeq,
        lastSeq: record.lastSeq,
        materialized: false,
        awaitingSnapshot: false,
        duplicateCount: 0,
        gapCount: 0,
        staleCount: 0,
        unprimedCount: 0,
        snapshotCount: 0
      });
    }
  }

  function ensure(hostId: string): MutableHostState {
    let state = byHost.get(hostId);
    if (!state) {
      state = {
        baseSeq: null,
        lastSeq: null,
        materialized: false,
        awaitingSnapshot: false,
        duplicateCount: 0,
        gapCount: 0,
        staleCount: 0,
        unprimedCount: 0,
        snapshotCount: 0
      };
      byHost.set(hostId, state);
    }
    return state;
  }

  function cursorMap(): ResumeCursorMap {
    const map: Record<string, { baseSeq: number | null; lastSeq: number | null }> = {};
    // Most recently used cursors are the useful ones; the cap only matters if a session touched
    // many hosts.
    for (const hostId of [...byHost.keys()].slice(-MAX_PERSISTED_HOSTS)) {
      const state = byHost.get(hostId) as MutableHostState;
      map[hostId] = { baseSeq: state.baseSeq, lastSeq: state.lastSeq };
    }
    return map;
  }

  function flush(): void {
    if (!storage) {
      return;
    }
    if (byHost.size === 0) {
      storage.clear();
      return;
    }
    storage.write(cursorMap());
  }

  return {
    observe(hostId, seq) {
      if (!isValidSeq(seq)) {
        return { kind: "invalid", hostId };
      }
      const state = ensure(hostId);

      if (state.awaitingSnapshot) {
        return { kind: "awaiting_snapshot", hostId, seq };
      }
      if (!state.materialized || state.baseSeq === null || state.lastSeq === null) {
        // Cold start, or a cache that was dropped: applying this event would create a hole the
        // cursor cannot describe, so the caller must take the snapshot instead.
        state.unprimedCount += 1;
        return { kind: "unprimed", hostId, seq };
      }
      if (seq < state.baseSeq) {
        // Below the snapshot baseline: the host's sequence is behind our own, so its events
        // cannot be appended to what we hold.
        state.staleCount += 1;
        state.awaitingSnapshot = true;
        return { kind: "stale", hostId, seq };
      }
      if (seq <= state.lastSeq) {
        state.duplicateCount += 1;
        return { kind: "duplicate", hostId, seq };
      }
      if (seq === state.lastSeq + 1) {
        state.lastSeq = seq;
        return { kind: "applied", hostId, seq };
      }
      state.gapCount += 1;
      state.awaitingSnapshot = true;
      return { kind: "gap", hostId, expected: state.lastSeq + 1, received: seq };
    },

    applySnapshot(hostId, baseSeq) {
      if (!isValidSeq(baseSeq)) {
        return false;
      }
      const state = ensure(hostId);
      state.baseSeq = baseSeq;
      state.lastSeq = baseSeq;
      state.materialized = true;
      state.awaitingSnapshot = false;
      state.snapshotCount += 1;
      // A snapshot is an authoritative checkpoint: persisting here is what makes the next
      // in-session resume possible and keeps the stored cursor consistent with a real baseline.
      flush();
      return true;
    },

    dematerialize(hostId) {
      const state = byHost.get(hostId);
      if (!state) {
        return;
      }
      // Keep the numbers for diagnostics, but they may no longer authorise a resume.
      state.materialized = false;
    },

    resumeFrom(hostId) {
      const state = byHost.get(hostId);
      if (!state || !state.materialized || state.awaitingSnapshot || state.lastSeq === null) {
        return null;
      }
      return state.lastSeq;
    },

    needsSnapshot(hostId) {
      const state = byHost.get(hostId);
      if (!state) {
        // Unknown host: the first contact must be a snapshot, never a resume.
        return true;
      }
      return !state.materialized || state.awaitingSnapshot || state.lastSeq === null;
    },

    state(hostId) {
      const state = ensure(hostId);
      return {
        hostId,
        baseSeq: state.baseSeq,
        lastSeq: state.lastSeq,
        materialized: state.materialized,
        awaitingSnapshot: state.awaitingSnapshot,
        duplicateCount: state.duplicateCount,
        gapCount: state.gapCount,
        staleCount: state.staleCount,
        unprimedCount: state.unprimedCount,
        snapshotCount: state.snapshotCount
      };
    },

    states() {
      return [...byHost.keys()].map((hostId) => this.state(hostId));
    },

    flush,

    reset(hostId) {
      if (hostId === undefined) {
        byHost.clear();
        storage?.clear();
        return;
      }
      byHost.delete(hostId);
      flush();
    }
  };
}

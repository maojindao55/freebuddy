/**
 * Host mirror: status plus the entities a snapshot owns.
 *
 * A snapshot is the authoritative whole. Applying it therefore replaces *everything* in one
 * state transition — a page can never observe a half-applied snapshot (old host with new
 * conversations, for example). Incremental events, by contrast, touch a single entity and are
 * rejected when they are older than what we already hold.
 */

import type {
  AgentSummary,
  DecisionSummary,
  HostStatus,
  ProjectSummary,
  RunSummary,
  SnapshotPayload,
  TaskSummary
} from "../protocol/remote.generated";
import { createStore, type Store } from "./createStore";
import { isNewerTimestamp } from "../utils/order";

export interface HostState {
  readonly host: HostStatus | null;
  readonly projects: readonly ProjectSummary[];
  readonly agents: readonly AgentSummary[];
  readonly activeRuns: readonly RunSummary[];
  readonly pendingDecisions: readonly DecisionSummary[];
  readonly activeTasks: readonly TaskSummary[];
  /** `baseSeq` of the last applied snapshot; the resume cursor continues above it. */
  readonly baseSeq: number | null;
  readonly updatedAtMs: number | null;
  readonly revision: number;
}

export interface HostStore extends Store<HostState> {
  replaceFromSnapshot(payload: SnapshotPayload, nowMs: number): void;
  setHostStatus(status: HostStatus, nowMs: number): boolean;
  clear(): void;
}

function initialState(): HostState {
  return {
    host: null,
    projects: [],
    agents: [],
    activeRuns: [],
    pendingDecisions: [],
    activeTasks: [],
    baseSeq: null,
    updatedAtMs: null,
    revision: 0
  };
}

export function createHostStore(): HostStore {
  const store = createStore<HostState>(initialState());

  return {
    getState: store.getState,
    setState: store.setState,
    subscribe: store.subscribe,

    replaceFromSnapshot(payload, nowMs) {
      store.setState((previous) => ({
        host: payload.host,
        projects: payload.projects ?? [],
        agents: payload.agents ?? [],
        activeRuns: payload.activeRuns ?? [],
        pendingDecisions: payload.pendingDecisions ?? [],
        activeTasks: payload.activeTasks ?? [],
        baseSeq: payload.baseSeq,
        updatedAtMs: nowMs,
        revision: previous.revision + 1
      }));
    },

    setHostStatus(status, nowMs) {
      const previousHost = store.getState().host;
      if (previousHost !== null && isNewerTimestamp(status.serverTime, previousHost.serverTime) === false) {
        return false;
      }
      store.setState((previous) => ({
        ...previous,
        host: status,
        updatedAtMs: nowMs,
        revision: previous.revision + 1
      }));
      return true;
    },

    clear() {
      store.setState(() => initialState());
    }
  };
}

let singleton: HostStore | null = null;

export function getHostStore(): HostStore {
  if (!singleton) {
    singleton = createHostStore();
  }
  return singleton;
}

export function resetHostStore(): void {
  singleton = null;
}

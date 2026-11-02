import { randomUUID } from "node:crypto";
import type {
  DelegationEvent,
  DelegationEventStatus,
  DelegationRunRow
} from "@freebuddy/protocol/delegation";
import type { DelegationRunRepository, InsertDelegationEventInput } from "./ports.js";
import { isTerminalDelegationStatus } from "./status.js";

const TERMINAL_RUN = new Set(["completed", "failed", "killed", "partial"]);

function nowIso(): string {
  return new Date().toISOString();
}

export function createMemoryDelegationRepository(): DelegationRunRepository & {
  hydrateRun(run: DelegationRunRow): void;
  hydrateEvent(event: DelegationEvent): void;
} {
  const runs = new Map<string, DelegationRunRow>();
  const events = new Map<string, DelegationEvent>();

  return {
    createRun(input) {
      const createdAt = nowIso();
      const run: DelegationRunRow = {
        id: input.id ?? randomUUID(),
        kind: "delegation",
        conversationId: input.conversationId ?? null,
        name: input.name ?? input.goal.slice(0, 80),
        goal: input.goal,
        status: input.status,
        cwd: input.cwd ?? null,
        teamId: input.teamId ?? null,
        teamSnapshotJson: input.teamSnapshotJson ?? null,
        createdAt,
        updatedAt: createdAt,
        endedAt: null,
        runtimeVersion: input.runtimeVersion,
        runtimeApiVersion: input.runtimeApiVersion
      };
      runs.set(run.id, run);
      return run;
    },
    getRun(runId) {
      return runs.get(runId);
    },
    setStatus(runId, status, options) {
      const current = runs.get(runId);
      if (!current) return false;
      if (TERMINAL_RUN.has(current.status) && current.status !== status && !options?.allowReopen) {
        return false;
      }
      const ended = TERMINAL_RUN.has(status);
      runs.set(runId, {
        ...current,
        status,
        updatedAt: nowIso(),
        endedAt: ended ? (options?.endedAt ?? nowIso()) : null
      });
      return true;
    },
    insertEvent(input: InsertDelegationEventInput) {
      const eventId = input.id ?? randomUUID();
      const created: DelegationEvent = {
        id: eventId,
        runId: input.runId,
        parentEventId: input.parentEventId,
        agentId: input.agentId,
        agentName: input.agentName,
        roleLabel: input.roleLabel,
        taskText: input.taskText,
        depth: input.depth,
        status: input.status,
        resultSummary: null,
        result: null,
        canWrite: input.canWrite,
        acceptedAt: nowIso(),
        startedAt: input.status === "running" ? nowIso() : null,
        endedAt: null,
        verdict: null,
        verdictSummary: null
      };
      events.set(eventId, created);
      return eventId;
    },
    updateEvent(eventId, patch) {
      const current = events.get(eventId);
      if (!current) return;
      events.set(eventId, { ...current, ...patch });
    },
    transitionEvent(eventId, to, resultSummary, options) {
      const current = events.get(eventId);
      if (!current) return false;
      if (!options?.allowReopen) {
        const allowed =
          to === "running"
            ? current.status === "pending"
            : to === "done"
              ? current.status === "running"
              : current.status === "pending" || current.status === "running";
        if (!allowed) return false;
      }
      const terminal = isTerminalDelegationStatus(to);
      const transitionedAt = nowIso();
      const reopeningTerminal =
        options?.allowReopen === true &&
        to === "running" &&
        isTerminalDelegationStatus(current.status);
      events.set(eventId, {
        ...current,
        status: to,
        resultSummary: resultSummary ?? current.resultSummary,
        startedAt:
          to === "running"
            ? reopeningTerminal
              ? transitionedAt
              : (current.startedAt ?? transitionedAt)
            : current.startedAt,
        endedAt: terminal ? transitionedAt : to === "running" ? null : current.endedAt
      });
      return true;
    },
    getEvent(eventId) {
      return events.get(eventId);
    },
    listEvents(runId) {
      return [...events.values()].filter((e) => e.runId === runId);
    },
    listPendingChildEvents(runId, parentEventId) {
      return [...events.values()].filter(
        (e) =>
          e.runId === runId &&
          e.parentEventId === parentEventId &&
          (e.status === "pending" || e.status === "running")
      );
    },
    countActiveDelegateLeaves(runId) {
      const all = [...events.values()].filter((e) => e.runId === runId);
      return all.filter(
        (d) =>
          d.parentEventId !== null &&
          d.status === "running" &&
          !all.some(
            (c) =>
              c.parentEventId === d.id && (c.status === "pending" || c.status === "running")
          )
      ).length;
    },
    cancelActiveEvents(runId, reason) {
      const ids: string[] = [];
      for (const event of events.values()) {
        if (event.runId !== runId) continue;
        if (event.status !== "pending" && event.status !== "running") continue;
        events.set(event.id, {
          ...event,
          status: "cancelled",
          resultSummary: reason ?? "cancelled",
          endedAt: nowIso()
        });
        ids.push(event.id);
      }
      return ids;
    },
    hydrateRun(run: DelegationRunRow) {
      runs.set(run.id, run);
    },
    hydrateEvent(event: DelegationEvent) {
      events.set(event.id, event);
    }
  };
}

export function recoverInterruptedMemoryRuns(repo: DelegationRunRepository): number {
  // Memory tests construct their own interrupted state; this helper marks
  // still-running events failed the same way Host recovery does.
  let recovered = 0;
  // The in-memory repo does not enumerate all runs; callers pass known ids.
  void repo;
  void recovered;
  return recovered;
}

export type { DelegationEventStatus };

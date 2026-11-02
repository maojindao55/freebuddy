import type { BusEffect, BusEvent, BusNode, BusState, ReduceResult } from "./types.js";

function cloneState(state: BusState): BusState {
  const nodes: Record<string, BusNode> = {};
  for (const [id, n] of Object.entries(state.nodes)) {
    nodes[id] = { ...n };
  }
  return { ...state, nodes };
}

function hasActiveChildren(state: BusState, parentId: string): boolean {
  return Object.values(state.nodes).some(
    (n) =>
      n.parentId === parentId &&
      (n.status === "turning" || n.status === "parked" || n.status === "idle")
  );
}

/**
 * Note: delegate child events are tracked as nodes with status turning/parked
 * while the underlying DB event is pending/running. The orchestrator syncs
 * node creation when a child is enqueued (idle→turning on start).
 *
 * For TurnEnded park decisions, "active children" means any non-terminal child.
 */
function hasNonTerminalChildren(state: BusState, parentId: string): boolean {
  return Object.values(state.nodes).some(
    (n) =>
      n.parentId === parentId &&
      n.status !== "done" &&
      n.status !== "failed" &&
      n.status !== "timeout" &&
      n.status !== "cancelled"
  );
}

export function createInitialBusState(opts: {
  runId: string;
  entryNodeId: string;
}): BusState {
  return {
    runId: opts.runId,
    runStatus: "running",
    entryNodeId: opts.entryNodeId,
    nodes: {
      [opts.entryNodeId]: {
        id: opts.entryNodeId,
        parentId: null,
        depth: 0,
        status: "idle",
        isEntry: true
      }
    }
  };
}

export function reduce(state: BusState, event: BusEvent): ReduceResult {
  const next = cloneState(state);
  const effects: BusEffect[] = [];

  switch (event.type) {
    case "TurnStarted": {
      const node = next.nodes[event.nodeId];
      if (!node) break;
      if (next.runStatus === "completed") next.runStatus = "running";
      node.status = "turning";
      break;
    }
    case "TurnEnded": {
      const node = next.nodes[event.nodeId];
      if (!node) break;
      if (next.runStatus === "killed") {
        node.status = "cancelled";
        effects.push({
          type: "MarkNodeTerminal",
          nodeId: node.id,
          status: "cancelled",
          summary: event.error ?? event.summary
        });
        break;
      }
      if (hasNonTerminalChildren(next, node.id)) {
        node.status = "parked";
        break;
      }
      if (event.error) {
        node.status = "failed";
        effects.push({
          type: "MarkNodeTerminal",
          nodeId: node.id,
          status: "failed",
          summary: event.error
        });
        if (node.isEntry) {
          next.runStatus = "failed";
          effects.push({ type: "MarkRunFailed", error: event.error });
        }
        break;
      }
      node.status = "done";
      effects.push({
        type: "MarkNodeTerminal",
        nodeId: node.id,
        status: "done",
        summary: event.summary
      });
      if (node.isEntry) {
        next.runStatus = "completed";
        effects.push({ type: "MarkRunCompleted", summary: event.summary });
      }
      break;
    }
    case "ChildSettled": {
      const child = next.nodes[event.childId];
      if (child) {
        if (event.childStatus === "timeout") child.status = "timeout";
        else if (event.childStatus === "failed") child.status = "failed";
        else if (event.childStatus === "cancelled") child.status = "cancelled";
        else child.status = "done";
      }
      const parent = next.nodes[event.parentId];
      if (parent?.status === "parked") {
        parent.status = "turning";
        effects.push({
          type: "SpawnWake",
          nodeId: parent.id,
          childId: event.childId,
          childStatus: event.childStatus,
          resultSummary: event.resultSummary,
          taskText: event.taskText,
          roleLabel: event.roleLabel,
          verdict: event.verdict,
          verdictSummary: event.verdictSummary
        });
      }
      break;
    }
    case "UserFollowUp": {
      // An explicit user follow-up resumes stopped runs too. Leaving the bus
      // killed would cancel the new turn at TurnEnded instead of parking it.
      if (next.runStatus === "completed" || next.runStatus === "failed" || next.runStatus === "killed") {
        next.runStatus = "running";
      }
      const entry = next.nodes[next.entryNodeId];
      if (entry) {
        entry.status = "turning";
      }
      effects.push({ type: "SpawnFollowUp", prompt: event.prompt });
      break;
    }
    case "RunKilled": {
      next.runStatus = "killed";
      for (const n of Object.values(next.nodes)) {
        if (
          n.status === "turning" ||
          n.status === "parked" ||
          n.status === "idle"
        ) {
          n.status = "cancelled";
        }
      }
      effects.push({ type: "MarkRunKilled" });
      break;
    }
    case "RunBlocked": {
      if (next.runStatus === "running") next.runStatus = "blocked";
      break;
    }
    case "RunUnblocked": {
      if (next.runStatus === "blocked") next.runStatus = "running";
      break;
    }
    default:
      break;
  }

  return { state: next, effects };
}

/** Ensure a child node exists in bus state (called when a delegate is enqueued). */
export function ensureChildNode(
  state: BusState,
  child: { id: string; parentId: string; depth: number }
): BusState {
  if (state.nodes[child.id]) return state;
  const next = cloneState(state);
  next.nodes[child.id] = {
    id: child.id,
    parentId: child.parentId,
    depth: child.depth,
    status: "idle",
    isEntry: false
  };
  return next;
}

export function markChildTurning(state: BusState, childId: string): BusState {
  const next = cloneState(state);
  const n = next.nodes[childId];
  if (n) n.status = "turning";
  return next;
}

// silence unused helper warning in some builds
void hasActiveChildren;

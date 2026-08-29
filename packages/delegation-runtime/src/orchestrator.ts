import type { DelegationEvent } from "@freebuddy/protocol/delegation";
import {
  buildDelegateWakePrompt,
  createInitialBusState,
  ensureChildNode,
  markChildTurning,
  reduce,
  resolveEffectiveWakeVerdict
} from "@freebuddy/delegation-core";
import type { DelegationRosterEntry, DelegationPolicy } from "@freebuddy/protocol/delegation";
import type { BusEffect, BusState } from "@freebuddy/delegation-core";
import type { DelegationRunRepository } from "./ports.js";
import { isTerminalDelegationStatus } from "./status.js";

export interface OrchestratorTurnResult {
  summary: string;
  error: string | null;
  /** False only when the executor positively observed no assistant text or artifact. */
  hasOutput?: boolean;
  /** Most useful tool/runtime detail to show when an otherwise empty turn is rejected. */
  diagnostic?: string | null;
}

export const EMPTY_DELEGATION_TURN_ERROR =
  "Agent ended without assistant text, an artifact, or an accepted delegation.";

export function resolveTurnCompletionError(
  turn: OrchestratorTurnResult,
  acceptedDelegation: boolean
): string | null {
  if (turn.error) return turn.error;
  if (turn.hasOutput === false && !acceptedDelegation) {
    return turn.diagnostic?.trim() || EMPTY_DELEGATION_TURN_ERROR;
  }
  return null;
}

export interface OrchestratorSpawnArgs {
  kind: "task" | "wake" | "followUp";
  nodeId: string;
  prompt: string;
  depth: number;
  selfAgentId: string;
  selfLabel: string;
}

/**
 * Per-run bus orchestrator: owns park/wake decisions via the pure FSM.
 * Persistence goes through the injected repository, never a Host SQL module.
 */
export class DelegationOrchestrator {
  private bus: BusState | null = null;
  private eventWaiters = new Map<string, Array<(e: DelegationEvent | undefined) => void>>();
  private killed = false;

  constructor(
    private readonly opts: {
      runId: string;
      roster: DelegationRosterEntry[];
      sharedInstructions?: string;
      policy: DelegationPolicy;
      entryRoleId: string;
      spawnTurn: (args: OrchestratorSpawnArgs) => Promise<OrchestratorTurnResult>;
      repository: DelegationRunRepository;
    }
  ) {}

  get state(): BusState | null {
    return this.bus;
  }

  syncTeamSnapshot(input: {
    roster: DelegationRosterEntry[];
    sharedInstructions?: string;
    policy: DelegationPolicy;
    entryRoleId: string;
  }): void {
    this.opts.roster = input.roster;
    this.opts.sharedInstructions = input.sharedInstructions;
    this.opts.policy = input.policy;
    this.opts.entryRoleId = input.entryRoleId;
  }

  bindEntry(entryNodeId: string): void {
    this.bus = createInitialBusState({
      runId: this.opts.runId,
      entryNodeId
    });
  }

  noteChildEnqueued(child: {
    childEventId: string;
    parentEventId: string;
    depth: number;
  }): void {
    if (!this.bus) return;
    this.bus = ensureChildNode(this.bus, {
      id: child.childEventId,
      parentId: child.parentEventId,
      depth: child.depth
    });
  }

  noteChildStarted(childEventId: string): void {
    if (!this.bus) return;
    this.bus = markChildTurning(this.bus, childEventId);
  }

  onEventSettled(eventId: string): void {
    const evt = this.opts.repository.getEvent(eventId);
    const waiters = this.eventWaiters.get(eventId);
    if (waiters) {
      this.eventWaiters.delete(eventId);
      for (const resolve of waiters) resolve(evt);
    }
    if (!this.bus || !evt?.parentEventId) return;
    const { state, effects } = reduce(this.bus, {
      type: "ChildSettled",
      parentId: evt.parentEventId,
      childId: eventId,
      childStatus: evt.status,
      resultSummary: evt.resultSummary ?? "",
      taskText: evt.taskText,
      roleLabel: evt.roleLabel,
      verdict: evt.verdict,
      verdictSummary: evt.verdictSummary
    });
    this.bus = state;
    this.applyEffects(effects.filter((e) => e.type !== "SpawnWake"));
  }

  awaitEventSettle(eventId: string): Promise<DelegationEvent | undefined> {
    const existing = this.opts.repository.getEvent(eventId);
    if (existing && isTerminalDelegationStatus(existing.status)) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const arr = this.eventWaiters.get(eventId) ?? [];
      arr.push(resolve);
      this.eventWaiters.set(eventId, arr);
    });
  }

  raceAnySettle(eventIds: string[]): Promise<DelegationEvent | undefined> {
    if (eventIds.length === 0) throw new Error("raceAnySettle: empty id list");
    if (eventIds.length === 1) return this.awaitEventSettle(eventIds[0]!);
    return Promise.race(eventIds.map((id) => this.awaitEventSettle(id)));
  }

  private applyEffects(effects: BusEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case "MarkRunCompleted":
          this.opts.repository.setStatus(this.opts.runId, "completed");
          break;
        case "MarkRunFailed":
          this.opts.repository.setStatus(this.opts.runId, "failed");
          break;
        case "MarkRunKilled":
          this.opts.repository.setStatus(this.opts.runId, "killed");
          break;
        case "MarkNodeTerminal":
          this.opts.repository.updateEvent(effect.nodeId, {
            status: effect.status,
            resultSummary: effect.summary
          });
          break;
        default:
          break;
      }
    }
  }

  markKilled(): void {
    this.killed = true;
    if (!this.bus) {
      this.opts.repository.setStatus(this.opts.runId, "killed");
      return;
    }
    const { state, effects } = reduce(this.bus, { type: "RunKilled" });
    this.bus = state;
    this.applyEffects(effects);
  }

  interruptLoops(): void {
    this.killed = true;
  }

  clearInterrupt(): void {
    this.killed = false;
  }

  async runNodeLoop(opts: {
    nodeId: string;
    depth: number;
    selfAgentId: string;
    selfLabel: string;
    initialPrompt: string;
    kind?: "task" | "followUp";
  }): Promise<OrchestratorTurnResult> {
    if (!this.bus) throw new Error("orchestrator not bound");
    let prompt = opts.initialPrompt;
    let lastError: string | null = null;
    let lastSummary = "";
    let kind: "task" | "wake" | "followUp" = opts.kind ?? "task";

    while (!this.killed) {
      {
        const { state, effects } = reduce(this.bus, {
          type: "TurnStarted",
          nodeId: opts.nodeId
        });
        this.bus = state;
        this.applyEffects(effects);
      }

      const childIdsBeforeTurn = new Set(
        this.opts.repository
          .listEvents(this.opts.runId)
          .filter((event) => event.parentEventId === opts.nodeId)
          .map((event) => event.id)
      );
      const turn = await this.opts.spawnTurn({
        kind,
        nodeId: opts.nodeId,
        prompt,
        depth: opts.depth,
        selfAgentId: opts.selfAgentId,
        selfLabel: opts.selfLabel
      });
      lastSummary = turn.summary ?? "";
      if (this.killed) break;

      const childrenAfterTurn = this.opts.repository
        .listEvents(this.opts.runId)
        .filter((event) => event.parentEventId === opts.nodeId);
      const acceptedDelegation = childrenAfterTurn.some(
        (event) => !childIdsBeforeTurn.has(event.id)
      );
      lastError = resolveTurnCompletionError(turn, acceptedDelegation);
      const pending = childrenAfterTurn.filter(
        (event) => event.status === "pending" || event.status === "running"
      );
      {
        const { state, effects } = reduce(this.bus, {
          type: "TurnEnded",
          nodeId: opts.nodeId,
          error: lastError,
          summary: lastSummary
        });
        this.bus = state;
        const parked = state.nodes[opts.nodeId]?.status === "parked";
        if (!parked) {
          this.applyEffects(effects);
          break;
        }
        this.applyEffects(effects.filter((e) => e.type !== "MarkRunCompleted"));
      }

      if (pending.length === 0) {
        const still = this.opts.repository.listPendingChildEvents(this.opts.runId, opts.nodeId);
        if (still.length === 0) {
          const { state, effects } = reduce(this.bus, {
            type: "TurnEnded",
            nodeId: opts.nodeId,
            error: lastError,
            summary: lastSummary
          });
          this.bus = state;
          this.applyEffects(effects);
          break;
        }
      }

      const settled = await this.raceAnySettle(
        (pending.length
          ? pending
          : this.opts.repository.listPendingChildEvents(this.opts.runId, opts.nodeId)
        ).map((e) => e.id)
      );
      if (this.killed) break;

      if (settled && this.bus) {
        const { state } = reduce(this.bus, {
          type: "ChildSettled",
          parentId: opts.nodeId,
          childId: settled.id,
          childStatus: settled.status,
          resultSummary: settled.resultSummary ?? "",
          taskText: settled.taskText,
          roleLabel: settled.roleLabel,
          verdict: settled.verdict,
          verdictSummary: settled.verdictSummary
        });
        this.bus = state;
      }

      prompt = buildDelegateWakePrompt(
        {
          taskText: settled?.taskText ?? "",
          roleLabel: settled?.roleLabel ?? "",
          status: settled?.status ?? "done",
          resultSummary: settled?.resultSummary ?? "",
          ...resolveEffectiveWakeVerdict(
            settled ?? {
              id: "",
              verdict: null,
              verdictSummary: null
            },
            this.opts.repository.listEvents(this.opts.runId)
          )
        },
        this.opts.roster,
        opts.selfAgentId,
        opts.depth,
        this.opts.policy.maxDepth,
        {
          sharedInstructions: this.opts.sharedInstructions,
          roleInstructions: this.opts.roster.find((role) => role.id === opts.selfAgentId)
            ?.instructions,
          selfLabel: opts.selfLabel
        }
      );
      kind = "wake";
    }

    return { summary: lastSummary, error: lastError };
  }

  async followUp(opts: {
    entryNodeId: string;
    entry: DelegationRosterEntry;
    prompt: string;
  }): Promise<OrchestratorTurnResult> {
    if (!this.bus) {
      this.bindEntry(opts.entryNodeId);
    }
    this.killed = false;
    const { state, effects } = reduce(this.bus!, {
      type: "UserFollowUp",
      prompt: opts.prompt
    });
    this.bus = state;
    this.applyEffects(effects.filter((e) => e.type !== "SpawnFollowUp"));
    this.opts.repository.setStatus(this.opts.runId, "running", { allowReopen: true });

    return this.runNodeLoop({
      nodeId: opts.entryNodeId,
      depth: 0,
      selfAgentId: opts.entry.id,
      selfLabel: opts.entry.label,
      initialPrompt: opts.prompt,
      kind: "followUp"
    });
  }
}

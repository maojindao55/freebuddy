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
import type { BusEffect, BusState, DelegateWakeInfo } from "@freebuddy/delegation-core";
import type { DelegationRunRepository } from "./ports.js";
import { isTerminalDelegationStatus } from "./status.js";

export interface OrchestratorTurnResult {
  summary: string;
  error: string | null;
  /** The node is still waiting for active delegates; callers must not finalize it. */
  parked?: boolean;
  /** False only when the executor positively observed no assistant text or artifact. */
  hasOutput?: boolean;
  /** Most useful tool/runtime detail to show when an otherwise empty turn is rejected. */
  diagnostic?: string | null;
}

export const EMPTY_DELEGATION_TURN_ERROR =
  "Agent ended without assistant text, an artifact, or an accepted delegation.";

export function resolveTurnCompletionError(
  turn: OrchestratorTurnResult,
  acceptedActiveDelegation: boolean
): string | null {
  if (turn.error) return turn.error;
  if (turn.hasOutput === false && !acceptedActiveDelegation) {
    return turn.diagnostic?.trim() || EMPTY_DELEGATION_TURN_ERROR;
  }
  return null;
}

export function classifyNewDelegationChildren(
  children: DelegationEvent[],
  childIdsBeforeTurn: ReadonlySet<string>
): { active: DelegationEvent[]; settled: DelegationEvent[] } {
  const active: DelegationEvent[] = [];
  const settled: DelegationEvent[] = [];
  for (const child of children) {
    if (childIdsBeforeTurn.has(child.id)) continue;
    if (child.status === "pending" || child.status === "running") active.push(child);
    else settled.push(child);
  }
  return { active, settled };
}

/** Build one wake payload even when several children settle within one parent turn. */
export function delegationWakeInfoForSettled(
  settled: DelegationEvent[]
): DelegateWakeInfo {
  const first = settled[0];
  if (!first) {
    throw new Error("delegationWakeInfoForSettled requires at least one event");
  }
  if (settled.length === 1) {
    return {
      taskText: first.taskText,
      roleLabel: first.roleLabel,
      status: first.status,
      resultSummary: first.resultSummary ?? "",
      verdict: first.verdict,
      verdictSummary: first.verdictSummary
    };
  }
  const failed = settled.find((event) => event.status !== "done");
  return {
    taskText: settled
      .map((event) => `[${event.status}] ${event.roleLabel}: ${event.taskText}`)
      .join("\n"),
    roleLabel: `${settled.length} delegates`,
    status: failed?.status ?? "done",
    resultSummary: settled
      .map(
        (event) =>
          `[${event.status}] ${event.roleLabel}: ${event.resultSummary?.trim() || "(no result summary)"}`
      )
      .join("\n"),
    verdict: null,
    verdictSummary: null
  };
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
  private eventWaiters = new Map<
    string,
    Set<(event: DelegationEvent | undefined) => void>
  >();
  private recoveryWakeDrives = new Map<string, Promise<void>>();
  private queuedFollowUps = new Map<string, string[]>();
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
    const hadWaiters = Boolean(waiters?.size);
    if (hadWaiters) {
      this.eventWaiters.delete(eventId);
      for (const resolve of [...waiters!]) resolve(evt);
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
    if (!hadWaiters) {
      for (const effect of effects) {
        if (effect.type === "SpawnWake") this.scheduleRecoveryWake(effect);
      }
    }
  }

  /**
   * Normal park/wake resumes through an in-memory event waiter. If that
   * volatile waiter disappears while the persisted parent is still parked,
   * the FSM's SpawnWake effect is the recovery path instead of dropping the
   * completed child notification.
   */
  private scheduleRecoveryWake(effect: Extract<BusEffect, { type: "SpawnWake" }>): void {
    if (this.recoveryWakeDrives.has(effect.nodeId) || this.killed) return;
    const node = this.bus?.nodes[effect.nodeId];
    const parent = this.opts.repository.getEvent(effect.nodeId);
    const child = this.opts.repository.getEvent(effect.childId);
    if (!node || !parent || !child) return;
    const role =
      this.opts.roster.find(
        (candidate) =>
          candidate.agentId === parent.agentId && candidate.label === parent.roleLabel
      ) ??
      this.opts.roster.find((candidate) => candidate.agentId === parent.agentId) ??
      this.opts.roster.find((candidate) => candidate.id === this.opts.entryRoleId) ??
      this.opts.roster[0];
    if (!role) return;

    const effective = resolveEffectiveWakeVerdict(
      child,
      this.opts.repository.listEvents(this.opts.runId)
    );
    const prompt = this.appendQueuedFollowUps(effect.nodeId, buildDelegateWakePrompt(
      {
        taskText: effect.taskText,
        roleLabel: effect.roleLabel,
        status: effect.childStatus,
        resultSummary: effect.resultSummary,
        verdict: effective.verdict,
        verdictSummary: effective.verdictSummary
      },
      this.opts.roster,
      role.id,
      node.depth,
      this.opts.policy.maxDepth,
      {
        sharedInstructions: this.opts.sharedInstructions,
        roleInstructions: role.instructions,
        selfLabel: role.label
      }
    ));

    let drive: Promise<void>;
    drive = Promise.resolve()
      .then(async () => {
        await this.runNodeLoop({
          nodeId: effect.nodeId,
          depth: node.depth,
          selfAgentId: role.id,
          selfLabel: role.label,
          initialPrompt: prompt,
          kind: "wake"
        });
      })
      .catch((error) => {
        const message = (error as Error)?.message ?? String(error);
        this.opts.repository.updateEvent(effect.nodeId, {
          status: "failed",
          resultSummary: message
        });
        if (node.isEntry) this.opts.repository.setStatus(this.opts.runId, "failed");
      })
      .finally(() => {
        if (this.recoveryWakeDrives.get(effect.nodeId) === drive) {
          this.recoveryWakeDrives.delete(effect.nodeId);
        }
      });
    this.recoveryWakeDrives.set(effect.nodeId, drive);
  }

  private queueFollowUp(nodeId: string, prompt: string): void {
    const queued = this.queuedFollowUps.get(nodeId) ?? [];
    queued.push(prompt);
    this.queuedFollowUps.set(nodeId, queued);
  }

  private appendQueuedFollowUps(nodeId: string, prompt: string): string {
    const queued = this.queuedFollowUps.get(nodeId);
    if (!queued?.length) return prompt;
    this.queuedFollowUps.delete(nodeId);
    return `${prompt}\n\n用户在等待委派期间补充了以下要求，请一并处理：\n${queued
      .map((item, index) => `${index + 1}. ${item}`)
      .join("\n")}`;
  }

  awaitEventSettle(eventId: string): Promise<DelegationEvent | undefined> {
    const existing = this.opts.repository.getEvent(eventId);
    if (existing && isTerminalDelegationStatus(existing.status)) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const waiters = this.eventWaiters.get(eventId) ?? new Set();
      waiters.add(resolve);
      this.eventWaiters.set(eventId, waiters);
    });
  }

  raceAnySettle(eventIds: string[]): Promise<DelegationEvent | undefined> {
    if (eventIds.length === 0) throw new Error("raceAnySettle: empty id list");
    if (eventIds.length === 1) return this.awaitEventSettle(eventIds[0]!);
    const alreadySettled = eventIds
      .map((id) => this.opts.repository.getEvent(id))
      .find((event) => event && isTerminalDelegationStatus(event.status));
    if (alreadySettled) return Promise.resolve(alreadySettled);

    return new Promise((resolve) => {
      let settled = false;
      const registrations: Array<{
        eventId: string;
        waiter: (event: DelegationEvent | undefined) => void;
      }> = [];
      const cleanup = () => {
        for (const registration of registrations) {
          const waiters = this.eventWaiters.get(registration.eventId);
          waiters?.delete(registration.waiter);
          if (waiters?.size === 0) this.eventWaiters.delete(registration.eventId);
        }
      };
      const finish = (event: DelegationEvent | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(event);
      };
      for (const eventId of eventIds) {
        const waiter = (event: DelegationEvent | undefined) => finish(event);
        registrations.push({ eventId, waiter });
        const waiters = this.eventWaiters.get(eventId) ?? new Set();
        waiters.add(waiter);
        this.eventWaiters.set(eventId, waiters);
      }
    });
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
    kind?: "task" | "wake" | "followUp";
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
      const newlyAccepted = classifyNewDelegationChildren(
        childrenAfterTurn,
        childIdsBeforeTurn
      );
      if (!turn.error && newlyAccepted.settled.length > 0) {
        const immediateWake = delegationWakeInfoForSettled(newlyAccepted.settled);
        const effectiveVerdict =
          newlyAccepted.settled.length === 1
            ? resolveEffectiveWakeVerdict(
                newlyAccepted.settled[0]!,
                this.opts.repository.listEvents(this.opts.runId)
              )
            : { verdict: null, verdictSummary: null };
        prompt = this.appendQueuedFollowUps(opts.nodeId, buildDelegateWakePrompt(
          { ...immediateWake, ...effectiveVerdict },
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
        ));
        kind = "wake";
        continue;
      }
      lastError = resolveTurnCompletionError(turn, newlyAccepted.active.length > 0);
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

      prompt = this.appendQueuedFollowUps(opts.nodeId, buildDelegateWakePrompt(
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
      ));
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
    const entry = this.bus!.nodes[opts.entryNodeId];
    if (
      entry?.status === "parked" &&
      this.opts.repository.listPendingChildEvents(this.opts.runId, opts.entryNodeId).length > 0
    ) {
      this.queueFollowUp(opts.entryNodeId, opts.prompt);
      return { summary: "follow-up queued while delegates are running", error: null, parked: true };
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

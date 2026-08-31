import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { safeSendToWebContents } from "./ipcSend.js";
import {
  createDelegationRun,
  getDelegationRun,
  setDelegationRunStatus,
  insertDelegationEvent,
  updateDelegationEvent,
  transitionDelegationEvent,
  listDelegationEvents,
  cancelActiveDelegationEvents,
  getDelegationRunOwnerId
} from "./delegationRuns.js";
import { recoverInterruptedDelegationRuns as recoverDelegationRunsSqlite } from "@freebuddy/storage-sqlite";
import { sqliteContext } from "./sqliteContext.js";
import { getCallerUserId, runAsCaller } from "./callerContext.js";
import { getUserById } from "./users.js";
import { cliKill, cliYield } from "./runtime.js";
import type {
  DelegationRosterEntry,
  DelegationPolicy,
  DelegationEventStatus
} from "./delegationTeamTypes.js";
import { effectiveDelegationRoleCanWrite } from "./delegationTeamTypes.js";
import { getDelegationTeam } from "./delegationTeams.js";
import type { CLIAdapterId } from "./adapters.js";
import { resolveSkillSnapshots } from "./skills.js";
import {
  cancelDelegatesForRun,
  setDelegateDeps,
  type DelegateRunContext,
  type DelegateExecArgs,
  type DelegateExecResult
} from "./delegationDispatch.js";
import { buildDelegateTaskPrompt } from "./delegation/protocol/text.js";
import type { DelegateAgentRunner } from "./delegationRunner.js";
import {
  classifyNewDelegationChildren,
  delegationWakeInfoForSettled,
  DelegationOrchestrator,
  resolveTurnCompletionError
} from "./delegation/bus/orchestrator.js";
import { electronDelegationRepository } from "../runtime/adapters/delegationRepository.js";
import { currentRuntimePin } from "../runtime/runtimePin.js";
import { app } from "electron";

function currentRuntimePinSafe() {
  try {
    return currentRuntimePin(app.getPath("userData"));
  } catch {
    return currentRuntimePin();
  }
}

export const DELEGATION_SKILL_ID = "delegation";

function delegationEntryScope(runId: string): string {
  return `delegation:${runId}:entry`;
}

function delegationEventScope(runId: string, eventId: string): string {
  return `delegation:${runId}:${eventId}`;
}

/** Unique per agent turn — maps to cli_tasks.id; must never reuse across wakes/follow-ups. */
function delegationTurnSessionId(runId: string, nodeKey: string): string {
  return `del-${runId}-${nodeKey}-${randomUUID().slice(0, 8)}`;
}

function modelConfigOverride(entry: {
  model?: string;
  modelOptionId?: string;
}): Record<string, string> | undefined {
  const model = entry.model?.trim();
  if (!model) return undefined;
  const optionId = entry.modelOptionId?.trim() || "model";
  return { [optionId]: model };
}

type ResolvedAgent = {
  adapter: string;
  agentName: string;
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  skillIds?: string[];
};

export interface DelegationRuntimeDeps {
  webContents: WebContents | undefined;
  resolveAgent: (agentId: string) => ResolvedAgent | undefined;
  runAgent: DelegateAgentRunner;
}

interface RunContext {
  runId: string;
  teamId: string;
  roster: DelegationRosterEntry[];
  sharedInstructions?: string;
  policy: DelegationPolicy;
  entryRoleId: string;
  cwd?: string;
  conversationId?: string;
  ownerId?: string;
  orchestrator?: DelegationOrchestrator;
  rootEventId?: string;
}

interface PendingApproval {
  approvalId: string;
  runId: string;
  teammate: DelegationRosterEntry;
  resolve: (approved: boolean) => void;
}

export class DelegationRuntime {
  private contexts = new Map<string, RunContext>();
  private pendingApprovals: PendingApproval[] = [];
  private killedRunIds = new Set<string>();
  private pausedRunIds = new Set<string>();
  private activeSessionsByRun = new Map<string, Set<string>>();
  private resumeAnchors = new Map<
    string,
    {
      eventId: string;
      parentEventId: string | null;
      depth: number;
      agentId: string;
      roleLabel: string;
      taskText: string;
      canWrite: boolean;
    }
  >();
  private abortWaiters = new Map<string, Array<(err: Error) => void>>();

  constructor(private deps: DelegationRuntimeDeps) {
    setDelegateDeps({
      contextProvider: (runId) => this.getContext(runId),
      executor: (args) => this.executor(args),
      writeApproval: (binding, teammate) => this.requestWriteApproval(binding.runId, teammate),
      onSettle: (id) => {
        const evtRun = this.findRunIdForEvent(id);
        if (evtRun) {
          this.contexts.get(evtRun)?.orchestrator?.onEventSettled(id);
          const child = this.contexts
            .get(evtRun)
            ?.orchestrator?.state?.nodes[id];
          if (child) {
            // leaf started tracking already handled at enqueue/start
          }
        }
      },
      onChildEnqueued: ({ runId, childEventId, parentEventId, depth }) => {
        this.contexts.get(runId)?.orchestrator?.noteChildEnqueued({
          childEventId,
          parentEventId,
          depth
        });
      },
      onYieldRequested: (binding) => {
        cliYield(binding.taskSessionId);
      }
    });
  }

  private findRunIdForEvent(eventId: string): string | undefined {
    for (const [runId, ctx] of this.contexts) {
      if (ctx.orchestrator?.state?.nodes[eventId]) return runId;
    }
    // Fallback: scan DB via list for known contexts
    for (const runId of this.contexts.keys()) {
      const events = listDelegationEvents(runId);
      if (events.some((e) => e.id === eventId)) return runId;
    }
    return undefined;
  }

  getContext(runId: string): DelegateRunContext | undefined {
    let ctx = this.contexts.get(runId);
    if (!ctx) {
      ctx = this.loadContextFromDb(runId);
    }
    if (!ctx) return undefined;
    return { roster: ctx.roster, policy: ctx.policy, teamId: ctx.teamId, cwd: ctx.cwd };
  }

  private loadContextFromDb(runId: string): RunContext | undefined {
    const run = getDelegationRun(runId);
    if (!run?.teamId) return undefined;
    const team = getDelegationTeam(run.teamId);
    if (!team) return undefined;
    const ctx: RunContext = {
      runId,
      teamId: run.teamId,
      roster: team.roster,
      sharedInstructions: team.sharedInstructions,
      policy: team.policy,
      entryRoleId: team.entryRoleId,
      cwd: run.cwd ?? undefined,
      conversationId: run.conversationId ?? undefined,
      ownerId: getDelegationRunOwnerId(runId) ?? undefined
    };
    this.contexts.set(runId, ctx);
    return ctx;
  }

  /** Reload team roster/model bindings so mid-run edits take effect on the next turn. */
  private refreshTeamFromDb(ctx: RunContext): void {
    const team = getDelegationTeam(ctx.teamId);
    if (!team) return;
    ctx.roster = team.roster;
    ctx.sharedInstructions = team.sharedInstructions;
    ctx.policy = team.policy;
    ctx.entryRoleId = team.entryRoleId;
    ctx.orchestrator?.syncTeamSnapshot({
      roster: team.roster,
      sharedInstructions: team.sharedInstructions,
      policy: team.policy,
      entryRoleId: team.entryRoleId
    });
  }

  private ensureOrchestrator(ctx: RunContext): DelegationOrchestrator {
    if (ctx.orchestrator) return ctx.orchestrator;
    const orch = new DelegationOrchestrator({
      runId: ctx.runId,
      roster: ctx.roster,
      sharedInstructions: ctx.sharedInstructions,
      policy: ctx.policy,
      entryRoleId: ctx.entryRoleId,
      repository: electronDelegationRepository(),
      spawnTurn: async (args) => {
        this.refreshTeamFromDb(ctx);
        const agent =
          ctx.roster.find((r) => r.id === args.selfAgentId) ??
          ctx.roster.find((r) => r.id === ctx.entryRoleId) ??
          ctx.roster[0]!;
        const resolvedAgent = this.deps.resolveAgent(agent.agentId);
        if (!resolvedAgent) {
          return { summary: "", error: `agent not found: ${agent.agentId}` };
        }
        // Keep scope stable so ACP tool sessions resume; mint a fresh
        // sessionId each turn so cli_tasks PRIMARY KEY never collides on
        // wake / follow-up (see debug delrun_mspc69xn_93qqdw).
        const scope =
          args.depth === 0
            ? delegationEntryScope(ctx.runId)
            : delegationEventScope(ctx.runId, args.nodeId);
        const sessionId = delegationTurnSessionId(
          ctx.runId,
          args.depth === 0 ? "entry" : args.nodeId
        );
        const turn = await this.runAgentTurn({
          ctx,
          agent,
          resolved: resolvedAgent,
          scope,
          sessionId,
          parentEventId: args.nodeId,
          depth: args.depth,
          prompt: args.prompt
        });
        return {
          summary: turn.summary,
          error: turn.error,
          hasOutput: turn.hasOutput,
          diagnostic: turn.diagnostic
        };
      }
    });
    ctx.orchestrator = orch;
    return orch;
  }

  prepareRun(input: {
    goal: string;
    teamId: string;
    teamSnapshot: {
      roster: DelegationRosterEntry[];
      sharedInstructions?: string;
      policy: DelegationPolicy;
      entryRoleId: string;
    };
    cwd?: string;
    conversationId?: string;
    ownerId?: string;
  }): string {
    const runId = createDelegationRun({
      goal: input.goal,
      cwd: input.cwd,
      teamId: input.teamId,
      teamSnapshotJson: JSON.stringify(input.teamSnapshot),
      conversationId: input.conversationId,
      ...currentRuntimePinSafe()
    });
    this.contexts.set(runId, {
      runId,
      teamId: input.teamId,
      roster: input.teamSnapshot.roster,
      sharedInstructions: input.teamSnapshot.sharedInstructions,
      policy: input.teamSnapshot.policy,
      entryRoleId: input.teamSnapshot.entryRoleId,
      cwd: input.cwd,
      conversationId: input.conversationId,
      ownerId: input.ownerId ?? getCallerUserId() ?? undefined
    });
    return runId;
  }

  async runEntry(runId: string, goal: string): Promise<void> {
    const ctx = this.contexts.get(runId);
    if (!ctx) return;
    const entry = ctx.roster.find((r) => r.id === ctx.entryRoleId) ?? ctx.roster[0];
    const rootEventId = insertDelegationEvent({
      runId,
      parentEventId: null,
      agentId: entry.agentId,
      agentName: entry.label,
      roleLabel: entry.label,
      taskText: goal,
      depth: 0,
      canWrite: effectiveDelegationRoleCanWrite(ctx.policy, entry),
      status: "running"
    });
    ctx.rootEventId = rootEventId;
    const resolved = this.deps.resolveAgent(entry.agentId);
    if (!resolved) {
      updateDelegationEvent(rootEventId, {
        status: "failed",
        resultSummary: `agent not found: ${entry.agentId}`
      });
      setDelegationRunStatus(runId, "failed");
      return;
    }

    const orch = this.ensureOrchestrator(ctx);
    orch.bindEntry(rootEventId);

    const prompt = buildDelegateTaskPrompt(
      goal,
      ctx.roster,
      entry.id,
      0,
      ctx.policy.maxDepth,
      {
        sharedInstructions: ctx.sharedInstructions,
        roleInstructions: entry.instructions,
        selfLabel: entry.label
      }
    );

    try {
      const result = await orch.runNodeLoop({
        nodeId: rootEventId,
        depth: 0,
        selfAgentId: entry.id,
        selfLabel: entry.label,
        initialPrompt: prompt,
        kind: "task"
      });
      if (this.killedRunIds.has(runId)) {
        updateDelegationEvent(rootEventId, {
          status: "cancelled",
          resultSummary: result.error ?? result.summary
        });
        return;
      }
      if (this.pausedRunIds.has(runId)) {
        return;
      }
      // Orchestrator already marks run/node terminal via FSM effects when appropriate.
      // Ensure root event has a summary if still running-ish.
      const status: DelegationEventStatus = result.error ? "failed" : "done";
      updateDelegationEvent(rootEventId, {
        status,
        resultSummary: result.error ?? result.summary
      });
      if (!this.killedRunIds.has(runId) && !this.pausedRunIds.has(runId)) {
        const run = getDelegationRun(runId);
        if (run && run.status === "running") {
          setDelegationRunStatus(
            runId,
            status === "done" ? "completed" : "failed"
          );
        }
      }
    } catch (err) {
      if (this.pausedRunIds.has(runId)) return;
      updateDelegationEvent(rootEventId, {
        status: "failed",
        resultSummary: (err as Error).message
      });
      if (!this.killedRunIds.has(runId)) setDelegationRunStatus(runId, "failed");
    }
  }

  /**
   * Conversation follow-up on an existing delegation run.
   * Reopens completed/failed runs and drives entry park/wake via the bus.
   */
  async followUp(runId: string, userPrompt: string): Promise<void> {
    let ctx = this.contexts.get(runId);
    if (!ctx) ctx = this.loadContextFromDb(runId);
    if (!ctx) throw new Error("delegation run not found");

    this.killedRunIds.delete(runId);
    this.pausedRunIds.delete(runId);
    const entry = ctx.roster.find((r) => r.id === ctx!.entryRoleId) ?? ctx.roster[0];
    const events = listDelegationEvents(runId);
    let root = events.find((e) => e.depth === 0);
    if (!root) {
      const rootEventId = insertDelegationEvent({
        runId,
        parentEventId: null,
        agentId: entry.agentId,
        agentName: entry.label,
        roleLabel: entry.label,
        taskText: userPrompt,
        depth: 0,
        canWrite: effectiveDelegationRoleCanWrite(ctx.policy, entry),
        status: "running"
      });
      root = listDelegationEvents(runId).find((e) => e.id === rootEventId)!;
    }
    ctx.rootEventId = root.id;

    const orch = this.ensureOrchestrator(ctx);
    if (!orch.state) orch.bindEntry(root.id);

    // Reset root to running for the follow-up turn.
    transitionDelegationEvent(root.id, "running", null, { allowReopen: true });

    const prompt = buildDelegateTaskPrompt(
      userPrompt,
      ctx.roster,
      entry.id,
      0,
      ctx.policy.maxDepth,
      {
        sharedInstructions: ctx.sharedInstructions,
        roleInstructions: entry.instructions,
        selfLabel: entry.label
      }
    );

    const result = await orch.followUp({
      entryNodeId: root.id,
      entry,
      prompt
    });

    if (this.killedRunIds.has(runId)) return;
    const status: DelegationEventStatus = result.error ? "failed" : "done";
    updateDelegationEvent(root.id, {
      status,
      resultSummary: result.error ?? result.summary
    });
    const run = getDelegationRun(runId);
    if (run && (run.status === "running" || run.status === "blocked")) {
      setDelegationRunStatus(runId, status === "done" ? "completed" : "failed");
    }
  }

  private waitForAbort(runId: string): Promise<never> {
    return new Promise((_, reject) => {
      const list = this.abortWaiters.get(runId) ?? [];
      list.push(reject);
      this.abortWaiters.set(runId, list);
    });
  }

  private signalAbortWaiters(runId: string, message: string): void {
    const list = this.abortWaiters.get(runId) ?? [];
    this.abortWaiters.delete(runId);
    const err = new Error(message);
    for (const reject of list) reject(err);
  }

  private async runAgentTurn(opts: {
    ctx: RunContext;
    agent: DelegationRosterEntry;
    resolved: ResolvedAgent;
    scope: string;
    sessionId: string;
    parentEventId: string;
    depth: number;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<DelegateExecResult> {
    this.refreshTeamFromDb(opts.ctx);
    const agent =
      opts.ctx.roster.find((r) => r.id === opts.agent.id) ??
      opts.ctx.roster.find(
        (r) => r.agentId === opts.agent.agentId && r.label === opts.agent.label
      ) ??
      opts.agent;
    const modelOverride = modelConfigOverride(agent);
    const sessions = this.activeSessionsByRun.get(opts.ctx.runId) ?? new Set<string>();
    sessions.add(opts.sessionId);
    this.activeSessionsByRun.set(opts.ctx.runId, sessions);
    let removeSignalListener: (() => void) | undefined;
    try {
      const runAgent = () =>
        this.deps.runAgent({
          sessionId: opts.sessionId,
          conversationId: opts.ctx.conversationId,
          toolSessionScope: opts.scope,
          resumeToolSession: true,
          roleLabel: agent.label,
          agentId: agent.agentId,
          agentName: opts.resolved.agentName,
          adapter: opts.resolved.adapter as CLIAdapterId,
          binary: opts.resolved.binary,
          extraArgs: opts.resolved.extraArgs,
          env: opts.resolved.env,
          prompt: opts.prompt,
          cwd: opts.ctx.cwd,
          approvalMode: "auto",
          workspaceAccess: effectiveDelegationRoleCanWrite(opts.ctx.policy, agent)
            ? "read-write"
            : "read-only",
          ...(modelOverride ? { configOptionOverrides: modelOverride } : {}),
          skills: resolveSkillSnapshots([
            ...(agent.skillIds ?? []),
            DELEGATION_SKILL_ID
          ]),
          announceSkills: true,
          delegation: {
            runId: opts.ctx.runId,
            parentEventId: opts.parentEventId,
            depth: opts.depth,
            selfAgentId: agent.id,
            selfLabel: agent.label
          }
        });
      const isOwner = opts.ctx.ownerId
        ? getUserById(opts.ctx.ownerId)?.isOwner ?? false
        : false;
      const races: Array<Promise<Awaited<ReturnType<DelegateAgentRunner>>>> = [
        opts.ctx.ownerId
          ? runAsCaller(opts.ctx.ownerId, runAgent, isOwner)
          : runAgent(),
        this.waitForAbort(opts.ctx.runId)
      ];
      if (opts.signal) {
        races.push(
          new Promise((_, reject) => {
            const abort = () => {
              cliKill(opts.sessionId);
              const reason = opts.signal?.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason ?? "cancelled")));
            };
            if (opts.signal!.aborted) {
              abort();
              return;
            }
            opts.signal!.addEventListener("abort", abort, { once: true });
            removeSignalListener = () => opts.signal?.removeEventListener("abort", abort);
          })
        );
      }
      const result = await Promise.race(races);
      if (this.pausedRunIds.has(opts.ctx.runId) || this.killedRunIds.has(opts.ctx.runId)) {
        return {
          summary: result.summary,
          exitCode: result.exitCode,
          error: this.pausedRunIds.has(opts.ctx.runId) ? "paused by user" : "killed"
        };
      }
      return {
        summary: result.summary,
        exitCode: result.exitCode,
        error: result.error,
        hasOutput: result.hasOutput,
        diagnostic: result.diagnostic
      };
    } catch (err) {
      const message = (err as Error).message;
      if (this.pausedRunIds.has(opts.ctx.runId) || /paused by user/i.test(message)) {
        return { summary: "", exitCode: null, error: "paused by user" };
      }
      if (this.killedRunIds.has(opts.ctx.runId) || /killed/i.test(message)) {
        return { summary: "", exitCode: null, error: "killed" };
      }
      return { summary: "", exitCode: null, error: message };
    } finally {
      removeSignalListener?.();
      const set = this.activeSessionsByRun.get(opts.ctx.runId);
      set?.delete(opts.sessionId);
      if (set && set.size === 0) this.activeSessionsByRun.delete(opts.ctx.runId);
    }
  }

  async start(input: {
    goal: string;
    teamId: string;
    teamSnapshot: {
      roster: DelegationRosterEntry[];
      sharedInstructions?: string;
      policy: DelegationPolicy;
      entryRoleId: string;
    };
    cwd?: string;
    conversationId?: string;
  }): Promise<string> {
    const runId = this.prepareRun(input);
    await this.runEntry(runId, input.goal);
    return runId;
  }

  private async executor(args: DelegateExecArgs): Promise<DelegateExecResult> {
    const ctx = this.contexts.get(args.runId);
    if (!ctx) {
      return { summary: "", exitCode: null, error: "run context not found" };
    }
    this.refreshTeamFromDb(ctx);
    const teammate =
      ctx.roster.find((r) => r.id === args.teammate.id) ??
      ctx.roster.find(
        (r) => r.agentId === args.teammate.agentId && r.label === args.teammate.label
      ) ??
      args.teammate;
    const resolved = this.deps.resolveAgent(teammate.agentId);
    if (!resolved) {
      return {
        summary: "",
        exitCode: null,
        error: `agent not resolved: ${teammate.agentId}`
      };
    }

    const orch = this.ensureOrchestrator(ctx);
    orch.noteChildEnqueued({
      childEventId: args.childEventId,
      parentEventId: args.parentEventId,
      depth: args.depth
    });
    orch.noteChildStarted(args.childEventId);

    const { buildDelegateWakePrompt } = await import("./delegation/protocol/text.js");
    const { resolveEffectiveWakeVerdict } = await import("./delegation/protocol/wakeVerdict.js");
    const { listPendingChildEvents, listDelegationEvents } = await import("./delegationRuns.js");

    let prompt = buildDelegateTaskPrompt(
      args.task,
      ctx.roster,
      teammate.id,
      args.depth,
      ctx.policy.maxDepth,
      {
        sharedInstructions: ctx.sharedInstructions,
        roleInstructions: teammate.instructions,
        selfLabel: teammate.label
      }
    );
    let lastError: string | null = null;
    let lastSummary = "";

    while (
      !args.signal?.aborted &&
      !this.killedRunIds.has(args.runId) &&
      !this.pausedRunIds.has(args.runId)
    ) {
      const childIdsBeforeTurn = new Set(
        listDelegationEvents(args.runId)
          .filter((event) => event.parentEventId === args.childEventId)
          .map((event) => event.id)
      );
      const turn = await this.runAgentTurn({
        ctx,
        agent: teammate,
        resolved,
        scope: delegationEventScope(ctx.runId, args.childEventId),
        sessionId: delegationTurnSessionId(ctx.runId, args.childEventId),
        parentEventId: args.childEventId,
        depth: args.depth,
        prompt,
        signal: args.signal
      });
      lastSummary = turn.summary ?? "";
      if (
        args.signal?.aborted ||
        this.killedRunIds.has(args.runId) ||
        this.pausedRunIds.has(args.runId)
      ) {
        lastError = lastError ?? (this.pausedRunIds.has(args.runId) ? "paused by user" : "killed");
        break;
      }
      const childrenAfterTurn = listDelegationEvents(args.runId).filter(
        (event) => event.parentEventId === args.childEventId
      );
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
                listDelegationEvents(args.runId)
              )
            : { verdict: null, verdictSummary: null };
        prompt = buildDelegateWakePrompt(
          { ...immediateWake, ...effectiveVerdict },
          ctx.roster,
          teammate.id,
          args.depth,
          ctx.policy.maxDepth,
          {
            sharedInstructions: ctx.sharedInstructions,
            roleInstructions: teammate.instructions,
            selfLabel: teammate.label
          }
        );
        continue;
      }
      lastError = resolveTurnCompletionError(turn, newlyAccepted.active.length > 0);
      const pending = childrenAfterTurn.filter(
        (event) => event.status === "pending" || event.status === "running"
      );
      if (pending.length === 0) break;
      const settled = await orch.raceAnySettle(pending.map((e) => e.id));
      if (this.killedRunIds.has(args.runId) || this.pausedRunIds.has(args.runId)) {
        lastError = lastError ?? (this.pausedRunIds.has(args.runId) ? "paused by user" : "killed");
        break;
      }
      const effective = resolveEffectiveWakeVerdict(
        settled ?? { id: "", verdict: null, verdictSummary: null },
        listDelegationEvents(args.runId)
      );
      prompt = buildDelegateWakePrompt(
        {
          taskText: settled?.taskText ?? "",
          roleLabel: settled?.roleLabel ?? "",
          status: settled?.status ?? "done",
          resultSummary: settled?.resultSummary ?? "",
          verdict: effective.verdict,
          verdictSummary: effective.verdictSummary
        },
        ctx.roster,
        teammate.id,
        args.depth,
        ctx.policy.maxDepth,
        {
          sharedInstructions: ctx.sharedInstructions,
          roleInstructions: teammate.instructions,
          selfLabel: teammate.label
        }
      );
    }
    return { summary: lastSummary, exitCode: null, error: lastError };
  }

  requestWriteApproval(runId: string, teammate: DelegationRosterEntry): Promise<boolean> {
    const approvalId = randomUUID();
    setDelegationRunStatus(runId, "blocked");
    safeSendToWebContents(this.deps.webContents, `delegation://approval/${runId}`, {
      runId,
      approvalId,
      teammate
    });
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.push({ approvalId, runId, teammate, resolve });
    });
  }

  listPendingApprovals(): Array<{ approvalId: string; runId: string }> {
    return this.pendingApprovals.map((p) => ({
      approvalId: p.approvalId,
      runId: p.runId
    }));
  }

  resolveWriteApproval(approvalId: string, approved: boolean): void {
    const idx = this.pendingApprovals.findIndex((p) => p.approvalId === approvalId);
    if (idx < 0) return;
    const [pending] = this.pendingApprovals.splice(idx, 1);
    const stillWaitingForRun = this.pendingApprovals.some((p) => p.runId === pending.runId);
    if (
      !stillWaitingForRun &&
      !this.killedRunIds.has(pending.runId) &&
      !this.pausedRunIds.has(pending.runId)
    ) {
      const run = getDelegationRun(pending.runId);
      if (run?.status === "blocked") setDelegationRunStatus(pending.runId, "running");
    }
    pending.resolve(approved);
  }

  stopRun(runId: string): void {
    this.pausedRunIds.delete(runId);
    this.resumeAnchors.delete(runId);
    this.killedRunIds.add(runId);
    this.contexts.get(runId)?.orchestrator?.markKilled();
    this.signalAbortWaiters(runId, "killed");
    for (const sessionId of this.activeSessionsByRun.get(runId) ?? []) {
      try {
        cliKill(sessionId);
      } catch {
        /* noop */
      }
    }
    this.activeSessionsByRun.delete(runId);
    cancelDelegatesForRun(runId, "用户停止");
    for (const pending of [...this.pendingApprovals]) {
      if (pending.runId !== runId) continue;
      this.resolveWriteApproval(pending.approvalId, false);
    }
    cancelActiveDelegationEvents(runId, "用户停止");
    setDelegationRunStatus(runId, "killed");
  }

  pauseRun(runId: string): boolean {
    const run = getDelegationRun(runId);
    if (!run || (run.status !== "running" && run.status !== "blocked")) {
      return false;
    }
    const events = listDelegationEvents(runId);
    const candidates = events.filter(
      (e) => e.status === "running" || e.status === "pending"
    );
    candidates.sort((a, b) => b.depth - a.depth || (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    const anchor = candidates[0];
    if (anchor) {
      this.resumeAnchors.set(runId, {
        eventId: anchor.id,
        parentEventId: anchor.parentEventId,
        depth: anchor.depth,
        agentId: anchor.agentId,
        roleLabel: anchor.roleLabel,
        taskText: anchor.taskText,
        canWrite: anchor.canWrite
      });
    } else {
      this.resumeAnchors.delete(runId);
    }

    this.pausedRunIds.add(runId);
    this.contexts.get(runId)?.orchestrator?.interruptLoops();
    this.signalAbortWaiters(runId, "paused by user");
    for (const sessionId of this.activeSessionsByRun.get(runId) ?? []) {
      try {
        cliKill(sessionId);
      } catch {
        /* noop */
      }
    }
    this.activeSessionsByRun.delete(runId);
    cancelDelegatesForRun(runId, "用户暂停");

    for (const pending of [...this.pendingApprovals]) {
      if (pending.runId !== runId) continue;
      this.resolveWriteApproval(pending.approvalId, false);
    }

    cancelActiveDelegationEvents(runId, "用户暂停");
    setDelegationRunStatus(runId, "paused");
    return true;
  }

  async resumeRun(runId: string): Promise<boolean> {
    const run = getDelegationRun(runId);
    if (!run || run.status !== "paused") return false;
    let ctx = this.contexts.get(runId);
    if (!ctx) ctx = this.loadContextFromDb(runId);
    if (!ctx) return false;

    this.refreshTeamFromDb(ctx);
    this.pausedRunIds.delete(runId);
    this.killedRunIds.delete(runId);
    setDelegationRunStatus(runId, "running");
    ctx.orchestrator?.clearInterrupt();

    const anchor = this.resumeAnchors.get(runId);
    this.resumeAnchors.delete(runId);

    if (!anchor) {
      await this.followUp(
        runId,
        "继续先前因用户暂停而中断的任务。会话锚点已丢失，请从入口角色根据当前工作区状态继续推进并收尾。"
      );
      return true;
    }

    const role =
      ctx.roster.find((r) => r.agentId === anchor.agentId && r.label === anchor.roleLabel) ??
      ctx.roster.find((r) => r.label === anchor.roleLabel) ??
      ctx.roster.find((r) => r.agentId === anchor.agentId);
    if (!role) {
      await this.followUp(
        runId,
        `继续先前因用户暂停而中断的任务（原角色 ${anchor.roleLabel} 已不在花名册）。请根据当前工作区状态继续。`
      );
      return true;
    }

    const resumeTask = [
      "【用户暂停后续跑】上次执行被用户暂停中断。请从现场继续完成原任务，不要无故从头重做已完成部分。",
      "",
      "原任务：",
      anchor.taskText
    ].join("\n");

    if (anchor.depth <= 0) {
      const rootId = insertDelegationEvent({
        runId,
        parentEventId: null,
        agentId: role.agentId,
        agentName: role.label,
        roleLabel: role.label,
        taskText: resumeTask,
        depth: 0,
        canWrite: effectiveDelegationRoleCanWrite(ctx.policy, role),
        status: "running"
      });
      ctx.rootEventId = rootId;
      const orch = this.ensureOrchestrator(ctx);
      orch.bindEntry(rootId);
      orch.clearInterrupt();
      const prompt = buildDelegateTaskPrompt(
        resumeTask,
        ctx.roster,
        role.id,
        0,
        ctx.policy.maxDepth,
        {
          sharedInstructions: ctx.sharedInstructions,
          roleInstructions: role.instructions,
          selfLabel: role.label
        }
      );
      const result = await orch.runNodeLoop({
        nodeId: rootId,
        depth: 0,
        selfAgentId: role.id,
        selfLabel: role.label,
        initialPrompt: prompt,
        kind: "task"
      });
      if (this.pausedRunIds.has(runId) || this.killedRunIds.has(runId)) return true;
      const status: DelegationEventStatus = result.error ? "failed" : "done";
      updateDelegationEvent(rootId, {
        status,
        resultSummary: result.error ?? result.summary
      });
      const latest = getDelegationRun(runId);
      if (latest && latest.status === "running") {
        setDelegationRunStatus(runId, status === "done" ? "completed" : "failed");
      }
      return true;
    }

    const childId = insertDelegationEvent({
      runId,
      parentEventId: anchor.parentEventId,
      agentId: role.agentId,
      agentName: role.label,
      roleLabel: role.label,
      taskText: resumeTask,
      depth: anchor.depth,
      canWrite: effectiveDelegationRoleCanWrite(ctx.policy, role),
      status: "pending"
    });
    const result = await this.executor({
      teammate: role,
      task: resumeTask,
      runId,
      teamId: ctx.teamId,
      cwd: ctx.cwd,
      childEventId: childId,
      parentEventId: anchor.parentEventId ?? ctx.rootEventId ?? childId,
      depth: anchor.depth
    });
    if (this.pausedRunIds.has(runId) || this.killedRunIds.has(runId)) return true;
    updateDelegationEvent(childId, {
      status: result.error ? "failed" : "done",
      resultSummary: result.error ?? result.summary
    });
    const latest = getDelegationRun(runId);
    if (latest && latest.status === "running") {
      // Child resume may leave entry parked; prefer leave running unless no active work.
      const stillActive = listDelegationEvents(runId).some(
        (e) => e.status === "pending" || e.status === "running"
      );
      if (!stillActive) {
        setDelegationRunStatus(runId, result.error ? "failed" : "completed");
      }
    }
    return true;
  }
}

export function recoverInterruptedDelegationRuns(): number {
  return recoverDelegationRunsSqlite(sqliteContext());
}

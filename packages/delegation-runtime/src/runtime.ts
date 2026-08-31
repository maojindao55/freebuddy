import { randomUUID } from "node:crypto";
import {
  analyzeAgentOutput,
  EMPTY_AGENT_OUTPUT_ERROR,
  resolveAgentRunError
} from "@freebuddy/agent-runtime";
import type {
  DelegationEventStatus,
  DelegationPolicy,
  DelegationRosterEntry
} from "@freebuddy/protocol/delegation";
import { effectiveDelegationRoleCanWrite } from "@freebuddy/protocol/delegation";
import { buildDelegateTaskPrompt } from "@freebuddy/delegation-core";
import type { DelegationRuntimePorts } from "./ports.js";
import { DelegationOrchestrator } from "./orchestrator.js";

export const DELEGATION_SKILL_ID = "delegation";

type RunContext = {
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
};

export class DelegationRuntime {
  private contexts = new Map<string, RunContext>();
  private killedRunIds = new Set<string>();
  private pausedRunIds = new Set<string>();

  constructor(private readonly ports: DelegationRuntimePorts) {}

  getContext(runId: string): { roster: DelegationRosterEntry[]; policy: RunContext["policy"]; teamId: string; cwd?: string } | undefined {
    const ctx = this.contexts.get(runId) ?? this.loadContextFromRepo(runId);
    if (!ctx) return undefined;
    return { roster: ctx.roster, policy: ctx.policy, teamId: ctx.teamId, cwd: ctx.cwd };
  }

  private loadContextFromRepo(runId: string): RunContext | undefined {
    const run = this.ports.repository.getRun(runId);
    if (!run?.teamId) return undefined;
    const team = this.ports.getTeam(run.teamId);
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
      ownerId: this.ports.repository.getOwnerId?.(runId)
    };
    this.contexts.set(runId, ctx);
    return ctx;
  }

  private ensureOrchestrator(ctx: RunContext): DelegationOrchestrator {
    if (ctx.orchestrator) return ctx.orchestrator;
    const orch = new DelegationOrchestrator({
      runId: ctx.runId,
      roster: ctx.roster,
      sharedInstructions: ctx.sharedInstructions,
      policy: ctx.policy,
      entryRoleId: ctx.entryRoleId,
      repository: this.ports.repository,
      spawnTurn: async (args) => {
        const agent =
          ctx.roster.find((r) => r.id === args.selfAgentId) ??
          ctx.roster.find((r) => r.id === ctx.entryRoleId) ??
          ctx.roster[0]!;
        const resolved = this.ports.resolveAgent(agent.agentId);
        if (!resolved) {
          return { summary: "", error: `agent not found: ${agent.agentId}` };
        }
        const sessionId = `del-${ctx.runId}-${args.nodeId}-${randomUUID().slice(0, 8)}`;
        const collected: unknown[] = [];
        let exitCode: number | null = null;
        let error: string | null = null;
        try {
          await this.ports.executor.run(
            {
              sessionId,
              conversationId: ctx.conversationId,
              agentId: agent.agentId,
              agentName: resolved.agentName,
              adapter: resolved.adapter,
              binary: resolved.binary,
              extraArgs: resolved.extraArgs,
              env: resolved.env,
              skillIds: [...(agent.skillIds ?? []), DELEGATION_SKILL_ID],
              prompt: args.prompt,
              cwd: ctx.cwd,
              workspaceAccess: effectiveDelegationRoleCanWrite(ctx.policy, agent)
                ? "read-write"
                : "read-only",
              signal: this.ports.abort
            },
            (event) => {
              if (event.type === "items" && event.items.length) {
                collected.push(...event.items);
              }
              if (event.type === "done") exitCode = event.exitCode ?? null;
              if (event.type === "error") error = event.message;
            }
          );
        } catch (err) {
          error = (err as Error).message;
        }
        const evidence = analyzeAgentOutput(collected);
        const resolvedError = resolveAgentRunError(collected, error, exitCode);
        error =
          resolvedError === EMPTY_AGENT_OUTPUT_ERROR && evidence.hasOutput
            ? null
            : resolvedError;
        return {
          summary: evidence.summary,
          error,
          hasOutput: evidence.hasOutput,
          diagnostic: evidence.toolError
            ? `Agent ended after a failed tool call without a final response or artifact: ${evidence.toolError}`
            : null
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
      policy: RunContext["policy"];
      entryRoleId: string;
    };
    cwd?: string;
    conversationId?: string;
    ownerId?: string;
    runtimeVersion?: string | null;
    runtimeApiVersion?: string | null;
  }): string {
    const run = this.ports.repository.createRun({
      goal: input.goal,
      cwd: input.cwd ?? null,
      teamId: input.teamId,
      teamSnapshotJson: JSON.stringify(input.teamSnapshot),
      conversationId: input.conversationId ?? null,
      status: "running",
      runtimeVersion: input.runtimeVersion,
      runtimeApiVersion: input.runtimeApiVersion
    });
    this.contexts.set(run.id, {
      runId: run.id,
      teamId: input.teamId,
      roster: input.teamSnapshot.roster,
      sharedInstructions: input.teamSnapshot.sharedInstructions,
      policy: input.teamSnapshot.policy,
      entryRoleId: input.teamSnapshot.entryRoleId,
      cwd: input.cwd,
      conversationId: input.conversationId,
      ownerId: input.ownerId
    });
    return run.id;
  }

  async runEntry(runId: string, goal: string): Promise<void> {
    const ctx = this.contexts.get(runId);
    if (!ctx) return;
    const entry = ctx.roster.find((r) => r.id === ctx.entryRoleId) ?? ctx.roster[0];
    if (!entry) return;
    const rootEventId = this.ports.repository.insertEvent({
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
    const resolved = this.ports.resolveAgent(entry.agentId);
    if (!resolved) {
      this.ports.repository.updateEvent(rootEventId, {
        status: "failed",
        resultSummary: `agent not found: ${entry.agentId}`
      });
      this.ports.repository.setStatus(runId, "failed");
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
      if (this.killedRunIds.has(runId)) return;
      const status: DelegationEventStatus = result.error ? "failed" : "done";
      this.ports.repository.updateEvent(rootEventId, {
        status,
        resultSummary: result.error ?? result.summary
      });
      const run = this.ports.repository.getRun(runId);
      if (run?.status === "running") {
        this.ports.repository.setStatus(runId, status === "done" ? "completed" : "failed");
      }
    } catch (err) {
      this.ports.repository.updateEvent(rootEventId, {
        status: "failed",
        resultSummary: (err as Error).message
      });
      if (!this.killedRunIds.has(runId)) this.ports.repository.setStatus(runId, "failed");
    }
  }

  async start(input: {
    goal: string;
    teamId: string;
    teamSnapshot: {
      roster: DelegationRosterEntry[];
      sharedInstructions?: string;
      policy: RunContext["policy"];
      entryRoleId: string;
    };
    cwd?: string;
    conversationId?: string;
    runtimeVersion?: string | null;
    runtimeApiVersion?: string | null;
  }): Promise<string> {
    const runId = this.prepareRun(input);
    await this.runEntry(runId, input.goal);
    return runId;
  }

  stopRun(runId: string): void {
    this.killedRunIds.add(runId);
    this.contexts.get(runId)?.orchestrator?.markKilled();
    this.ports.repository.cancelActiveEvents(runId, "stopped");
    this.ports.repository.setStatus(runId, "killed");
  }

  listActiveRunIds(): string[] {
    return [...this.contexts.keys()].filter((id) => !this.killedRunIds.has(id) && !this.pausedRunIds.has(id));
  }

  async followUp(runId: string, userPrompt: string): Promise<void> {
    let ctx = this.contexts.get(runId) ?? this.loadContextFromRepo(runId);
    if (!ctx) throw new Error("delegation run not found");
    this.killedRunIds.delete(runId);
    this.pausedRunIds.delete(runId);
    const entry = ctx.roster.find((r) => r.id === ctx.entryRoleId) ?? ctx.roster[0];
    if (!entry) throw new Error("team has no entry role");
    const events = this.ports.repository.listEvents(runId);
    let root = events.find((event) => event.depth === 0);
    if (!root) {
      const rootEventId = this.ports.repository.insertEvent({
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
      root = this.ports.repository.getEvent(rootEventId);
    }
    if (!root) throw new Error("delegation root event missing");
    ctx.rootEventId = root.id;
    const orch = this.ensureOrchestrator(ctx);
    this.ports.repository.transitionEvent(root.id, "running", null, { allowReopen: true });
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
    this.ports.repository.updateEvent(root.id, {
      status,
      resultSummary: result.error ?? result.summary
    });
    const run = this.ports.repository.getRun(runId);
    if (run && (run.status === "running" || run.status === "blocked")) {
      this.ports.repository.setStatus(runId, status === "done" ? "completed" : "failed");
    }
  }

  pauseRun(runId: string): boolean {
    const run = this.ports.repository.getRun(runId);
    if (!run || (run.status !== "running" && run.status !== "blocked")) return false;
    this.pausedRunIds.add(runId);
    this.contexts.get(runId)?.orchestrator?.interruptLoops();
    this.ports.repository.cancelActiveEvents(runId, "paused");
    return this.ports.repository.setStatus(runId, "paused");
  }

  async resumeRun(runId: string): Promise<boolean> {
    const run = this.ports.repository.getRun(runId);
    if (!run || run.status !== "paused") return false;
    this.pausedRunIds.delete(runId);
    this.killedRunIds.delete(runId);
    this.ports.repository.setStatus(runId, "running", { allowReopen: true });
    await this.followUp(
      runId,
      "继续先前因用户暂停而中断的任务。请根据当前工作区状态继续推进并收尾。"
    );
    return true;
  }
}

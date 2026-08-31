import { randomUUID } from "node:crypto";
import { resolveAgentRunError } from "@freebuddy/agent-runtime";
import type {
  WorkflowAgentRef,
  WorkflowPhase,
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepRow
} from "@freebuddy/protocol/workflow";
import { validateWorkflowPlan } from "@freebuddy/workflow-core";
import {
  isImplementReviewLoopPlan,
  IMPLEMENT_REVIEW_STEP_ID,
  REVIEW_CHANGES_STEP_ID,
  VERIFY_CHANGES_STEP_ID
} from "@freebuddy/workflow-core";
import {
  applyWorkflowLanguagePreference,
  augmentPromptWithConsumedSummaries,
  decideImplementReviewLoop,
  decideReviewLoop,
  deriveStepSummary,
  ensureReviewStatusInSummary,
  extractVisibleStepOutput,
  extractReviewStatus,
  findResumePhaseIndex,
  phaseGateSatisfied,
  reviewDecisionTextFromItems,
  resumableStepRowIds,
  resolveReviewDecisionText,
  selectRunnableSteps,
  verifierHasUnresolved
} from "@freebuddy/workflow-core";
import type { WorkflowRuntimePorts } from "./ports.js";

type CliEvent =
  | { type: "started"; pid?: number }
  | { type: "stdout"; content: string }
  | { type: "stderr"; content: string }
  | { type: "items"; items: unknown[] }
  | { type: "done"; exitCode?: number }
  | { type: "error"; message: string }
  | { type: "yielded" }
  | { type: string; [key: string]: unknown };

function telemetryDurationMs(startedAt?: string, endedAt = Date.now()): number {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(started) ? Math.max(0, endedAt - started) : 0;
}

export interface ResolvedAgent {
  adapter: string;
  agentName: string;
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  skillIds?: string[];
}

export type { WorkflowRuntimePorts };

interface ActiveRun {
  paused: boolean;
  stopped: boolean;
  approvedPhases: Set<string>;
  activeSessions: Set<string>;
  /** Write steps may run without a prior manual gate (implement-first loops). */
  allowImmediateWrite: boolean;
  telemetryStartedAt: number;
}

function workflowTemplate(value?: string): string {
  return value === "review-loop" ||
    value === "implement-review-loop" ||
    value === "custom"
    ? value
    : "unknown";
}

function workflowTeamSource(snapshot?: string): string {
  if (!snapshot) return "none";
  try {
    const source = (JSON.parse(snapshot) as { source?: unknown }).source;
    return source === "builtin" || source === "user" ? source : "unknown";
  } catch {
    return "unknown";
  }
}

const REVIEW_LOOP_PHASES = ["review", "implement", "verify"];
const IMPLEMENT_REVIEW_LOOP_PHASES = ["implement", "review", "verify", "summarize"];

function hasWriteApproval(state: ActiveRun): boolean {
  return state.allowImmediateWrite || state.approvedPhases.size > 0;
}

function phaseRequiresEntryApproval(phase: WorkflowPhase): boolean {
  return (
    phase.gate?.type === "manual_approval" &&
    phase.steps.some((step) => step.mode === "write")
  );
}

function findPlanStep(plan: WorkflowPlan, stepId: string): WorkflowStep | undefined {
  for (const phase of plan.phases) {
    const step = phase.steps.find((s) => s.id === stepId);
    if (step) return step;
  }
  return undefined;
}

function hasRunnablePhaseAfter(
  plan: WorkflowPlan,
  phaseId: string,
  ignoredPhaseIds = new Set(["loop_or_finish"])
): boolean {
  const phaseIndex = plan.phases.findIndex((phase) => phase.id === phaseId);
  if (phaseIndex < 0) return false;
  return plan.phases
    .slice(phaseIndex + 1)
    .some((phase) => !ignoredPhaseIds.has(phase.id) && phase.steps.length > 0);
}

function extractStepOutputFromResultJson(resultJson: string | undefined): string | undefined {
  if (!resultJson) return undefined;
  try {
    const parsed = JSON.parse(resultJson) as { items?: unknown[] };
    const output = extractVisibleStepOutput(parsed.items ?? []).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

const MAX_LOOP_FEEDBACK_CHARS = 12_000;
const LOOP_FEEDBACK_TRUNCATION_MARKER =
  "\n\n...[truncated for next workflow round]...\n\n";

function boundedLoopFeedback(text: string): string {
  if (text.length <= MAX_LOOP_FEEDBACK_CHARS) return text;
  const available = MAX_LOOP_FEEDBACK_CHARS - LOOP_FEEDBACK_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(available * 0.65);
  const tailChars = available - headChars;
  return `${text.slice(0, headChars)}${LOOP_FEEDBACK_TRUNCATION_MARKER}${text.slice(
    -tailChars
  )}`;
}

function workflowStepToolSessionScope(
  runId: string,
  step: WorkflowStepRow
): string {
  return `workflow:${runId}:${step.stepId}:${step.agentId}`;
}

function shouldResumeWorkflowStep(
  plan: WorkflowPlan,
  step: WorkflowStepRow
): boolean {
  // Each implement-review round may contain a large tool transcript. Start
  // that step in a fresh ACP session and carry only the bounded review/
  // verification feedback through the workflow prompt. Reusing the prior
  // session makes context grow across rounds until the model rejects it.
  if (
    isImplementReviewLoopPlan(plan) &&
    step.stepId === IMPLEMENT_REVIEW_STEP_ID
  ) {
    return false;
  }
  return (
    Boolean(step.toolSessionId) &&
    step.prompt.includes("User requested changes before approval:")
  );
}

type ImplementReviewCheckpoint =
  | { action: "continue" }
  | {
      action: "loop";
      feedback: string;
      feedbackKind: "review" | "verification";
      reviewStatus?: string;
    }
  | {
      action: "partial";
      reviewStatus?: string;
      loopDecision?: string;
    }
  | {
      action: "finish";
      reviewStatus?: string;
      loopDecision?: string;
    };

function promptAttachmentsFromConversation(
  ports: WorkflowRuntimePorts,
  conversationId: string | undefined
): Array<{ path: string; kind?: string; mimeType?: string; name?: string }> | undefined {
  if (!conversationId) return undefined;
  const userMessage = ports.conversations.listMessages(conversationId).find(
    (message) => message.role === "user" && message.attachments?.length
  );
  if (!userMessage?.attachments?.length) return undefined;
  return userMessage.attachments.map((attachment) => ({
    path: attachment.path,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    name: attachment.name
  }));
}

function resetWorkflowStepForRetry(ports: WorkflowRuntimePorts, stepRowId: string): void {
  ports.repository.updateStep(stepRowId, {
    status: "pending",
    summary: null,
    resultJson: null,
    cliTaskId: null,
    startedAt: null,
    endedAt: null
  });
}

function appendGateChangeFeedback(prompt: string, feedback: string): string {
  return [
    prompt.trimEnd(),
    "",
    "User requested changes before approval:",
    feedback.trim(),
    "",
    "Continue from the existing planning context and revise the plan to address this feedback. Do not modify files."
  ].join("\n");
}

function markRunningWorkflowStepsStopped(ports: WorkflowRuntimePorts, runId: string, endedAt: string): void {
  for (const step of ports.repository.getSteps(runId)) {
    if (step.status !== "running") continue;
    ports.repository.updateStep(step.id, {
      status: "failed",
      summary: step.summary ?? "Stopped by user.",
      endedAt
    });
  }
}

export class WorkflowRuntime {
  private active = new Map<string, ActiveRun>();

  constructor(private deps: WorkflowRuntimePorts) {}

  /** Persist a plan as a pending-approval run. Validates first. */
  createPendingRun(input: {
    conversationId?: string;
    teamId?: string;
    teamSnapshotJson?: string;
    planVersion?: number;
    plan: WorkflowPlan;
    agents: WorkflowAgentRef[];
  }): { ok: true; run: WorkflowRunRow } | { ok: false; errors: string[] } {
    if (
      input.conversationId &&
      !this.deps.conversations.requireOwned?.(input.conversationId)
    ) {
      return { ok: false, errors: ["conversation not found"] };
    }
    const validation = validateWorkflowPlan(input.plan, input.agents);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    const run = this.deps.repository.createRun({
      id: randomUUID(),
      conversationId: input.conversationId,
      teamId: input.teamId,
      teamSnapshotJson: input.teamSnapshotJson,
      planVersion: input.planVersion,
      name: input.plan.name,
      goal: input.plan.goal,
      cwd: input.plan.cwd,
      template: input.plan.template,
      maxLoops: isImplementReviewLoopPlan(input.plan)
        ? Math.max(input.plan.maxLoops ?? 5, 2)
        : (input.plan.maxLoops ?? 1),
      planJson: JSON.stringify(input.plan)
    });
    this.seedSteps(run.id, input.plan);
    return { ok: true, run };
  }

  private seedSteps(runId: string, plan: WorkflowPlan): void {
    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        const resolved = this.deps.resolveAgent(step.agentId);
        if (!resolved) continue;
        this.deps.repository.createStep({
          id: randomUUID(),
          workflowRunId: runId,
          phaseId: phase.id,
          stepId: step.id,
          title: step.title,
          agentId: step.agentId,
          agentName: resolved.agentName,
          adapter: resolved.adapter,
          mode: step.mode,
          prompt: step.prompt,
          dependsOn: step.dependsOn,
          targetPaths: step.targetPaths
        });
      }
    }
  }

  getRun(runId: string): WorkflowRunRow | undefined {
    return this.deps.repository.getRun(runId);
  }

  getSteps(runId: string): WorkflowStepRow[] {
    return this.deps.repository.getSteps(runId);
  }

  // getWorkflowRun resolves only for callers that own the run's conversation,
  // so it doubles as the control-path gate for pause/stop/retry/approve.
  private callerControlsRun(runId: string): boolean {
    return this.deps.repository.getRun(runId) !== undefined;
  }

  async start(runId: string): Promise<void> {
    const run = this.deps.repository.getRun(runId);
    if (!run) throw new Error(`workflow run ${runId} not found`);
    if (this.active.has(runId)) return;
    const plan = JSON.parse(run.planJson) as WorkflowPlan;
    const resolvedPlan = this.resolveWorkflowPlan(run, plan);
    const telemetryStartedAt = Date.now();
    this.active.set(runId, {
      paused: false,
      stopped: false,
      approvedPhases: new Set(),
      activeSessions: new Set(),
      allowImmediateWrite: isImplementReviewLoopPlan(resolvedPlan),
      telemetryStartedAt
    });
    this.deps.repository.updateRun(runId, { status: "running" });
    if (run.status === "pending_approval") {
      const allSteps = resolvedPlan.phases.flatMap((phase) => phase.steps);
      this.deps.telemetry.track("workflow_run_started", {
        team_source: workflowTeamSource(run.teamSnapshotJson),
        template: workflowTemplate(run.template ?? resolvedPlan.template),
        phase_count: resolvedPlan.phases.length,
        step_count: allSteps.length,
        agent_count: new Set(allSteps.map((step) => step.agentId)).size,
        has_workspace: Boolean(run.cwd),
        max_loops: run.maxLoops
      });
    }
    try {
      await this.drive(runId);
    } catch (err) {
      this.trackWorkflowFinished(runId, resolvedPlan, "failed");
      this.deps.repository.updateRun(runId, {
        status: "failed",
        endedAt: new Date().toISOString(),
        summary: `Workflow error: ${(err as Error).message}`
      });
    } finally {
      this.active.delete(runId);
    }
  }

  approveGate(runId: string, phaseId: string): boolean {
    if (!this.callerControlsRun(runId)) return false;
    const run = this.active.get(runId);
    if (!run) return false;
    run.approvedPhases.add(phaseId);
    this.deps.repository.updateRun(runId, { status: "running" });
    return true;
  }

  async requestGateChanges(
    runId: string,
    phaseId: string,
    feedback: string
  ): Promise<boolean> {
    const trimmed = feedback.trim();
    if (!trimmed) return false;
    const run = this.deps.repository.getRun(runId);
    if (!run) return false;
    const plan = this.resolveWorkflowPlan(run);
    const gateIndex = plan.phases.findIndex((phase) => phase.id === phaseId);
    if (gateIndex < 0) return false;
    const gatePhase = plan.phases[gateIndex];
    const targetIndex = phaseRequiresEntryApproval(gatePhase)
      ? gateIndex - 1
      : gateIndex;
    const targetPhase = plan.phases[targetIndex];
    if (!targetPhase) return false;

    const active = this.active.get(runId);
    if (active) {
      active.stopped = true;
      for (let i = 0; i < 30 && this.active.has(runId); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    const replayPhaseIds = plan.phases
      .slice(targetIndex)
      .map((phase) => phase.id);
    const steps = this.deps.repository.getSteps(runId);
    const replayStepIds = new Set(
      plan.phases
        .slice(targetIndex)
        .flatMap((phase) => phase.steps.map((step) => step.id))
    );
    const targetStepIds = new Set(targetPhase.steps.map((step) => step.id));
    const nextPlan: WorkflowPlan = {
      ...plan,
      phases: plan.phases.map((phase) => {
        if (phase.id !== targetPhase.id) return phase;
        return {
          ...phase,
          steps: phase.steps.map((step) => ({
            ...step,
            prompt: targetStepIds.has(step.id)
              ? appendGateChangeFeedback(step.prompt, trimmed)
              : step.prompt
          }))
        };
      })
    };

    for (const step of steps) {
      if (!replayPhaseIds.includes(step.phaseId) && !replayStepIds.has(step.stepId)) {
        continue;
      }
      const planStep = findPlanStep(nextPlan, step.stepId);
      this.deps.repository.updateStep(step.id, {
        status: "pending",
        prompt: targetStepIds.has(step.stepId)
          ? appendGateChangeFeedback(step.prompt, trimmed)
          : (planStep?.prompt ?? step.prompt),
        summary: null,
        resultJson: null,
        cliTaskId: null,
        startedAt: null,
        endedAt: null
      });
    }

    this.deps.repository.updateRun(runId, {
      status: "running",
      planJson: JSON.stringify(nextPlan),
      endedAt: null
    });
    void this.start(runId);
    return true;
  }

  pause(runId: string): void {
    if (!this.callerControlsRun(runId)) return;
    const run = this.active.get(runId);
    if (run) run.paused = true;
    this.deps.repository.updateRun(runId, { status: "paused" });
  }

  resume(runId: string): Promise<void> {
    if (!this.callerControlsRun(runId)) return Promise.resolve();
    const active = this.active.get(runId);
    if (active) {
      active.paused = false;
      this.deps.repository.updateRun(runId, { status: "running" });
      return Promise.resolve();
    }

    const run = this.deps.repository.getRun(runId);
    if (!run) return Promise.resolve();
    const plan = this.resolveWorkflowPlan(run);
    if (run.status === "blocked" || run.status === "paused" || run.status === "running") {
      this.prepareInactiveRunForResume(runId, plan);
    }
    return this.start(runId);
  }

  private prepareInactiveRunForResume(
    runId: string,
    plan: WorkflowPlan
  ): void {
    const steps = this.deps.repository.getSteps(runId);
    const states = steps.map((s) => ({
      id: s.id,
      phaseId: s.phaseId,
      stepId: s.stepId,
      status: s.status
    }));
    const phaseIndex = findResumePhaseIndex(
      plan,
      states.map((s) => ({
        stepId: s.stepId,
        phaseId: s.phaseId,
        status: s.status
      }))
    );
    const phase = plan.phases[phaseIndex];
    if (!phase) return;
    for (const stepRowId of resumableStepRowIds(phase.id, states)) {
      resetWorkflowStepForRetry(this.deps, stepRowId);
    }
  }

  stop(runId: string): void {
    if (!this.callerControlsRun(runId)) return;
    const run = this.active.get(runId);
    const endedAt = new Date().toISOString();
    if (run) {
      run.stopped = true;
      for (const sessionId of run.activeSessions) {
        try {
          this.deps.killSession?.(sessionId);
        } catch {
          /* noop */
        }
      }
    }
    const persisted = this.deps.repository.getRun(runId);
    if (persisted) {
      const plan = JSON.parse(persisted.planJson) as WorkflowPlan;
      this.trackWorkflowFinished(runId, plan, "killed");
    }
    markRunningWorkflowStepsStopped(this.deps, runId, endedAt);
    this.deps.repository.updateRun(runId, {
      status: "killed",
      endedAt
    });
    this.active.delete(runId);
  }

  async retryStep(runId: string, stepRowId: string): Promise<void> {
    // getWorkflowSteps is caller-scoped, so this also rejects a step row that
    // belongs to a different (possibly another user's) run.
    if (!this.deps.repository.getSteps(runId).some((step) => step.id === stepRowId)) return;
    // Mark the failed step pending again and re-drive. Retry creates a new
    // CLI task (new sessionId) rather than mutating the old task record.
    resetWorkflowStepForRetry(this.deps, stepRowId);
    this.deps.repository.updateRun(runId, { status: "running" });
    await this.start(runId);
  }

  continueImplementReview(runId: string): boolean {
    const run = this.deps.repository.getRun(runId);
    if (!run || run.status !== "partial") return false;
    const plan = this.resolveWorkflowPlan(run);
    if (!isImplementReviewLoopPlan(plan)) return false;
    const steps = this.deps.repository.getSteps(runId);
    const reviewer = steps.find((s) => s.stepId === REVIEW_CHANGES_STEP_ID);
    const verifier = steps.find((s) => s.stepId === VERIFY_CHANGES_STEP_ID);
    const reviewDecisionText = resolveReviewDecisionText(
      reviewer?.summary,
      reviewer?.resultJson
    );
    const verifierNeedsRetry = verifierHasUnresolved(verifier?.summary);
    if (
      extractReviewStatus(reviewDecisionText) !== "FAIL" &&
      !verifierNeedsRetry
    ) {
      return false;
    }

    const nextMaxLoops = Math.max(run.maxLoops + 1, run.loopIndex + 2);
    const nextPlan = {
      ...plan,
      maxLoops: nextMaxLoops
    };
    this.prepareImplementReviewLoopReplay(
      runId,
      nextPlan,
      verifierNeedsRetry ? verifier?.summary : reviewDecisionText,
      verifierNeedsRetry ? "verification" : "review"
    );
    this.deps.repository.resetStepsForLoop(runId, IMPLEMENT_REVIEW_LOOP_PHASES);
    this.deps.repository.updateRun(runId, {
      status: "running",
      maxLoops: nextMaxLoops,
      planJson: JSON.stringify(nextPlan),
      summary: null,
      endedAt: null
    });
    void this.start(runId);
    return true;
  }

  private resolveWorkflowPlan(
    run: WorkflowRunRow,
    plan?: WorkflowPlan
  ): WorkflowPlan {
    const parsed =
      plan ?? (JSON.parse(run.planJson) as WorkflowPlan);
    if (parsed.template) return parsed;
    if (run.template === "implement-review-loop") {
      return { ...parsed, template: "implement-review-loop" };
    }
    return parsed;
  }

  private async drive(runId: string): Promise<void> {
    let run = this.deps.repository.getRun(runId);
    if (!run) return;
    const plan = this.resolveWorkflowPlan(run);
    const state = this.active.get(runId)!;

    const stepRows = this.deps.repository.getSteps(runId);
    let phaseIndex = findResumePhaseIndex(
      plan,
      stepRows.map((s) => ({
        stepId: s.stepId,
        phaseId: s.phaseId,
        status: s.status
      }))
    );
    // Labeled outer loop so the Review Loop can replay review/implement/verify.
    outer: while (true) {
      while (phaseIndex < plan.phases.length) {
        if (state.stopped) return;
        const phase = plan.phases[phaseIndex];

        if (
          phaseRequiresEntryApproval(phase) &&
          !state.approvedPhases.has(phase.id)
        ) {
          this.deps.repository.updateRun(runId, { status: "paused" });
          while (!state.approvedPhases.has(phase.id) && !state.stopped) {
            await new Promise((r) => setTimeout(r, 200));
          }
          if (state.stopped) return;
          this.deps.repository.updateRun(runId, { status: "running" });
        }

        // Run this phase's steps to completion. Returns false if a step failed
        // or is blocked, in which case we halt the run for a user decision.
        const completed = await this.runPhase(runId, run, plan, phase, state);
        if (state.stopped) return;
        if (!completed) {
          const failed = this.deps.repository
            .getSteps(runId)
            .some((step) => step.status === "failed");
          if (failed) {
            this.finalize(runId, plan, "failed");
          } else {
            this.deps.repository.updateRun(runId, { status: "blocked" });
          }
          return;
        }

        // Evaluate the phase gate before advancing. For a manual gate we keep
        // the run's ActiveRun alive (spin-wait) so approveGate() can record
        // approval and we can observe it here.
        const gateConfig = phase.gate;
        const reviewerStepStatus =
          gateConfig?.type === "review_required"
            ? this.deps.repository.getSteps(runId).find(
                (s) => s.stepId === gateConfig.reviewerStepId
              )?.status
            : undefined;
        const gate = phaseGateSatisfied(gateConfig, {
          approvedPhases: state.approvedPhases,
          phaseId: phase.id,
          reviewerStepStatus
        });
        if (gate.pause) {
          if (gateConfig?.type === "manual_approval") {
            this.deps.repository.updateRun(runId, { status: "paused" });
            while (!state.approvedPhases.has(phase.id) && !state.stopped) {
              await new Promise((r) => setTimeout(r, 200));
            }
            if (state.stopped) return;
          } else {
            this.deps.repository.updateRun(runId, { status: "blocked" });
            return;
          }
        }

        if (isImplementReviewLoopPlan(plan)) {
          const checkpoint = this.evaluateImplementReviewCheckpoint(
            runId,
            run,
            plan,
            phase.id
          );
          if (checkpoint.action === "loop") {
            this.prepareImplementReviewLoopReplay(
              runId,
              plan,
              checkpoint.feedback,
              checkpoint.feedbackKind
            );
            this.deps.repository.resetStepsForLoop(runId, IMPLEMENT_REVIEW_LOOP_PHASES);
            const implementIdx = plan.phases.findIndex((p) => p.id === "implement");
            this.deps.repository.updateRun(runId, {
              status: "running",
              loopIndex: run.loopIndex + 1
            });
            run = this.deps.repository.getRun(runId) ?? run;
            phaseIndex = implementIdx >= 0 ? implementIdx : 0;
            continue outer;
          }
          if (checkpoint.action === "partial") {
            this.finalize(runId, plan, "partial", {
              loopDecision: checkpoint.loopDecision ?? "partial",
              reviewStatus: checkpoint.reviewStatus,
              loopIndex: run.loopIndex,
              maxLoops: run.maxLoops
            });
            return;
          }
          if (checkpoint.action === "finish") {
            this.finalize(runId, plan, "completed", {
              loopDecision: checkpoint.loopDecision ?? "finish",
              reviewStatus: checkpoint.reviewStatus,
              loopIndex: run.loopIndex,
              maxLoops: run.maxLoops
            });
            return;
          }
        }

        phaseIndex += 1;
      }

      // All phases complete. Decide Review Loop outcome (no recursive start).
      const refreshed = this.deps.repository.getRun(runId);
      if (refreshed) run = refreshed;
      if (plan.template === "review-loop") {
        const verifier = this.deps.repository.getSteps(runId).find(
          (s) => s.stepId === "verify-changes"
        );
        const decision = decideReviewLoop(
          verifier?.status,
          verifierHasUnresolved(verifier?.summary),
          run.loopIndex,
          run.maxLoops
        );
        if (decision === "loop") {
          state.approvedPhases.clear();
          this.deps.repository.resetStepsForLoop(runId, REVIEW_LOOP_PHASES);
          const reviewIdx = plan.phases.findIndex((p) => p.id === "review");
          this.deps.repository.updateRun(runId, {
            status: "running",
            loopIndex: run.loopIndex + 1
          });
          phaseIndex = reviewIdx >= 0 ? reviewIdx : 0;
          continue outer;
        }
        this.finalize(runId, plan, decision === "partial" ? "partial" : "completed");
        return;
      }

      if (isImplementReviewLoopPlan(plan)) {
        this.finalize(runId, plan, "completed");
        return;
      }

      this.finalize(runId, plan, "completed");
      return;
    }
  }

  private evaluateImplementReviewCheckpoint(
    runId: string,
    run: WorkflowRunRow,
    plan: WorkflowPlan,
    phaseId: string
  ): ImplementReviewCheckpoint {
    const steps = this.deps.repository.getSteps(runId);
    if (phaseId === "review") {
      const reviewer = steps.find((s) => s.stepId === REVIEW_CHANGES_STEP_ID);
      const reviewDecisionText = resolveReviewDecisionText(
        reviewer?.summary,
        reviewer?.resultJson
      );
      const reviewStatus = extractReviewStatus(reviewDecisionText);
      const decision = decideImplementReviewLoop(
        reviewer?.status,
        reviewDecisionText,
        run.loopIndex,
        run.maxLoops
      );
      if (decision === "loop") {
        return {
          action: "loop",
          feedback: reviewDecisionText ?? reviewer?.summary ?? "",
          feedbackKind: "review",
          reviewStatus
        };
      }
      if (decision === "partial") {
        return { action: "partial", loopDecision: decision, reviewStatus };
      }
      const hasLaterWork =
        Boolean(findPlanStep(plan, VERIFY_CHANGES_STEP_ID)) ||
        hasRunnablePhaseAfter(plan, phaseId);
      return hasLaterWork
        ? { action: "continue" }
        : { action: "finish", loopDecision: decision, reviewStatus };
    }

    if (phaseId === "verify") {
      const verifier = steps.find((s) => s.stepId === VERIFY_CHANGES_STEP_ID);
      if (!verifier) return { action: "continue" };
      const foundUnresolved = verifierHasUnresolved(verifier?.summary);
      if (verifier.status !== "done") {
        return { action: "partial", loopDecision: "partial" };
      }
      if (!foundUnresolved) return { action: "continue" };
      if (run.loopIndex + 1 < run.maxLoops) {
        return {
          action: "loop",
          feedback: verifier.summary ?? "",
          feedbackKind: "verification"
        };
      }
      return { action: "partial", loopDecision: "partial" };
    }

    return { action: "continue" };
  }

  /** Inject prior feedback into the implement step before the next loop. */
  private prepareImplementReviewLoopReplay(
    runId: string,
    plan: WorkflowPlan,
    feedback: string | undefined,
    feedbackKind: "review" | "verification" = "review"
  ): void {
    if (!feedback?.trim()) return;
    const steps = this.deps.repository.getSteps(runId);
    const implRow = steps.find((s) => s.stepId === IMPLEMENT_REVIEW_STEP_ID);
    const planStep = findPlanStep(plan, IMPLEMENT_REVIEW_STEP_ID);
    if (!implRow || !planStep) return;
    const base = planStep.prompt;
    const label =
      feedbackKind === "verification"
        ? "verification feedback from the previous round"
        : "review feedback from the previous round";
    const augmented =
      `${base}\n\nAddress the following ${label}:\n` +
      `${boundedLoopFeedback(feedback.trim())}`;
    this.deps.repository.updateStep(implRow.id, { prompt: augmented });
  }

  private async runPhase(
    runId: string,
    run: WorkflowRunRow,
    plan: WorkflowPlan,
    phase: WorkflowPhase,
    state: ActiveRun
  ): Promise<boolean> {
    // Returns true when every step in this phase reached a terminal-ok status
    // (done|skipped). Returns false if the phase cannot make progress because a
    // step failed or is blocked by an unsatisfiable dependency.
    while (true) {
      if (state.stopped) return false;
      // Respect user-initiated pause: hold without starting new steps.
      while (state.paused && !state.stopped) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (state.stopped) return false;

      const steps = this.deps.repository.getSteps(runId);
      const states = steps.map((s) => ({ stepId: s.stepId, status: s.status }));
      const writeBusy = steps.some(
        (s) => s.status === "running" && s.mode === "write"
      );
      const runnable = selectRunnableSteps(plan, states, {
        writeBusy,
        writeApproved: hasWriteApproval(state)
      }).filter((r) => r.phaseId === phase.id);

      if (runnable.length === 0) {
        const phaseSteps = steps.filter((s) => s.phaseId === phase.id);
        const allTerminalOk = phaseSteps.every(
          (s) => s.status === "done" || s.status === "skipped"
        );
        return allTerminalOk; // true = phase complete; false = blocked/failed
      }

      await Promise.all(
        runnable.map((r) => this.executeStep(runId, run, plan, r.stepId, state))
      );
    }
  }

  private async executeStep(
    runId: string,
    run: WorkflowRunRow,
    plan: WorkflowPlan,
    stepId: string,
    state: ActiveRun
  ): Promise<void> {
    const steps = this.deps.repository.getSteps(runId);
    const step = steps.find((s) => s.stepId === stepId);
    if (!step || step.status === "done" || step.status === "skipped") return;
    if (step.status === "running") return;
    if (step.mode === "write" && !hasWriteApproval(state)) {
      this.deps.repository.updateStep(step.id, {
        status: "blocked",
        endedAt: new Date().toISOString()
      });
      return;
    }

    const resolved = this.deps.resolveAgent(step.agentId);
    if (!resolved) {
      this.deps.repository.updateStep(step.id, { status: "failed", endedAt: new Date().toISOString() });
      return;
    }

    const planStep = findPlanStep(plan, stepId);
    const stepsById = new Map(
      steps.map((s) => [
        s.stepId,
        {
          stepId: s.stepId,
          title: s.title,
          summary: s.summary,
          output: extractStepOutputFromResultJson(s.resultJson)
        }
      ])
    );
    const prompt = augmentPromptWithConsumedSummaries(
      step.prompt,
      planStep?.consumes,
      stepsById
    );
    const localizedPrompt = applyWorkflowLanguagePreference(prompt, this.deps.language.getLanguage());

    const sessionId = randomUUID();
    const toolSessionScope = workflowStepToolSessionScope(runId, step);
    const resumeToolSession = shouldResumeWorkflowStep(plan, step);
    const toolSessionId = resumeToolSession
      ? step.toolSessionId ??
        this.deps.toolSessions?.get(step.agentId, toolSessionScope)?.sessionId
      : undefined;
    const collected: unknown[] = [];
    let exitCode: number | null = null;
    let errored: string | null = null;
    let messageFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let hasPendingMessageUpdate = false;

    const flushMessageUpdate = () => {
      if (messageFlushTimer) {
        clearTimeout(messageFlushTimer);
        messageFlushTimer = undefined;
      }
      if (!hasPendingMessageUpdate || !assistantMessageId || !run.conversationId) return;
      hasPendingMessageUpdate = false;
      this.deps.conversations.updateMessage?.({
        id: assistantMessageId,
        content: JSON.stringify(collected)
      });
      this.broadcastMessageEvent({
        type: "updated",
        conversationId: run.conversationId,
        messageId: assistantMessageId
      });
    };

    const scheduleMessageUpdate = () => {
      if (!assistantMessageId || !run.conversationId) return;
      hasPendingMessageUpdate = true;
      if (messageFlushTimer) return;
      messageFlushTimer = setTimeout(flushMessageUpdate, 300);
    };

    this.deps.repository.updateStep(step.id, {
      status: "running",
      cliTaskId: sessionId,
      startedAt: new Date().toISOString()
    });
    state.activeSessions.add(sessionId);

    // Post a placeholder assistant message into the conversation so the chat
    // pane shows progress for this step in real time. Use the workflow plan's
    // role label (step.title) so the bubble capsule reads e.g. "RESEARCH CONTEXT · 运行中".
    let assistantMessageId: string | undefined;
    if (run.conversationId) {
      assistantMessageId = randomUUID();
      this.deps.conversations.appendMessage({
        id: assistantMessageId,
        conversationId: run.conversationId,
        role: "assistant",
        status: "running",
        content: "[]",
        taskId: sessionId,
        agentId: step.agentId,
        agentName: resolved.agentName,
        adapter: resolved.adapter,
        roleLabel: step.title,
        workflowRunId: runId,
        workflowStepRowId: step.id
      });
      this.broadcastMessageEvent({
        type: "appended",
        conversationId: run.conversationId,
        messageId: assistantMessageId
      });
    }

    try {
      await this.deps.executor.run({
        sessionId,
        conversationId: run.conversationId,
        agentId: step.agentId,
        agentName: resolved.agentName,
        adapter: resolved.adapter,
        binary: resolved.binary,
        extraArgs: resolved.extraArgs,
        env: resolved.env,
        configOptionOverrides: planStep?.configOptionOverrides,
        skillIds: planStep?.skillIds ?? resolved.skillIds ?? [],
        prompt: localizedPrompt,
        promptAttachments: promptAttachmentsFromConversation(this.deps, run.conversationId),
        toolSessionScope,
        toolSessionId,
        resumeToolSession,
        cwd: run.cwd,
        onEvent: (e) => {
          if (
            run.conversationId &&
            (e.type === "permission" ||
              e.type === "permission-resolved" ||
              e.type === "authentication" ||
              e.type === "authentication-resolved" ||
              e.type === "authentication-terminal-started" ||
              e.type === "authentication-terminal-update" ||
              e.type === "authentication-terminal-resolved")
          ) {
            this.broadcastWorkflowEvent({
              conversationId: run.conversationId,
              sessionId,
              event: e
            });
          }
          if (e.type === "items" && e.items?.length) {
            collected.push(...e.items);
            scheduleMessageUpdate();
          }
          if (e.type === "done") exitCode = e.exitCode ?? null;
          if (e.type === "error") errored = e.message ?? null;
        }
      });
    } catch (err) {
      errored = (err as Error).message;
    } finally {
      flushMessageUpdate();
      state.activeSessions.delete(sessionId);
    }

    if (state.stopped) return;

    const capturedToolSessionId =
      this.deps.toolSessions?.get(step.agentId, toolSessionScope)?.sessionId ??
      step.toolSessionId;
    errored = resolveAgentRunError(collected, errored, exitCode);
    const decisionText = reviewDecisionTextFromItems(collected);
    const failed = errored !== null || (exitCode !== null && exitCode !== 0);
    let summary = ensureReviewStatusInSummary(
      deriveStepSummary(collected),
      decisionText
    );
    let stepStatus: WorkflowStepRow["status"] = failed ? "failed" : "done";
    if (
      isImplementReviewLoopPlan(plan) &&
      stepId === REVIEW_CHANGES_STEP_ID &&
      extractReviewStatus(decisionText) !== undefined
    ) {
      stepStatus = "done";
    }
    this.deps.repository.updateStep(step.id, {
      status: stepStatus,
      summary,
      resultJson: JSON.stringify({ items: collected, exitCode, error: errored }),
      ...(capturedToolSessionId ? { toolSessionId: capturedToolSessionId } : {}),
      endedAt: new Date().toISOString()
    });

    if (assistantMessageId && run.conversationId) {
      this.deps.conversations.updateMessage?.({
        id: assistantMessageId,
        status: stepStatus === "failed" ? "failed" : "done",
        content: JSON.stringify(collected)
      });
      this.broadcastMessageEvent({
        type: "updated",
        conversationId: run.conversationId,
        messageId: assistantMessageId
      });
    }
  }

  private broadcastMessageEvent(payload: {
    type: "appended" | "updated";
    conversationId: string;
    messageId: string;
  }): void {
    this.deps.events.publish(`workflow://message/${payload.conversationId}`,
      payload
    );
  }

  private broadcastWorkflowEvent(payload: {
    conversationId: string;
    sessionId: string;
    event: CliEvent;
  }): void {
    this.deps.events.publish(`workflow://event/${payload.conversationId}`,
      payload
    );
  }

  private finalize(
    runId: string,
    plan: WorkflowPlan,
    status: WorkflowRunStatus,
    meta?: {
      loopDecision?: string;
      reviewStatus?: string;
      loopIndex?: number;
      maxLoops?: number;
    }
  ): void {
    const run = this.deps.repository.getRun(runId);
    if (!run) return;
    const steps = this.deps.repository.getSteps(runId);

    const summary = this.composeSummary(plan, steps, status, meta);
    this.trackWorkflowFinished(runId, plan, status, meta);
    this.deps.repository.updateRun(runId, {
      status,
      summary,
      endedAt: new Date().toISOString()
    });
  }

  private trackWorkflowFinished(
    runId: string,
    plan: WorkflowPlan,
    status: WorkflowRunStatus,
    meta?: { loopIndex?: number }
  ): void {
    if (!new Set<WorkflowRunStatus>(["completed", "failed", "killed", "partial"]).has(status)) {
      return;
    }
    const run = this.deps.repository.getRun(runId);
    if (!run || ["completed", "failed", "killed", "partial"].includes(run.status)) return;
    const steps = this.deps.repository.getSteps(runId);
    const startedAt = this.active.get(runId)?.telemetryStartedAt;
    this.deps.telemetry.track("workflow_run_finished", {
      status,
      duration_ms: startedAt
        ? Math.max(0, Date.now() - startedAt)
        : telemetryDurationMs(run.createdAt),
      team_source: workflowTeamSource(run.teamSnapshotJson),
      template: workflowTemplate(run.template ?? plan.template),
      step_count: steps.length,
      agent_count: new Set(steps.map((step) => step.agentId)).size,
      failed_step_count: steps.filter((step) => step.status === "failed").length,
      loop_count: Math.max(1, (meta?.loopIndex ?? run.loopIndex) + 1),
      max_loops: run.maxLoops,
      has_workspace: Boolean(run.cwd)
    });
    // Surface a task notification when a workflow run finishes, mirroring the
    // single-agent path. "killed" is a user-initiated stop, so skip it.
    if (status !== "killed") {
      this.deps.events.publish("workflow://finished", {
        runId,
        conversationId: run.conversationId,
        status,
        name: run.name
      });
    }
  }

  private composeSummary(
    plan: WorkflowPlan,
    steps: WorkflowStepRow[],
    status: WorkflowRunStatus,
    meta?: {
      loopDecision?: string;
      reviewStatus?: string;
      loopIndex?: number;
      maxLoops?: number;
    }
  ): string {
    const lines: string[] = [];
    lines.push(`Workflow ${status}: ${plan.name}`);
    lines.push(`Goal: ${plan.goal}`);
    if (meta?.loopDecision) {
      lines.push(
        `Loop decision: ${meta.loopDecision}` +
          (meta.reviewStatus ? ` (review=${meta.reviewStatus})` : "") +
          (meta.loopIndex != null && meta.maxLoops != null
            ? ` [round ${meta.loopIndex + 1}/${meta.maxLoops}]`
            : "")
      );
    }
    for (const phase of plan.phases) {
      lines.push(`\n• ${phase.title}`);
      for (const s of steps.filter((st) => st.phaseId === phase.id)) {
        lines.push(`  - [${s.status}] ${s.title}: ${s.summary ?? ""}`);
      }
    }
    return lines.join("\n");
  }
}

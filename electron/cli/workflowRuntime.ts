import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

import type { CliEvent, CliPromptAttachment, CliRunArgs } from "./runtimeShared.js";
import { cliRun, cliKill } from "./runtime.js";
import {
  appendMessage,
  listMessages,
  updateMessage
} from "./conversations.js";
import type {
  WorkflowAgentRef,
  WorkflowPhase,
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepRow
} from "./workflowTypes.js";
import {
  createWorkflowRun,
  createWorkflowStep,
  getWorkflowRun,
  getWorkflowSteps,
  resetWorkflowStepsForLoop,
  updateWorkflowRun,
  updateWorkflowStep
} from "./workflows.js";
import { validateWorkflowPlan } from "./workflowValidate.js";
import {
  isImplementReviewLoopPlan,
  IMPLEMENT_REVIEW_STEP_ID,
  REVIEW_CHANGES_STEP_ID,
  VERIFY_CHANGES_STEP_ID
} from "./workflowTemplates.js";
import {
  augmentPromptWithConsumedSummaries,
  collectDecisionTextFromItems,
  decideImplementReviewLoop,
  decideReviewLoop,
  deriveStepSummary,
  ensureReviewStatusInSummary,
  extractVisibleStepOutput,
  extractReviewStatus,
  findResumePhaseIndex,
  phaseGateSatisfied,
  resumableStepRowIds,
  resolveReviewDecisionText,
  selectRunnableSteps,
  verifierHasUnresolved
} from "./workflowScheduler.js";

export interface ResolvedAgent {
  adapter: string;
  agentName: string;
  binary?: string;
  extraArgs?: string[];
}

export interface StepExecutor {
  run(args: {
    sessionId: string;
    agentId: string;
    agentName: string;
    adapter: string;
    binary?: string;
    extraArgs?: string[];
    prompt: string;
    promptAttachments?: CliPromptAttachment[];
    cwd?: string;
    onEvent: (e: CliEvent) => void;
  }): Promise<void>;
}

export interface RuntimeDeps {
  executor: StepExecutor;
  resolveAgent: (agentId: string) => ResolvedAgent | undefined;
  /** Best-effort live-progress sink (may be undefined when headless). */
  webContents?: WebContents;
}

interface ActiveRun {
  paused: boolean;
  stopped: boolean;
  approvedPhases: Set<string>;
  activeSessions: Set<string>;
  /** Write steps may run without a prior manual gate (implement-first loops). */
  allowImmediateWrite: boolean;
}

const REVIEW_LOOP_PHASES = ["review", "implement", "verify"];
const IMPLEMENT_REVIEW_LOOP_PHASES = ["implement", "review", "verify", "summarize"];

function hasWriteApproval(state: ActiveRun): boolean {
  return state.allowImmediateWrite || state.approvedPhases.size > 0;
}

function findPlanStep(plan: WorkflowPlan, stepId: string): WorkflowStep | undefined {
  for (const phase of plan.phases) {
    const step = phase.steps.find((s) => s.id === stepId);
    if (step) return step;
  }
  return undefined;
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
  conversationId: string | undefined
): CliRunArgs["promptAttachments"] {
  if (!conversationId) return undefined;
  const userMessage = listMessages(conversationId).find(
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

export class WorkflowRuntime {
  private active = new Map<string, ActiveRun>();

  constructor(private deps: RuntimeDeps) {}

  /** Persist a plan as a pending-approval run. Validates first. */
  createPendingRun(input: {
    conversationId?: string;
    teamId?: string;
    teamSnapshotJson?: string;
    planVersion?: number;
    plan: WorkflowPlan;
    agents: WorkflowAgentRef[];
  }): { ok: true; run: WorkflowRunRow } | { ok: false; errors: string[] } {
    const validation = validateWorkflowPlan(input.plan, input.agents);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    const run = createWorkflowRun({
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
        createWorkflowStep({
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
    return getWorkflowRun(runId);
  }

  getSteps(runId: string): WorkflowStepRow[] {
    return getWorkflowSteps(runId);
  }

  async start(runId: string): Promise<void> {
    const run = getWorkflowRun(runId);
    if (!run) throw new Error(`workflow run ${runId} not found`);
    if (this.active.has(runId)) return;
    const plan = JSON.parse(run.planJson) as WorkflowPlan;
    const resolvedPlan = this.resolveWorkflowPlan(run, plan);
    this.active.set(runId, {
      paused: false,
      stopped: false,
      approvedPhases: new Set(),
      activeSessions: new Set(),
      allowImmediateWrite: isImplementReviewLoopPlan(resolvedPlan)
    });
    updateWorkflowRun(runId, { status: "running" });
    try {
      await this.drive(runId);
    } catch (err) {
      updateWorkflowRun(runId, {
        status: "failed",
        endedAt: new Date().toISOString(),
        summary: `Workflow error: ${(err as Error).message}`
      });
    } finally {
      this.active.delete(runId);
    }
  }

  approveGate(runId: string, phaseId: string): void {
    const run = this.active.get(runId);
    if (run) run.approvedPhases.add(phaseId);
  }

  pause(runId: string): void {
    const run = this.active.get(runId);
    if (run) run.paused = true;
    updateWorkflowRun(runId, { status: "paused" });
  }

  resume(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (active) {
      active.paused = false;
      updateWorkflowRun(runId, { status: "running" });
      return Promise.resolve();
    }

    const run = getWorkflowRun(runId);
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
    const steps = getWorkflowSteps(runId);
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
      updateWorkflowStep(stepRowId, {
        status: "pending",
        summary: null,
        resultJson: null,
        cliTaskId: null,
        startedAt: null,
        endedAt: null
      });
    }
  }

  stop(runId: string): void {
    const run = this.active.get(runId);
    if (run) {
      run.stopped = true;
      for (const sessionId of run.activeSessions) {
        try {
          cliKill(sessionId);
        } catch {
          /* noop */
        }
      }
    }
    updateWorkflowRun(runId, {
      status: "killed",
      endedAt: new Date().toISOString()
    });
    this.active.delete(runId);
  }

  async retryStep(runId: string, stepRowId: string): Promise<void> {
    // Mark the failed step pending again and re-drive. Retry creates a new
    // CLI task (new sessionId) rather than mutating the old task record.
    updateWorkflowStep(stepRowId, {
      status: "pending",
      summary: null,
      resultJson: null,
      cliTaskId: null,
      startedAt: null,
      endedAt: null
    });
    updateWorkflowRun(runId, { status: "running" });
    await this.start(runId);
  }

  continueImplementReview(runId: string): boolean {
    const run = getWorkflowRun(runId);
    if (!run || run.status !== "partial") return false;
    const plan = this.resolveWorkflowPlan(run);
    if (!isImplementReviewLoopPlan(plan)) return false;
    const steps = getWorkflowSteps(runId);
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
    resetWorkflowStepsForLoop(runId, IMPLEMENT_REVIEW_LOOP_PHASES);
    updateWorkflowRun(runId, {
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
    let run = getWorkflowRun(runId);
    if (!run) return;
    const plan = this.resolveWorkflowPlan(run);
    const state = this.active.get(runId)!;

    const stepRows = getWorkflowSteps(runId);
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

        // Run this phase's steps to completion. Returns false if a step failed
        // or is blocked, in which case we halt the run for a user decision.
        const completed = await this.runPhase(runId, run, plan, phase, state);
        if (state.stopped) return;
        if (!completed) {
          updateWorkflowRun(runId, { status: "blocked" });
          return;
        }

        // Evaluate the phase gate before advancing. For a manual gate we keep
        // the run's ActiveRun alive (spin-wait) so approveGate() can record
        // approval and we can observe it here.
        const gateConfig = phase.gate;
        const reviewerStepStatus =
          gateConfig?.type === "review_required"
            ? getWorkflowSteps(runId).find(
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
            updateWorkflowRun(runId, { status: "paused" });
            while (!state.approvedPhases.has(phase.id) && !state.stopped) {
              await new Promise((r) => setTimeout(r, 200));
            }
            if (state.stopped) return;
          } else {
            updateWorkflowRun(runId, { status: "blocked" });
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
            state.approvedPhases.clear();
            resetWorkflowStepsForLoop(runId, IMPLEMENT_REVIEW_LOOP_PHASES);
            const implementIdx = plan.phases.findIndex((p) => p.id === "implement");
            updateWorkflowRun(runId, {
              status: "running",
              loopIndex: run.loopIndex + 1
            });
            run = getWorkflowRun(runId) ?? run;
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
      const refreshed = getWorkflowRun(runId);
      if (refreshed) run = refreshed;
      if (plan.template === "review-loop") {
        const verifier = getWorkflowSteps(runId).find(
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
          resetWorkflowStepsForLoop(runId, REVIEW_LOOP_PHASES);
          const reviewIdx = plan.phases.findIndex((p) => p.id === "review");
          updateWorkflowRun(runId, {
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
    const steps = getWorkflowSteps(runId);
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
      const hasVerification = Boolean(findPlanStep(plan, VERIFY_CHANGES_STEP_ID));
      return hasVerification
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
    const steps = getWorkflowSteps(runId);
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
      `${feedback.trim()}`;
    updateWorkflowStep(implRow.id, { prompt: augmented });
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

      const steps = getWorkflowSteps(runId);
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
    const steps = getWorkflowSteps(runId);
    const step = steps.find((s) => s.stepId === stepId);
    if (!step || step.status === "done" || step.status === "skipped") return;
    if (step.status === "running") return;
    if (step.mode === "write" && !hasWriteApproval(state)) {
      updateWorkflowStep(step.id, {
        status: "blocked",
        endedAt: new Date().toISOString()
      });
      return;
    }

    const resolved = this.deps.resolveAgent(step.agentId);
    if (!resolved) {
      updateWorkflowStep(step.id, { status: "failed", endedAt: new Date().toISOString() });
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

    const sessionId = randomUUID();
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
      updateMessage({
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

    updateWorkflowStep(step.id, {
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
      appendMessage({
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
        agentId: step.agentId,
        agentName: resolved.agentName,
        adapter: resolved.adapter,
        binary: resolved.binary,
        extraArgs: resolved.extraArgs,
        prompt,
        promptAttachments: promptAttachmentsFromConversation(run.conversationId),
        cwd: run.cwd,
        onEvent: (e: CliEvent) => {
          if (e.type === "items" && e.items?.length) {
            collected.push(...e.items);
            scheduleMessageUpdate();
          }
          if (e.type === "done") exitCode = e.exitCode;
          if (e.type === "error") errored = e.message;
        }
      });
    } catch (err) {
      errored = (err as Error).message;
    } finally {
      flushMessageUpdate();
      state.activeSessions.delete(sessionId);
    }

    if (state.stopped) return;

    const decisionText = collectDecisionTextFromItems(collected);
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
    updateWorkflowStep(step.id, {
      status: stepStatus,
      summary,
      resultJson: JSON.stringify({ items: collected, exitCode, error: errored }),
      endedAt: new Date().toISOString()
    });

    if (assistantMessageId && run.conversationId) {
      updateMessage({
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
    const wc = this.deps.webContents;
    if (!wc || wc.isDestroyed?.()) return;
    try {
      wc.send(`workflow://message/${payload.conversationId}`, payload);
    } catch {
      /* noop */
    }
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
    const run = getWorkflowRun(runId);
    if (!run) return;
    const steps = getWorkflowSteps(runId);

    const summary = this.composeSummary(plan, steps, status, meta);
    updateWorkflowRun(runId, {
      status,
      summary,
      endedAt: new Date().toISOString()
    });
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

/** Production StepExecutor backed by the existing cliRun task runner. */
export function createCliStepExecutor(
  webContents: WebContents | undefined
): StepExecutor {
  return {
    async run(args) {
      if (!webContents) {
        throw new Error("workflow step execution requires an active window");
      }
      const runArgs: CliRunArgs = {
        sessionId: args.sessionId,
        agentId: args.agentId,
        agentName: args.agentName,
        adapter: args.adapter as any,
        binary: args.binary,
        extraArgs: args.extraArgs,
        prompt: args.prompt,
        promptAttachments: args.promptAttachments,
        cwd: args.cwd,
        approvalMode: "auto",
        resumeToolSession: false
      };
      await cliRun(webContents, runArgs, args.onEvent);
    }
  };
}

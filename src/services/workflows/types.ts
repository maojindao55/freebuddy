import type { TFunction } from "i18next";

export type WorkflowStepMode =
  | "research"
  | "review"
  | "write"
  | "verify"
  | "summarize";

export type WorkflowGate =
  | { type: "all_done" }
  | { type: "manual_approval"; reason: string }
  | { type: "review_required"; reviewerStepId: string };

export interface WorkflowStep {
  id: string;
  title: string;
  agentId: string;
  mode: WorkflowStepMode;
  prompt: string;
  model?: string;
  configOptionOverrides?: Record<string, string>;
  dependsOn?: string[];
  targetPaths?: string[];
  consumes?: string[];
}

export interface WorkflowPhase {
  id: string;
  title: string;
  description?: string;
  parallelism: number;
  steps: WorkflowStep[];
  gate?: WorkflowGate;
}

export interface WorkflowPlan {
  name: string;
  goal: string;
  cwd?: string;
  template?: "review-loop" | "implement-review-loop" | "custom";
  maxLoops?: number;
  phases: WorkflowPhase[];
}

export type WorkflowRunStatus =
  | "pending_approval"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "killed"
  | "partial";

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "blocked";

export interface WorkflowRunRow {
  id: string;
  conversationId?: string;
  teamId?: string;
  teamSnapshotJson?: string;
  planVersion?: number;
  name: string;
  goal: string;
  status: WorkflowRunStatus;
  cwd?: string;
  template?: string;
  loopIndex: number;
  maxLoops: number;
  planJson: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowStepRow {
  id: string;
  workflowRunId: string;
  phaseId: string;
  stepId: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  mode: WorkflowStepMode;
  status: WorkflowStepStatus;
  prompt: string;
  dependsOn?: string[];
  targetPaths?: string[];
  summary?: string;
  resultJson?: string;
  cliTaskId?: string;
  toolSessionId?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowValidationResult {
  ok: boolean;
  errors: string[];
}

export function workflowPhaseTitle(phase: Pick<WorkflowPhase, "id" | "title">, t: TFunction): string {
  return t(`workflow.phaseTitles.${phase.id}`, { defaultValue: phase.title });
}

export function workflowStepTitle(step: Pick<WorkflowStepRow, "stepId" | "title">, t: TFunction): string {
  return t(`workflow.stepTitles.${step.stepId}`, { defaultValue: step.title });
}

export function workflowFollowupAgentId(run: Pick<WorkflowRunRow, "planJson">): string | undefined {
  let plan: WorkflowPlan;
  try {
    plan = JSON.parse(run.planJson) as WorkflowPlan;
  } catch {
    return undefined;
  }

  for (let i = plan.phases.length - 1; i >= 0; i -= 1) {
    const phase = plan.phases[i];
    for (let j = phase.steps.length - 1; j >= 0; j -= 1) {
      const step = phase.steps[j];
      if (step.mode === "summarize") return step.agentId;
    }
  }

  for (let i = plan.phases.length - 1; i >= 0; i -= 1) {
    const phase = plan.phases[i];
    for (let j = phase.steps.length - 1; j >= 0; j -= 1) {
      const step = phase.steps[j];
      if (step.mode !== "write") return step.agentId;
    }
  }

  return undefined;
}

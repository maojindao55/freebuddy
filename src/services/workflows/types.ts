import type { TFunction } from "i18next";
import type {
  WorkflowPhase,
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowStep,
  WorkflowStepRow
} from "@freebuddy/protocol/workflow";

export type {
  WorkflowGate,
  WorkflowPhase,
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepMode,
  WorkflowStepRow,
  WorkflowStepStatus,
  WorkflowValidationResult
} from "@freebuddy/protocol/workflow";

export { workflowStepFailureReason } from "@freebuddy/protocol/workflow";

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

  if (!plan || !Array.isArray(plan.phases)) return undefined;
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

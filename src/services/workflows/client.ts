import type {
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowStepRow,
  WorkflowValidationResult
} from "./types";

function api() {
  const workflow = window.freebuddy?.workflow;
  if (!workflow) throw new Error("workflow bridge unavailable");
  return workflow;
}

export const workflowClient = {
  isAvailable(): boolean {
    return Boolean(window.freebuddy?.workflow);
  },
  validate(plan: WorkflowPlan): Promise<WorkflowValidationResult> {
    return api().validate(plan);
  },
  previewReviewLoop(input: {
    goal: string;
    cwd?: string;
    targetPaths?: string[];
  }) {
    return api().previewReviewLoop(input);
  },
  coordinatorPrompt(input: {
    goal: string;
    cwd?: string;
    targetPaths?: string[];
  }): Promise<string> {
    return api().coordinatorPrompt(input);
  },
  createRun(input: { conversationId?: string; plan: WorkflowPlan }) {
    return api().createRun(input);
  },
  start(runId: string): Promise<boolean> {
    return api().start(runId);
  },
  pause(runId: string): Promise<boolean> {
    return api().pause(runId);
  },
  resume(runId: string): Promise<void> {
    return api().resume(runId);
  },
  stop(runId: string): Promise<boolean> {
    return api().stop(runId);
  },
  retryStep(args: { runId: string; stepRowId: string }): Promise<void> {
    return api().retryStep(args);
  },
  approveGate(args: { runId: string; phaseId: string }): Promise<boolean> {
    return api().approveGate(args);
  },
  continueImplementReview(runId: string): Promise<boolean> {
    return api().continueImplementReview(runId);
  },
  getRun(runId: string): Promise<WorkflowRunRow | undefined> {
    return api().getRun(runId);
  },
  getSteps(runId: string): Promise<WorkflowStepRow[]> {
    return api().getSteps(runId);
  },
  listRuns(conversationId: string): Promise<WorkflowRunRow[]> {
    return api().listRuns(conversationId);
  }
};

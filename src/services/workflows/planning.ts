import type { WorkflowPhase, WorkflowStepStatus } from "./types";

/**
 * Find the phase id whose manual-approval gate is currently pending.
 *
 * Phases run sequentially, so the gating phase is the last (highest-index)
 * phase whose steps are ALL terminal-ok (done|skipped) and whose gate is
 * manual_approval. Returns undefined when no manual gate is currently pending
 * (e.g. the run is still executing, paused by the user, or at a non-manual gate).
 */
export function pendingManualGatePhaseId(
  phases: WorkflowPhase[],
  stepStatuses: Array<{ stepId: string; status: WorkflowStepStatus }>
): string | undefined {
  const statusByStep = new Map(stepStatuses.map((s) => [s.stepId, s.status]));
  const isTerminal = (st: WorkflowStepStatus | undefined) =>
    st === "done" || st === "skipped";
  let gatingId: string | undefined;
  for (const phase of phases) {
    const allTerminal = phase.steps.every((s) =>
      isTerminal(statusByStep.get(s.id))
    );
    if (!allTerminal) break;
    if (phase.gate?.type === "manual_approval") gatingId = phase.id;
  }
  return gatingId;
}

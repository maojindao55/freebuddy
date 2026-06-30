import type { WorkflowPhase, WorkflowStepStatus } from "./types";

/**
 * Find the phase id whose manual-approval gate is currently pending.
 *
 * Phases run sequentially. A manual gate can pause after a phase completes,
 * or before a write phase starts. Returns undefined when no manual gate is
 * currently actionable.
 */
export function pendingManualGatePhaseId(
  phases: WorkflowPhase[],
  stepStatuses: Array<{ stepId: string; status: WorkflowStepStatus }>
): string | undefined {
  const statusByStep = new Map(stepStatuses.map((s) => [s.stepId, s.status]));
  const isTerminal = (st: WorkflowStepStatus | undefined) =>
    st === "done" || st === "skipped";
  const isNotStarted = (st: WorkflowStepStatus | undefined) =>
    st === undefined || st === "pending";
  let gatingId: string | undefined;
  for (const phase of phases) {
    const allTerminal = phase.steps.every((s) =>
      isTerminal(statusByStep.get(s.id))
    );
    if (!allTerminal) {
      const isWritePhase = phase.steps.some((s) => s.mode === "write");
      const noneStarted = phase.steps.every((s) =>
        isNotStarted(statusByStep.get(s.id))
      );
      if (
        phase.gate?.type === "manual_approval" &&
        isWritePhase &&
        noneStarted
      ) {
        return phase.id;
      }
      break;
    }
    if (phase.gate?.type === "manual_approval") {
      gatingId = phase.id;
    }
  }
  return gatingId;
}

export function pendingWriteApprovalPhaseId(
  phases: WorkflowPhase[],
  stepStatuses: Array<{ stepId: string; status: WorkflowStepStatus }>
): string | undefined {
  const phaseId = pendingManualGatePhaseId(phases, stepStatuses);
  if (!phaseId) return undefined;
  const phase = phases.find((p) => p.id === phaseId);
  if (!phase || phase.gate?.type !== "manual_approval") return undefined;
  const statusByStep = new Map(stepStatuses.map((s) => [s.stepId, s.status]));
  const isWritePhase = phase.steps.some((s) => s.mode === "write");
  const noneStarted = phase.steps.every((s) => {
    const status = statusByStep.get(s.id);
    return status === undefined || status === "pending";
  });
  return isWritePhase && noneStarted ? phase.id : undefined;
}

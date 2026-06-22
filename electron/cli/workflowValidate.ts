import type {
  WorkflowAgentRef,
  WorkflowPlan,
  WorkflowStepMode,
  WorkflowValidationResult
} from "./workflowTypes.js";

const VALID_MODES = new Set<WorkflowStepMode>([
  "research",
  "review",
  "write",
  "verify",
  "summarize"
]);

export function validateWorkflowPlan(
  plan: WorkflowPlan | null | undefined,
  agents: WorkflowAgentRef[]
): WorkflowValidationResult {
  const errors: string[] = [];

  if (!plan) return { ok: false, errors: ["plan is empty"] };
  if (!plan.name?.trim()) errors.push("plan name is empty");
  if (!plan.goal?.trim()) errors.push("plan goal is empty");
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) {
    errors.push("plan has no phases");
    return { ok: false, errors };
  }

  const enabledIds = new Set(
    agents.filter((a) => a.enabled).map((a) => a.id)
  );
  const phaseIds = new Set<string>();
  const stepIds = new Set<string>();
  const stepOrder: string[] = [];

  plan.phases.forEach((phase, phaseIndex) => {
    if (!phase.id?.trim()) errors.push(`phase ${phaseIndex} has no id`);
    if (phaseIds.has(phase.id)) errors.push(`duplicate phase id "${phase.id}"`);
    phaseIds.add(phase.id);

    if (
      !Number.isInteger(phase.parallelism) ||
      phase.parallelism < 1 ||
      phase.parallelism > 3
    ) {
      errors.push(`phase "${phase.id}" parallelism must be between 1 and 3`);
    }

    const writes: string[] = [];
    (phase.steps || []).forEach((step) => {
      if (!step.id?.trim()) {
        errors.push(`a step in phase "${phase.id}" has no id`);
        return;
      }
      if (stepIds.has(step.id)) errors.push(`duplicate step id "${step.id}"`);
      stepIds.add(step.id);
      stepOrder.push(step.id);

      if (!step.title?.trim()) errors.push(`step "${step.id}" title is empty`);
      if (!step.prompt?.trim()) errors.push(`step "${step.id}" prompt is empty`);
      if (!VALID_MODES.has(step.mode))
        errors.push(`step "${step.id}" has invalid mode "${step.mode}"`);
      if (!enabledIds.has(step.agentId))
        errors.push(
          `step "${step.id}" references unknown or disabled agent "${step.agentId}"`
        );
      if (step.mode === "write") writes.push(step.id);
    });

    if (writes.length > 1) {
      errors.push(
        `phase "${phase.id}" contains more than one write step: ${writes.join(", ")}`
      );
    }
  });

  // Dependency existence + ordering (deps must appear earlier in step order).
  const indexOf = (id: string) => stepOrder.indexOf(id);
  plan.phases.forEach((phase) => {
    (phase.steps || []).forEach((step) => {
      (step.dependsOn || []).forEach((dep) => {
        if (!stepIds.has(dep)) {
          errors.push(`step "${step.id}" depends on unknown step "${dep}"`);
        } else if (indexOf(dep) > indexOf(step.id)) {
          errors.push(`step "${step.id}" depends on later step "${dep}"`);
        }
      });
    });
  });

  return { ok: errors.length === 0, errors };
}

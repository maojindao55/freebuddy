import type { WorkflowAgentRef, WorkflowPlan } from "./workflowTypes.js";

export interface ReviewLoopInput {
  goal: string;
  cwd?: string;
  reviewer: WorkflowAgentRef;
  implementer: WorkflowAgentRef;
  verifier: WorkflowAgentRef;
  targetPaths?: string[];
  maxLoops?: number;
}

export function buildReviewLoopPlan(input: ReviewLoopInput): WorkflowPlan {
  const maxLoops = input.maxLoops ?? 3;
  const target = (input.targetPaths ?? []).join(", ");
  return {
    name: "Review Loop",
    goal: input.goal,
    cwd: input.cwd,
    template: "review-loop",
    maxLoops,
    phases: [
      {
        id: "baseline",
        title: "Baseline",
        parallelism: 1,
        steps: [
          {
            id: "baseline-summarize",
            title: "Summarize task and current state",
            agentId: input.reviewer.id,
            mode: "research",
            prompt:
              `Summarize the task and current state. Goal: ${input.goal}.` +
              (target ? ` Target: ${target}.` : "") +
              ` Report target files, current state, and success criteria.`,
            targetPaths: input.targetPaths
          }
        ],
        gate: { type: "all_done" }
      },
      {
        id: "review",
        title: "Review",
        parallelism: 1,
        steps: [
          {
            id: "review-findings",
            title: "Produce review findings",
            agentId: input.reviewer.id,
            mode: "review",
            prompt:
              "Review the current state against the goal. List concrete, actionable findings with severity. Mark whether each finding is actionable.",
            consumes: ["baseline-summarize"]
          }
        ],
        gate: {
          type: "manual_approval",
          reason: "Approve which findings to address before implementing."
        }
      },
      {
        id: "implement",
        title: "Implement",
        parallelism: 1,
        steps: [
          {
            id: "implement-fixes",
            title: "Address approved findings",
            agentId: input.implementer.id,
            mode: "write",
            prompt:
              `Address the approved review findings for: ${input.goal}. Make focused changes.`,
            consumes: ["review-findings"]
          }
        ],
        gate: { type: "all_done" }
      },
      {
        id: "verify",
        title: "Verify",
        parallelism: 1,
        steps: [
          {
            id: "verify-changes",
            title: "Verify changes and report unresolved issues",
            agentId: input.verifier.id,
            mode: "verify",
            prompt:
              "Verify the changes resolve the findings. Run checks. Report whether any actionable issues remain. End your response with a line in the form: UNRESOLVED: <count>",
            consumes: ["implement-fixes"]
          }
        ],
        gate: { type: "all_done" }
      },
      {
        id: "loop_or_finish",
        title: "Loop or Finish",
        parallelism: 1,
        steps: [],
        gate: { type: "all_done" }
      }
    ]
  };
}

export interface ImplementReviewLoopInput {
  goal: string;
  cwd?: string;
  implementer: WorkflowAgentRef;
  reviewer: WorkflowAgentRef;
  targetPaths?: string[];
  maxLoops?: number;
}

export const IMPLEMENT_REVIEW_LOOP_TEMPLATE_ID = "tpl-implement-review-loop";
export const IMPLEMENT_REVIEW_STEP_ID = "implement-changes";
export const REVIEW_CHANGES_STEP_ID = "review-changes";

export function isImplementReviewLoopPlan(plan: WorkflowPlan): boolean {
  if (plan.template === "implement-review-loop") return true;
  const stepIds = new Set(
    plan.phases.flatMap((phase) => phase.steps.map((step) => step.id))
  );
  return (
    stepIds.has(IMPLEMENT_REVIEW_STEP_ID) &&
    stepIds.has(REVIEW_CHANGES_STEP_ID)
  );
}

export function buildImplementReviewLoopPlan(
  input: ImplementReviewLoopInput
): WorkflowPlan {
  const maxLoops = Math.max(input.maxLoops ?? 5, 2);
  const target = (input.targetPaths ?? []).join(", ");
  const goalLine = `Goal: ${input.goal}.` + (target ? ` Target: ${target}.` : "");

  return {
    name: "Implement-Review Loop",
    goal: input.goal,
    cwd: input.cwd,
    template: "implement-review-loop",
    maxLoops,
    phases: [
      {
        id: "implement",
        title: "Implement",
        parallelism: 1,
        steps: [
          {
            id: "implement-changes",
            title: "Implement changes",
            agentId: input.implementer.id,
            mode: "write",
            prompt:
              `Implement the requested change. ${goalLine} ` +
              "Make focused, minimal edits. Run quick sanity checks if appropriate.",
            targetPaths: input.targetPaths
          }
        ],
        gate: { type: "all_done" }
      },
      {
        id: "review",
        title: "Review",
        parallelism: 1,
        steps: [
          {
            id: "review-changes",
            title: "Review changes",
            agentId: input.reviewer.id,
            mode: "review",
            prompt:
              `Review the implementation for: ${input.goal}. ` +
              "List concrete issues if any. " +
              "End your response with exactly one line: REVIEW_STATUS: PASS or REVIEW_STATUS: FAIL. " +
              "If FAIL, include a FINDINGS section with actionable bullets.",
            consumes: ["implement-changes"]
          }
        ],
        gate: { type: "all_done" }
      },
      {
        id: "loop_or_finish",
        title: "Loop or Finish",
        parallelism: 1,
        steps: [],
        gate: { type: "all_done" }
      }
    ]
  };
}

export function reviewLoopCoordinatorPrompt(input: {
  goal: string;
  cwd?: string;
  agents: WorkflowAgentRef[];
  targetPaths?: string[];
}): string {
  const agentList = input.agents
    .filter((a) => a.enabled)
    .map((a) => `${a.id} (${a.name}, ${a.adapter})`)
    .join("\n");
  return [
    "You are a workflow coordinator. Design a Review Loop Workflow as a JSON object with this shape:",
    '{"name":string,"goal":string,"phases":[{"id":string,"title":string,"parallelism":number,"steps":[{"id":string,"title":string,"agentId":string,"mode":string,"prompt":string,"dependsOn"?:[string]}],"gate"?:{"type":"all_done"|"manual_approval"|"review_required"}}]}',
    "Step mode is one of: research, review, write, verify, summarize.",
    "Rules: ids unique; agentId must come from the agent list; parallelism between 1 and 3; at most one write step per phase; dependsOn references earlier steps; prompts non-empty.",
    "",
    `Task goal: ${input.goal}`,
    `Working directory: ${input.cwd ?? "(unset)"}`,
    `Target paths: ${(input.targetPaths ?? []).join(", ") || "(none)"}`,
    "Available agents:",
    agentList,
    "",
    "Return ONLY the JSON object, no commentary."
  ].join("\n");
}

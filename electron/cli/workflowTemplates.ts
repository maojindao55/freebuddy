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
        steps: [
          {
            id: "synthesize",
            title: "Synthesize final result",
            agentId: input.verifier.id,
            mode: "summarize",
            prompt:
              "Synthesize the final result: resolved findings, unresolved findings, files touched, and checks run.",
            consumes: ["verify-changes"]
          }
        ],
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

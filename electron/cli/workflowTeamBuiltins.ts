import type { WorkflowTeam } from "./workflowTeamTypes.js";
import { builtinCliMembers } from "./members.js";

function pickAgent(preferredIds: string[]): string {
  for (const id of preferredIds) {
    const m = builtinCliMembers.find(
      (x) => x.id === id && x.enabled !== false
    );
    if (m) return m.id;
  }
  const fallback = builtinCliMembers.find((m) => m.enabled !== false);
  return fallback?.id ?? builtinCliMembers[0]!.id;
}

export function builtinWorkflowTeams(): WorkflowTeam[] {
  const codex = pickAgent(["cli-codex-acp"]);
  const claude = pickAgent(["cli-claude-agent-acp", "cli-codex-acp"]);
  const opencode = pickAgent(["cli-opencode-acp", "cli-codex-acp"]);
  const now = new Date().toISOString();

  const quickTeam: WorkflowTeam = {
    id: "team-quick-implement",
    name: "Quick Implementation",
    description:
      "Plan, implement, verify, summarize. Small focused changes with one approval gate before writing.",
    icon: "team-quick",
    enabled: true,
    source: "builtin",
    roles: [
      { id: "role-planner", label: "Planner", kind: "planner", agentId: codex, required: true, canWrite: false },
      { id: "role-implementer", label: "Implementer", kind: "implementer", agentId: claude, required: true, canWrite: true },
      { id: "role-verifier", label: "Verifier", kind: "verifier", agentId: opencode, required: true, canWrite: false },
      { id: "role-summarizer", label: "Summarizer", kind: "summarizer", agentId: codex, required: true, canWrite: false }
    ],
    template: {
      id: "tpl-quick-implement",
      name: "Quick Implementation",
      version: 1,
      nodes: [
        { id: "plan-task", title: "Plan task", roleId: "role-planner", mode: "research", promptTemplate: "Plan the work needed for goal: {{goal}}. List the concrete steps required." },
        { id: "implement", title: "Implement", roleId: "role-implementer", mode: "write", promptTemplate: "Implement the plan for: {{goal}}. Make focused, minimal changes." },
        { id: "verify", title: "Verify", roleId: "role-verifier", mode: "verify", promptTemplate: "Verify the implementation. End your response with: UNRESOLVED: <count>" },
        { id: "summarize", title: "Summarize", roleId: "role-summarizer", mode: "summarize", promptTemplate: "Summarize what was done, what was changed, and what remains unresolved." }
      ],
      edges: [
        { id: "e1", from: "plan-task", to: "implement" },
        { id: "e2", from: "implement", to: "verify" },
        { id: "e3", from: "verify", to: "summarize" }
      ],
      startNodeIds: ["plan-task"],
      finalNodeIds: ["summarize"]
    },
    policy: {
      allowWrites: true,
      requireApprovalBeforeWrite: true,
      requireApprovalAfterReview: false,
      maxParallelReadSteps: 1,
      maxParallelWriteSteps: 1,
      maxLoops: 1,
      stopOnVerifyFailure: false
    },
    createdAt: now,
    updatedAt: now
  };

  const reviewTeam: WorkflowTeam = {
    id: "team-code-review",
    name: "Code Review",
    description: "Research, review, approve findings, implement, verify. For higher-risk tasks needing review first.",
    icon: "team-review",
    enabled: true,
    source: "builtin",
    roles: [
      { id: "role-researcher", label: "Researcher", kind: "researcher", agentId: codex, required: true, canWrite: false },
      { id: "role-reviewer", label: "Reviewer", kind: "reviewer", agentId: claude, required: true, canWrite: false },
      { id: "role-implementer", label: "Implementer", kind: "implementer", agentId: claude, required: true, canWrite: true },
      { id: "role-verifier", label: "Verifier", kind: "verifier", agentId: opencode, required: true, canWrite: false },
      { id: "role-summarizer", label: "Summarizer", kind: "summarizer", agentId: codex, required: true, canWrite: false }
    ],
    template: {
      id: "tpl-code-review",
      name: "Code Review",
      version: 1,
      nodes: [
        { id: "baseline", title: "Baseline", roleId: "role-researcher", mode: "research", promptTemplate: "Summarize the task and current state. Goal: {{goal}}. Report target files, current state, and success criteria." },
        { id: "review", title: "Review", roleId: "role-reviewer", mode: "review", promptTemplate: "Review the current state against the goal. List concrete, actionable findings with severity." },
        { id: "implement", title: "Implement", roleId: "role-implementer", mode: "write", promptTemplate: "Address the approved review findings for: {{goal}}. Make focused changes." },
        { id: "verify", title: "Verify", roleId: "role-verifier", mode: "verify", promptTemplate: "Verify the changes resolve the findings. Run checks. End your response with: UNRESOLVED: <count>" },
        { id: "summarize", title: "Summarize", roleId: "role-summarizer", mode: "summarize", promptTemplate: "Summarize what was reviewed, what was changed, and remaining issues." }
      ],
      edges: [
        { id: "e1", from: "baseline", to: "review" },
        { id: "e2", from: "review", to: "implement" },
        { id: "e3", from: "implement", to: "verify" },
        { id: "e4", from: "verify", to: "summarize" }
      ],
      startNodeIds: ["baseline"],
      finalNodeIds: ["summarize"]
    },
    policy: {
      allowWrites: true,
      requireApprovalBeforeWrite: false,
      requireApprovalAfterReview: true,
      maxParallelReadSteps: 1,
      maxParallelWriteSteps: 1,
      maxLoops: 3,
      stopOnVerifyFailure: true
    },
    createdAt: now,
    updatedAt: now
  };

  const readonlyTeam: WorkflowTeam = {
    id: "team-readonly-analysis",
    name: "Read-Only Analysis",
    description: "Research, review, summarize. No file writes allowed. For code comprehension, comparison, and reporting.",
    icon: "team-readonly",
    enabled: true,
    source: "builtin",
    roles: [
      { id: "role-researcher", label: "Researcher", kind: "researcher", agentId: codex, required: true, canWrite: false },
      { id: "role-reviewer", label: "Reviewer", kind: "reviewer", agentId: claude, required: true, canWrite: false },
      { id: "role-summarizer", label: "Summarizer", kind: "summarizer", agentId: codex, required: true, canWrite: false }
    ],
    template: {
      id: "tpl-readonly-analysis",
      name: "Read-Only Analysis",
      version: 1,
      nodes: [
        { id: "research-context", title: "Research context", roleId: "role-researcher", mode: "research", promptTemplate: "Explore the codebase and gather context for: {{goal}}. Report key files and findings." },
        { id: "review-risks", title: "Review risks", roleId: "role-reviewer", mode: "review", promptTemplate: "Review the research findings. List risks, trade-offs, and recommendations for: {{goal}}." },
        { id: "summarize", title: "Summarize", roleId: "role-summarizer", mode: "summarize", promptTemplate: "Summarize the analysis and recommendations for: {{goal}}." }
      ],
      edges: [
        { id: "e1", from: "research-context", to: "review-risks" },
        { id: "e2", from: "review-risks", to: "summarize" }
      ],
      startNodeIds: ["research-context"],
      finalNodeIds: ["summarize"]
    },
    policy: {
      allowWrites: false,
      requireApprovalBeforeWrite: false,
      requireApprovalAfterReview: false,
      maxParallelReadSteps: 3,
      maxParallelWriteSteps: 1,
      maxLoops: 1,
      stopOnVerifyFailure: false
    },
    createdAt: now,
    updatedAt: now
  };

  const implementReviewTeam: WorkflowTeam = {
    id: "team-implement-review-loop",
    name: "Implement-Review Loop",
    description:
      "Agent A implements, Agent B reviews. On FAIL, A fixes and B reviews again until PASS or max loops.",
    icon: "team-implement-review",
    enabled: true,
    source: "builtin",
    roles: [
      {
        id: "role-implementer",
        label: "Implementer",
        kind: "implementer",
        agentId: claude,
        required: true,
        canWrite: true
      },
      {
        id: "role-reviewer",
        label: "Reviewer",
        kind: "reviewer",
        agentId: codex,
        required: true,
        canWrite: false
      }
    ],
    template: {
      id: "tpl-implement-review-loop",
      name: "Implement-Review Loop",
      version: 1,
      nodes: [
        {
          id: "implement",
          title: "Implement",
          roleId: "role-implementer",
          mode: "write",
          promptTemplate: "Implement: {{goal}}"
        },
        {
          id: "review",
          title: "Review",
          roleId: "role-reviewer",
          mode: "review",
          promptTemplate: "Review: {{goal}}"
        }
      ],
      edges: [{ id: "e1", from: "implement", to: "review" }],
      startNodeIds: ["implement"],
      finalNodeIds: ["review"]
    },
    policy: {
      allowWrites: true,
      requireApprovalBeforeWrite: false,
      requireApprovalAfterReview: false,
      maxParallelReadSteps: 1,
      maxParallelWriteSteps: 1,
      maxLoops: 5,
      stopOnVerifyFailure: false
    },
    createdAt: now,
    updatedAt: now
  };

  return [quickTeam, reviewTeam, implementReviewTeam, readonlyTeam];
}

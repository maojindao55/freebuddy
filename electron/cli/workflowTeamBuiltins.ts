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
        agentId: opencode,
        required: true,
        canWrite: true
      },
      {
        id: "role-reviewer",
        label: "Reviewer",
        kind: "reviewer",
        agentId: pickAgent(["cli-kimi-acp", "cli-codex-acp"]),
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

  const researchReportTeam: WorkflowTeam = {
    id: "team-research-report",
    name: "Research Report",
    description:
      "Research a non-coding topic, analyze scenarios, and produce a concise report with conclusions and confidence.",
    icon: "team-research-report",
    enabled: true,
    source: "builtin",
    roles: [
      {
        id: "role-researcher",
        label: "Researcher",
        kind: "researcher",
        agentId: pickAgent(["cli-kimi-acp", "cli-codex-acp"]),
        required: true,
        canWrite: false
      },
      {
        id: "role-analyst",
        label: "Analyst",
        kind: "reviewer",
        agentId: codex,
        required: true,
        canWrite: false
      },
      {
        id: "role-reporter",
        label: "Reporter",
        kind: "summarizer",
        agentId: claude,
        required: true,
        canWrite: false
      }
    ],
    template: {
      id: "tpl-research-report",
      name: "Research Report",
      version: 1,
      nodes: [
        {
          id: "research",
          title: "Research",
          roleId: "role-researcher",
          mode: "research",
          promptTemplate: "Research the topic: {{goal}}. Gather relevant facts, context, constraints, and uncertainties. If current information is needed, identify what should be verified and cite available evidence from your environment."
        },
        {
          id: "analysis",
          title: "Analyze",
          roleId: "role-analyst",
          mode: "review",
          promptTemplate: "Analyze the research for: {{goal}}. Compare plausible scenarios, key drivers, risks, and assumptions. If predicting outcomes such as sports scores, give likely ranges and confidence instead of overclaiming certainty."
        },
        {
          id: "report",
          title: "Report",
          roleId: "role-reporter",
          mode: "summarize",
          promptTemplate: "Write a concise final report for: {{goal}}. Include summary, evidence, analysis, forecast or recommendation, confidence level, and caveats."
        }
      ],
      edges: [
        { id: "e1", from: "research", to: "analysis" },
        { id: "e2", from: "analysis", to: "report" }
      ],
      startNodeIds: ["research"],
      finalNodeIds: ["report"]
    },
    policy: {
      allowWrites: false,
      requireApprovalBeforeWrite: false,
      requireApprovalAfterReview: false,
      maxParallelReadSteps: 1,
      maxParallelWriteSteps: 1,
      maxLoops: 1,
      stopOnVerifyFailure: false
    },
    createdAt: now,
    updatedAt: now
  };

  return [quickTeam, implementReviewTeam, researchReportTeam];
}

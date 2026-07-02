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

  const deliveryExampleTeam: WorkflowTeam = {
    id: "team-delivery-example",
    name: "Standard Delivery Team",
    description:
      "Standard delivery workflow built from configurable nodes: plan approval, implementation, review, verification, and summary.",
    icon: "team-delivery-example",
    enabled: true,
    source: "builtin",
    roles: [
      { id: "role-planner", label: "Planner", kind: "planner", agentId: codex, required: true, canWrite: false },
      { id: "role-implementer", label: "Implementer", kind: "implementer", agentId: claude, required: true, canWrite: true },
      { id: "role-reviewer", label: "Reviewer", kind: "reviewer", agentId: pickAgent(["cli-kimi-acp", "cli-codex-acp"]), required: true, canWrite: false },
      { id: "role-verifier", label: "Verifier", kind: "verifier", agentId: opencode, required: true, canWrite: false },
      { id: "role-summarizer", label: "Summarizer", kind: "summarizer", agentId: codex, required: true, canWrite: false }
    ],
    template: {
      id: "tpl-configurable-delivery",
      name: "Configurable Delivery",
      version: 1,
      nodes: [
        {
          id: "plan",
          title: "Plan",
          roleId: "role-planner",
          mode: "research",
          contract: "plan",
          promptTemplate: "Plan {{goal}}",
          gates: [
            {
              id: "approve-plan",
              type: "manual_approval",
              placement: "after",
              label: "Approve plan",
              reason: "Review and approve the plan before implementation.",
              blocks: "implement"
            }
          ]
        },
        { id: "implement", title: "Implement", roleId: "role-implementer", mode: "write", contract: "implement", promptTemplate: "Implement {{goal}}" },
        { id: "review", title: "Review", roleId: "role-reviewer", mode: "review", contract: "review", promptTemplate: "Review {{goal}}" },
        { id: "verify", title: "Verify", roleId: "role-verifier", mode: "verify", contract: "verify", promptTemplate: "Verify {{goal}}" },
        { id: "summarize", title: "Summarize", roleId: "role-summarizer", mode: "summarize", contract: "summarize", promptTemplate: "Summarize {{goal}}" }
      ],
      edges: [
        { id: "e1", from: "plan", to: "implement" },
        { id: "e2", from: "implement", to: "review" },
        { id: "e3", from: "review", to: "verify" },
        { id: "e4", from: "verify", to: "summarize" }
      ],
      startNodeIds: ["plan"],
      finalNodeIds: ["summarize"]
    },
    policy: {
      allowWrites: true,
      requireApprovalBeforeWrite: true,
      requireApprovalAfterReview: false,
      maxParallelReadSteps: 1,
      maxParallelWriteSteps: 1,
      maxLoops: 5,
      stopOnVerifyFailure: false
    },
    createdAt: now,
    updatedAt: now
  };

  const rootCauseTeam: WorkflowTeam = {
    id: "team-root-cause-analysis",
    name: "Root Cause Analysis",
    description:
      "Collect evidence, challenge the hypothesis, verify the root cause, and produce a concise investigation report.",
    icon: "team-root-cause",
    enabled: true,
    source: "builtin",
    roles: [
      {
        id: "role-investigator",
        label: "Investigator",
        kind: "researcher",
        agentId: pickAgent(["cli-kimi-acp", "cli-codex-acp"]),
        required: true,
        canWrite: false
      },
      {
        id: "role-skeptic",
        label: "Skeptic",
        kind: "reviewer",
        agentId: codex,
        required: true,
        canWrite: false
      },
      {
        id: "role-verifier",
        label: "Verifier",
        kind: "verifier",
        agentId: opencode,
        required: true,
        canWrite: false
      },
      {
        id: "role-summarizer",
        label: "Summarizer",
        kind: "summarizer",
        agentId: claude,
        required: true,
        canWrite: false
      }
    ],
    template: {
      id: "tpl-root-cause-analysis",
      name: "Root Cause Analysis",
      version: 1,
      nodes: [
        {
          id: "collect-evidence",
          title: "Collect Evidence",
          roleId: "role-investigator",
          mode: "research",
          promptTemplate: "Collect concrete evidence for this issue: {{goal}}. Read relevant logs, database rows, source code, screenshots, and timestamps when available. Do not fix yet. Output a fact list, timeline, affected components, and unknowns."
        },
        {
          id: "challenge-hypothesis",
          title: "Challenge Hypothesis",
          roleId: "role-skeptic",
          mode: "review",
          promptTemplate: "Review the collected evidence for: {{goal}}. Challenge the proposed root cause, identify missing evidence, call out weak assumptions, and list alternative explanations that still fit the facts."
        },
        {
          id: "verify-root-cause",
          title: "Verify Root Cause",
          roleId: "role-verifier",
          mode: "verify",
          promptTemplate: "Verify the root cause for: {{goal}} using the evidence and challenges above. Check the strongest alternatives, explain what evidence rules them in or out, and state the confidence level. Do not change files."
        },
        {
          id: "summarize-findings",
          title: "Summarize Findings",
          roleId: "role-summarizer",
          mode: "summarize",
          promptTemplate: "Write a concise root-cause report for: {{goal}}. Include timeline, root cause, evidence, ruled-out alternatives, confidence, impact, and recommended next actions."
        }
      ],
      edges: [
        { id: "e1", from: "collect-evidence", to: "challenge-hypothesis" },
        { id: "e2", from: "challenge-hypothesis", to: "verify-root-cause" },
        { id: "e3", from: "verify-root-cause", to: "summarize-findings" }
      ],
      startNodeIds: ["collect-evidence"],
      finalNodeIds: ["summarize-findings"]
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
          promptTemplate: "Research the topic: {{goal}}. Focus only on information gathering: collect relevant facts, current context, constraints, evidence, and data gaps. Do not make final judgments or forecasts. Output concise evidence bullets, note freshness/uncertainty, and list what could not be verified."
        },
        {
          id: "analysis",
          title: "Analyze",
          roleId: "role-analyst",
          mode: "review",
          promptTemplate: "Analyze the provided research for: {{goal}}. Use the upstream research context as the primary source. Only perform additional lookup when the context has an explicit critical gap, and label it as supplemental. Do not repeat the raw facts except when needed as evidence. Identify key drivers, compare plausible scenarios, assess risks and assumptions, and provide likelihood ranges or confidence levels. For sports scores or forecasts, reason from the evidence and avoid claiming certainty."
        },
        {
          id: "report",
          title: "Report",
          roleId: "role-reporter",
          mode: "summarize",
          promptTemplate: "Write a concise final report for: {{goal}}. Use prior research and analysis as the primary source. Do not restart broad research; only verify a critical citation/date if missing. Synthesize the research evidence and analysis into a clear answer with summary, key evidence, forecast or recommendation, confidence level, and caveats."
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

  return [deliveryExampleTeam, rootCauseTeam, researchReportTeam];
}

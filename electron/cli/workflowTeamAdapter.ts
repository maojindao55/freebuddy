import { builtinCliMembers } from "./cliMemberBuiltins.js";
import {
  buildConfigurableDeliveryPlan,
  buildImplementReviewLoopPlan,
  CONFIGURABLE_DELIVERY_TEMPLATE_ID,
  IMPLEMENT_REVIEW_LOOP_TEMPLATE_ID
} from "./workflowTemplates.js";
import type {
  WorkflowAgentRef,
  WorkflowGate,
  WorkflowPhase,
  WorkflowPlan,
  WorkflowStep,
  WorkflowStepMode
} from "./workflowTypes.js";
import type {
  WorkflowTeam,
  WorkflowNodeContract,
  WorkflowTeamPreview,
  WorkflowTemplateNode,
  WorkflowTemplateNodeMode
} from "./workflowTeamTypes.js";

export interface TeamRunInput {
  goal: string;
  cwd?: string;
  targetPaths?: string[];
}

export interface TeamPreviewResult {
  ok: boolean;
  errors?: string[];
  preview?: WorkflowTeamPreview;
}

function nodeModeToStepMode(mode: WorkflowTemplateNodeMode): WorkflowStepMode {
  if (mode === "approval") return "review";
  return mode;
}

function renderPrompt(
  template: string | undefined,
  input: TeamRunInput
): string {
  const target = (input.targetPaths ?? []).join(", ");
  const raw = template ?? "";
  return raw
    .replace(/\{\{goal\}\}/g, input.goal)
    .replace(/\{\{cwd\}\}/g, input.cwd ?? "")
    .replace(/\{\{targetPaths\}\}/g, target);
}

/**
 * Expand a team template into the existing phase/step WorkflowPlan so the
 * current runtime can execute it. Each template node maps to one phase that
 * contains a single step. Approval gates are inserted based on policy.
 */
export function expandTeamToPlan(
  team: WorkflowTeam,
  input: TeamRunInput,
  agents: WorkflowAgentRef[]
): TeamPreviewResult {
  if (team.template.id === IMPLEMENT_REVIEW_LOOP_TEMPLATE_ID) {
    return expandImplementReviewTeamToPlan(team, input, agents);
  }
  if (isConfigurableDeliveryTeam(team)) {
    return expandConfigurableDeliveryTeamToPlan(team, input, agents);
  }

  const errors: string[] = [];

  if (!team.enabled) {
    errors.push("team is disabled");
  }

  const orderedNodes = topoSortNodes(team.template.nodes, team.template.edges);
  if (!orderedNodes) {
    errors.push("template contains a cycle in non-loop edges");
    return { ok: false, errors };
  }

  const phases: WorkflowPhase[] = [];
  const roleSummary: WorkflowTeamPreview["roleSummary"] = [];
  for (const role of team.roles) {
    const m = builtinCliMembers.find((x) => x.id === role.agentId);
    roleSummary.push({
      roleId: role.id,
      roleLabel: role.label,
      kind: role.kind,
      agentId: role.agentId,
      agentName: m?.name ?? role.agentId
    });
  }

  const routeSummary: WorkflowTeamPreview["routeSummary"] = [];
  let writeNodeCount = 0;
  let approvalNodeCount = 0;
  let priorMode: WorkflowTemplateNodeMode | undefined;

  let priorStepIds: string[] = [];

  for (const node of orderedNodes) {
    const role = node.roleId
      ? team.roles.find((r) => r.id === node.roleId)
      : undefined;
    const agentRef = role
      ? agents.find((a) => a.id === role.agentId)
      : agents[0];
    if (node.mode !== "approval" && !agentRef) {
      errors.push(`node ${node.id} cannot resolve to a valid agent`);
      continue;
    }
    if (node.mode === "approval" || !agentRef) {
      approvalNodeCount += 1;
      routeSummary.push({
        nodeId: node.id,
        title: node.title,
        mode: node.mode,
        roleLabel: role?.label,
        agentName: undefined
      });
      continue;
    }

    if (node.mode === "write") {
      if (!team.policy.allowWrites) {
        errors.push(`write node ${node.id} not allowed by policy`);
        continue;
      }
      writeNodeCount += 1;
    }

    let gate: WorkflowGate | undefined;
    if (
      node.mode === "write" &&
      team.policy.requireApprovalBeforeWrite
    ) {
      gate = {
        type: "manual_approval",
        reason: "Review the completed plan and approve the write step before execution."
      };
    } else if (
      node.mode === "write" &&
      team.policy.requireApprovalAfterReview &&
      priorMode === "review"
    ) {
      gate = {
        type: "manual_approval",
        reason: "Approve review findings before implementing."
      };
    }

    const step: WorkflowStep = {
      id: `${node.id}-step`,
      title: node.title,
      agentId: agentRef.id,
      mode: nodeModeToStepMode(node.mode),
      prompt: renderPrompt(node.promptTemplate, input),
      ...(priorStepIds.length ? { consumes: priorStepIds } : {})
    };

    phases.push({
      id: node.id,
      title: node.title,
      parallelism: 1,
      steps: [step],
      gate: gate ?? { type: "all_done" }
    });

    routeSummary.push({
      nodeId: node.id,
      title: node.title,
      mode: node.mode,
      roleLabel: role?.label,
      agentName: agentRef.name
    });

    priorMode = node.mode;
    priorStepIds = [step.id];
  }

  if (errors.length > 0) return { ok: false, errors };

  const plan: WorkflowPlan = {
    name: team.name,
    goal: input.goal,
    cwd: input.cwd,
    template: "custom",
    maxLoops: team.policy.maxLoops,
    phases
  };

  const preview: WorkflowTeamPreview = {
    teamId: team.id,
    teamName: team.name,
    goal: input.goal,
    cwd: input.cwd,
    roleSummary,
    routeSummary,
    writeNodeCount,
    approvalNodeCount,
    maxLoops: team.policy.maxLoops,
    plan
  };

  return { ok: true, preview };
}

function isConfigurableDeliveryTeam(team: WorkflowTeam): boolean {
  const deliveryContracts: WorkflowNodeContract[] = [
    "plan",
    "approval",
    "implement",
    "review",
    "verify",
    "summarize"
  ];
  return (
    team.template.id === CONFIGURABLE_DELIVERY_TEMPLATE_ID ||
    team.template.nodes.some((node) =>
      node.contract ? deliveryContracts.includes(node.contract) : false
    )
  );
}

function teamHasManualApprovalGate(team: WorkflowTeam): boolean {
  return team.template.nodes.some(
    (node) =>
      node.mode === "approval" ||
      node.gates?.some((gate) => gate.type === "manual_approval")
  );
}

function roleSummaryForTeam(
  team: WorkflowTeam,
  agents: WorkflowAgentRef[]
): WorkflowTeamPreview["roleSummary"] {
  return team.roles.map((role) => {
    const agent = agents.find((entry) => entry.id === role.agentId);
    const m = builtinCliMembers.find((x) => x.id === role.agentId);
    return {
      roleId: role.id,
      roleLabel: role.label,
      kind: role.kind,
      agentId: role.agentId,
      agentName: agent?.name ?? m?.name ?? role.agentId
    };
  });
}

function expandConfigurableDeliveryTeamToPlan(
  team: WorkflowTeam,
  input: TeamRunInput,
  agents: WorkflowAgentRef[]
): TeamPreviewResult {
  const errors: string[] = [];
  if (!team.enabled) errors.push("team is disabled");

  const nodeByContract = new Map(
    team.template.nodes
      .filter((node) => node.contract)
      .map((node) => [node.contract!, node])
  );
  const implementNode = nodeByContract.get("implement");
  if (!implementNode?.roleId) {
    errors.push("configurable delivery team requires an implement node");
  }

  const roleAgentId = (contract: WorkflowNodeContract) => {
    const node = nodeByContract.get(contract);
    const role = node?.roleId ? team.roles.find((r) => r.id === node.roleId) : undefined;
    return role?.agentId;
  };
  const resolveContractAgent = (contract: WorkflowNodeContract) => {
    const agentId = roleAgentId(contract);
    return agentId ? agents.find((agent) => agent.id === agentId) : undefined;
  };

  const implementer = resolveContractAgent("implement");
  const planner = resolveContractAgent("plan");
  const reviewer = resolveContractAgent("review");
  const verifier = resolveContractAgent("verify");
  const summarizer = resolveContractAgent("summarize");
  for (const contract of ["plan", "implement", "review", "verify", "summarize"] as const) {
    if (nodeByContract.has(contract) && !resolveContractAgent(contract)) {
      errors.push(`node ${contract} cannot resolve to a valid agent`);
    }
  }
  if (!team.policy.allowWrites) {
    errors.push("configurable delivery team requires write permission for implement");
  }
  if (errors.length > 0 || !implementer) {
    return { ok: false, errors };
  }

  const hasApproval = teamHasManualApprovalGate(team);
  const plan = buildConfigurableDeliveryPlan({
    name: team.name,
    goal: input.goal,
    cwd: input.cwd,
    targetPaths: input.targetPaths,
    planner,
    implementer,
    reviewer,
    verifier,
    summarizer,
    maxLoops: team.policy.maxLoops,
    requireApprovalBeforeWrite: hasApproval || team.policy.requireApprovalBeforeWrite
  });

  const routeSummary: WorkflowTeamPreview["routeSummary"] = [];
  for (const node of team.template.nodes) {
    const role = node.roleId
      ? team.roles.find((r) => r.id === node.roleId)
      : undefined;
    const agent = role
      ? agents.find((entry) => entry.id === role.agentId)
      : undefined;
    routeSummary.push({
      nodeId: node.id,
      title: node.title,
      mode: node.mode,
      roleLabel: role?.label,
      agentName: agent?.name
    });
  }

  const preview: WorkflowTeamPreview = {
    teamId: team.id,
    teamName: team.name,
    goal: input.goal,
    cwd: input.cwd,
    roleSummary: roleSummaryForTeam(team, agents),
    routeSummary,
    writeNodeCount: team.template.nodes.filter((node) => node.mode === "write").length,
    approvalNodeCount: team.template.nodes.reduce(
      (count, node) =>
        count +
        (node.mode === "approval" ? 1 : 0) +
        (node.gates?.filter((gate) => gate.type === "manual_approval").length ?? 0),
      0
    ),
    maxLoops: plan.maxLoops ?? team.policy.maxLoops,
    plan
  };

  return { ok: true, preview };
}

function expandImplementReviewTeamToPlan(
  team: WorkflowTeam,
  input: TeamRunInput,
  agents: WorkflowAgentRef[]
): TeamPreviewResult {
  const errors: string[] = [];
  if (!team.enabled) errors.push("team is disabled");

  const implementerRole = team.roles.find((r) => r.kind === "implementer");
  const reviewerRole = team.roles.find((r) => r.kind === "reviewer");
  const verifierRole = team.roles.find((r) => r.kind === "verifier");
  const summarizerRole = team.roles.find((r) => r.kind === "summarizer");
  if (!implementerRole) errors.push("implementer role is required");
  if (!reviewerRole) errors.push("reviewer role is required");

  const implementer = implementerRole
    ? agents.find((a) => a.id === implementerRole.agentId)
    : undefined;
  const reviewer = reviewerRole
    ? agents.find((a) => a.id === reviewerRole.agentId)
    : undefined;
  const verifier = verifierRole
    ? agents.find((a) => a.id === verifierRole.agentId)
    : undefined;
  const summarizer = summarizerRole
    ? agents.find((a) => a.id === summarizerRole.agentId)
    : undefined;
  if (implementerRole && !implementer) {
    errors.push(`implementer references unknown agent "${implementerRole.agentId}"`);
  }
  if (reviewerRole && !reviewer) {
    errors.push(`reviewer references unknown agent "${reviewerRole.agentId}"`);
  }
  if (verifierRole && !verifier) {
    errors.push(`verifier references unknown agent "${verifierRole.agentId}"`);
  }
  if (summarizerRole && !summarizer) {
    errors.push(`summarizer references unknown agent "${summarizerRole.agentId}"`);
  }
  if (errors.length > 0 || !implementer || !reviewer) {
    return { ok: false, errors };
  }

  const plan = buildImplementReviewLoopPlan({
    goal: input.goal,
    cwd: input.cwd,
    targetPaths: input.targetPaths,
    implementer,
    reviewer,
    verifier,
    summarizer,
    maxLoops: team.policy.maxLoops
  });

  const roleSummary: WorkflowTeamPreview["roleSummary"] = team.roles.map((role) => {
    const m = builtinCliMembers.find((x) => x.id === role.agentId);
    return {
      roleId: role.id,
      roleLabel: role.label,
      kind: role.kind,
      agentId: role.agentId,
      agentName: m?.name ?? role.agentId
    };
  });

  const routeSummary: WorkflowTeamPreview["routeSummary"] = [
    {
      nodeId: "implement",
      title: "Implement",
      mode: "write",
      roleLabel: implementerRole!.label,
      agentName: implementer.name
    },
    {
      nodeId: "review",
      title: "Review",
      mode: "review",
      roleLabel: reviewerRole!.label,
      agentName: reviewer.name
    }
  ];
  if (verifierRole && verifier) {
    routeSummary.push({
      nodeId: "verify",
      title: "Verify",
      mode: "verify",
      roleLabel: verifierRole.label,
      agentName: verifier.name
    });
  }
  if (summarizerRole && summarizer) {
    routeSummary.push({
      nodeId: "summarize",
      title: "Summarize",
      mode: "summarize",
      roleLabel: summarizerRole.label,
      agentName: summarizer.name
    });
  }

  const preview: WorkflowTeamPreview = {
    teamId: team.id,
    teamName: team.name,
    goal: input.goal,
    cwd: input.cwd,
    roleSummary,
    routeSummary,
    writeNodeCount: 1,
    approvalNodeCount: 0,
    maxLoops: team.policy.maxLoops,
    plan
  };

  return { ok: true, preview };
}

function topoSortNodes(
  nodes: WorkflowTemplateNode[],
  edges: { from: string; to: string }[]
): WorkflowTemplateNode[] | null {
  const indeg = new Map<string, number>();
  const outs = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    outs.set(n.id, []);
  }
  for (const e of edges) {
    if (!indeg.has(e.to) || !outs.has(e.from)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    outs.get(e.from)!.push(e.to);
  }
  const queue: string[] = [];
  for (const [id, d] of indeg.entries()) {
    if (d === 0) queue.push(id);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outs.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) return null;
  return order
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is WorkflowTemplateNode => Boolean(n));
}

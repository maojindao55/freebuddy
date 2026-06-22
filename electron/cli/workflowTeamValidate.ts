import type { WorkflowAgentRef } from "./workflowTypes.js";
import type {
  WorkflowTeam,
  WorkflowTeamValidationResult,
  WorkflowTemplate2
} from "./workflowTeamTypes.js";

export function validateWorkflowTeam(
  team: WorkflowTeam,
  agents: WorkflowAgentRef[]
): WorkflowTeamValidationResult {
  const errors: string[] = [];

  if (!team.name || !team.name.trim()) {
    errors.push("team name is required");
  }

  const roleIds = new Set<string>();
  for (const role of team.roles) {
    if (roleIds.has(role.id)) {
      errors.push(`duplicate role id: ${role.id}`);
    }
    roleIds.add(role.id);
    if (role.required) {
      const agent = agents.find((a) => a.id === role.agentId);
      if (!agent) {
        errors.push(`role ${role.label} references unknown agent: ${role.agentId}`);
      } else if (!agent.enabled) {
        errors.push(`role ${role.label} agent is disabled: ${role.agentId}`);
      }
    }
  }

  const templateErrors = validateTemplate(team.template, team);
  errors.push(...templateErrors);

  if (!team.policy.allowWrites) {
    const writeNodes = team.template.nodes.filter((n) => n.mode === "write");
    if (writeNodes.length > 0) {
      errors.push(
        "policy disallows writes but template contains write nodes: " +
          writeNodes.map((n) => n.id).join(", ")
      );
    }
  }
  if (
    team.policy.maxParallelReadSteps < 1 ||
    team.policy.maxParallelReadSteps > 3
  ) {
    errors.push("maxParallelReadSteps must be between 1 and 3");
  }
  if (team.policy.maxParallelWriteSteps !== 1) {
    errors.push("maxParallelWriteSteps must be 1");
  }
  if (team.policy.maxLoops < 1) {
    errors.push("maxLoops must be at least 1");
  }

  return { ok: errors.length === 0, errors };
}

function validateTemplate(
  template: WorkflowTemplate2,
  team: WorkflowTeam
): string[] {
  const errors: string[] = [];
  const nodeIds = new Set<string>();
  for (const node of template.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
    if (node.mode !== "approval") {
      if (!node.roleId) {
        errors.push(`node ${node.id} has no role`);
      } else if (!team.roles.find((r) => r.id === node.roleId)) {
        errors.push(`node ${node.id} references unknown role: ${node.roleId}`);
      } else if (node.mode === "write") {
        const role = team.roles.find((r) => r.id === node.roleId);
        if (role && !role.canWrite) {
          errors.push(`write node ${node.id} bound to non-write role`);
        }
      }
      if (!node.promptTemplate || !node.promptTemplate.trim()) {
        errors.push(`node ${node.id} has empty prompt template`);
      }
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of template.edges) {
    if (edgeIds.has(edge.id)) {
      errors.push(`duplicate edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) {
      errors.push(`edge ${edge.id} from unknown node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`edge ${edge.id} to unknown node: ${edge.to}`);
    }
  }

  for (const id of template.startNodeIds) {
    if (!nodeIds.has(id)) errors.push(`unknown start node: ${id}`);
  }
  for (const id of template.finalNodeIds) {
    if (!nodeIds.has(id)) errors.push(`unknown final node: ${id}`);
  }
  if (template.startNodeIds.length === 0) {
    errors.push("template has no start node");
  }
  if (template.finalNodeIds.length === 0) {
    errors.push("template has no final node");
  }

  return errors;
}

import path from "node:path";
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft,
  BusinessValidationResult,
  BusinessWorkspace
} from "./businessWorkspaceTypes.js";
import type { WorkflowAgentRef } from "./workflowTypes.js";

export function validateBusinessWorkspace(
  workspace: BusinessWorkspace,
  agents: WorkflowAgentRef[]
): BusinessValidationResult {
  const errors: string[] = [];
  if (!workspace.name.trim()) errors.push("workspace name is required");
  if (workspace.surfaces.length === 0) errors.push("at least one surface is required");

  const surfaceIds = new Set<string>();
  for (const surface of workspace.surfaces) {
    if (!surface.id.trim()) errors.push("surface id is required");
    if (surfaceIds.has(surface.id)) errors.push(`duplicate surface id: ${surface.id}`);
    surfaceIds.add(surface.id);
    if (!surface.name.trim()) errors.push(`surface ${surface.id} name is required`);
    if (!path.isAbsolute(surface.repoPath)) {
      errors.push(`surface ${surface.id} repoPath must be an absolute path`);
    }
    const agent = agents.find((a) => a.id === surface.defaultAgentId);
    if (!agent) errors.push(`surface ${surface.id} references unknown agent: ${surface.defaultAgentId}`);
    if (agent && !agent.enabled) errors.push(`surface ${surface.id} agent is disabled: ${surface.defaultAgentId}`);
    for (const allowedPath of surface.allowedPaths) {
      if (path.isAbsolute(allowedPath)) {
        errors.push(`surface ${surface.id} allowedPaths must be relative: ${allowedPath}`);
      }
    }
    for (const command of surface.verifyCommands) {
      if (!command.trim()) errors.push(`surface ${surface.id} has an empty verify command`);
    }
  }

  if (!workspace.policy.branchNameTemplate.includes("{{runSlug}}")) {
    errors.push("branchNameTemplate must include {{runSlug}}");
  }
  if (!workspace.policy.branchNameTemplate.includes("{{surfaceKey}}")) {
    errors.push("branchNameTemplate must include {{surfaceKey}}");
  }

  return { ok: errors.length === 0, errors };
}

export function validateBusinessAssignmentPlan(
  plan: BusinessAssignmentPlan,
  workspace: BusinessWorkspace
): BusinessValidationResult {
  const errors: string[] = [];
  const surfaceIds = new Set(workspace.surfaces.map((s) => s.id));
  for (const item of plan.surfaces) {
    if (!surfaceIds.has(item.surfaceId)) errors.push(`assignment references unknown surface: ${item.surfaceId}`);
    for (const dep of item.dependsOnSurfaceIds) {
      if (!surfaceIds.has(dep)) errors.push(`assignment ${item.surfaceId} depends on unknown surface: ${dep}`);
    }
  }
  for (const dep of plan.dependencies) {
    if (!surfaceIds.has(dep.fromSurfaceId)) errors.push(`dependency from unknown surface: ${dep.fromSurfaceId}`);
    if (!surfaceIds.has(dep.toSurfaceId)) errors.push(`dependency to unknown surface: ${dep.toSurfaceId}`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateBusinessContractDraft(
  draft: BusinessContractDraft,
  workspace: BusinessWorkspace
): BusinessValidationResult {
  const errors: string[] = [];
  const surfaceIds = new Set(workspace.surfaces.map((s) => s.id));
  for (const id of draft.providerSurfaceIds) {
    if (!surfaceIds.has(id)) errors.push(`contract provider references unknown surface: ${id}`);
  }
  for (const id of draft.consumerSurfaceIds) {
    if (!surfaceIds.has(id)) errors.push(`contract consumer references unknown surface: ${id}`);
  }
  return { ok: errors.length === 0, errors };
}

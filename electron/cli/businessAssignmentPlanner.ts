import { nanoid } from "nanoid";
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft,
  BusinessWorkspace
} from "./businessWorkspaceTypes.js";

export function previewBusinessAssignment(
  workspace: BusinessWorkspace,
  goal: string
):
  | { ok: true; assignmentPlan: BusinessAssignmentPlan; contractDraft?: BusinessContractDraft }
  | { ok: false; errors: string[] } {
  const enabled = workspace.surfaces.filter((surface) => surface.enabled);
  if (enabled.length === 0) {
    return { ok: false, errors: ["workspace has no enabled surfaces"] };
  }

  const providers = enabled.filter((surface) =>
    surface.contractRole === "provider" || surface.contractRole === "both"
  );
  const consumers = enabled.filter((surface) =>
    surface.contractRole === "consumer" || surface.contractRole === "both"
  );
  const needsContractDraft = providers.length > 0 && consumers.length > 0;
  const providerIds = new Set(providers.map((surface) => surface.id));

  const assignmentPlan: BusinessAssignmentPlan = {
    surfaces: enabled.map((surface) => ({
      surfaceId: surface.id,
      agentId: surface.defaultAgentId,
      repoPath: surface.repoPath,
      tasks: [
        `Handle ${surface.name} changes for: ${goal}`,
        ...surface.responsibilities.map((item) => `Respect responsibility: ${item}`)
      ],
      dependsOnSurfaceIds:
        needsContractDraft && !providerIds.has(surface.id)
          ? providers.map((provider) => provider.id)
          : [],
      writes: surface.allowedPaths.length > 0,
      verifyCommands: surface.verifyCommands
    })),
    dependencies: needsContractDraft
      ? consumers.flatMap((consumer) =>
          providers
            .filter((provider) => provider.id !== consumer.id)
            .map((provider) => ({
              fromSurfaceId: consumer.id,
              toSurfaceId: provider.id,
              reason: `${consumer.name} consumes contract from ${provider.name}`
            }))
        )
      : [],
    needsContractDraft,
    summary: `Plan ${enabled.length} surfaces for: ${goal}`
  };

  const contractDraft = needsContractDraft
    ? buildContractDraft(goal, providers.map((s) => s.id), consumers.map((s) => s.id))
    : undefined;

  return { ok: true, assignmentPlan, contractDraft };
}

function buildContractDraft(
  goal: string,
  providerSurfaceIds: string[],
  consumerSurfaceIds: string[]
): BusinessContractDraft {
  return {
    id: nanoid(),
    title: `Contract draft for ${goal}`,
    providerSurfaceIds,
    consumerSurfaceIds,
    endpoints: [
      {
        method: "POST",
        path: "/api/business-change",
        request: "Request fields should be finalized by provider surface before implementation is considered complete.",
        response: "Response fields should cover the UI states needed by consumer surfaces.",
        errors: ["VALIDATION_FAILED", "UNAUTHORIZED", "NOT_FOUND"]
      }
    ],
    dataRules: ["Provider surfaces own persistence and canonical business rules."],
    permissionRules: ["Provider surfaces define permission checks; consumer surfaces display permission failures."],
    notes: ["This MVP contract is a structured draft and can be edited before execution."]
  };
}

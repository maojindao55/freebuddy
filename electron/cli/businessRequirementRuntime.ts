import type { WebContents } from "electron";
import { nanoid } from "nanoid";

import { insertBusinessRequirementRun } from "./businessRequirementRuns.js";
import { ensureCleanRepo, runVerifyCommand } from "./businessGit.js";
import { getBusinessRequirementRun, updateBusinessRequirementRun } from "./businessRequirementRuns.js";
import { cliRun } from "./runtime.js";
import {
  startBusinessRunCore,
  type BusinessRunDeps
} from "./businessRuntimeCore.js";
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft,
  BusinessRequirementRun,
  BusinessSurfaceRun,
  BusinessWorkspace
} from "./businessWorkspaceTypes.js";

export interface CreateRunFromAssignmentInput {
  workspace: BusinessWorkspace;
  goal: string;
  teamId?: string;
  assignmentPlan: BusinessAssignmentPlan;
  contractDraft?: BusinessContractDraft;
}

function buildSurfaceRuns(
  plan: BusinessAssignmentPlan,
  workspace: BusinessWorkspace
): BusinessSurfaceRun[] {
  return plan.surfaces.map((item) => {
    const surface = workspace.surfaces.find((s) => s.id === item.surfaceId);
    return {
      id: nanoid(),
      surfaceId: item.surfaceId,
      agentId: item.agentId,
      repoPath: item.repoPath,
      status: "pending",
      taskSummary: item.tasks.join("; "),
      verificationResults: [],
      branchName: undefined,
      commitMessage: undefined,
      commitSha: undefined,
      riskSummary:
        surface && surface.allowedPaths.length === 0
          ? "no allowedPaths; nothing will be committed for this surface"
          : undefined
    };
  });
}

export function createRunFromAssignment(
  input: CreateRunFromAssignmentInput
):
  | { ok: true; run: BusinessRequirementRun }
  | { ok: false; errors: string[] } {
  if (input.assignmentPlan.surfaces.length === 0) {
    return { ok: false, errors: ["assignment plan has no surfaces"] };
  }
  const surfaceRuns = buildSurfaceRuns(input.assignmentPlan, input.workspace);
  const now = new Date().toISOString();
  const run: BusinessRequirementRun = {
    id: nanoid(),
    workspaceId: input.workspace.id,
    workspaceSnapshot: input.workspace,
    teamId: input.teamId,
    goal: input.goal,
    status: "running",
    assignmentPlan: input.assignmentPlan,
    contractDraft: input.contractDraft,
    surfaceRuns,
    commitGate: undefined,
    createdAt: now,
    updatedAt: now
  };
  const inserted = insertBusinessRequirementRun({
    id: run.id,
    workspaceId: run.workspaceId,
    workspaceSnapshot: run.workspaceSnapshot,
    teamId: run.teamId,
    goal: run.goal,
    status: run.status,
    assignmentPlan: run.assignmentPlan,
    contractDraft: run.contractDraft,
    surfaceRuns: run.surfaceRuns,
    commitGate: run.commitGate
  });
  return { ok: true, run: inserted };
}

export async function startBusinessRun(
  webContents: WebContents,
  runId: string
): Promise<
  | { ok: true; run: BusinessRequirementRun }
  | { ok: false; errors: string[] }
> {
  const run = getBusinessRequirementRun(runId);
  if (!run) return { ok: false, errors: ["run not found"] };

  const deps: BusinessRunDeps = {
    cliRun: (args) => cliRun(webContents, args),
    ensureCleanRepo,
    runVerifyCommand,
    patchSurfaceRuns: (updater) => {
      const current = getBusinessRequirementRun(runId);
      if (!current) return;
      updateBusinessRequirementRun(runId, { surfaceRuns: updater(current.surfaceRuns) });
    },
    setStatus: (status) => {
      updateBusinessRequirementRun(runId, { status });
    }
  };

  const result = await startBusinessRunCore(run, deps);
  if (!result.ok) return result;
  const finalRun = getBusinessRequirementRun(runId);
  return { ok: true, run: finalRun ?? run };
}

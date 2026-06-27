import { ipcMain } from "electron";
import { builtinCliMembers } from "./members.js";
import {
  deleteBusinessWorkspace,
  getBusinessWorkspace,
  insertBusinessWorkspace,
  listBusinessWorkspaces,
  updateBusinessWorkspace,
  type UpdateBusinessWorkspacePatch,
  type UpsertBusinessWorkspaceInput
} from "./businessWorkspaces.js";
import { validateBusinessWorkspace } from "./businessWorkspaceValidate.js";
import { previewBusinessAssignment } from "./businessAssignmentPlanner.js";
import { getBusinessRequirementRun } from "./businessRequirementRuns.js";
import {
  createRunFromAssignment,
  startBusinessRun
} from "./businessRequirementRuntime.js";
import {
  approveBusinessCommitGateForRun,
  previewBusinessCommitGateForRun,
  type CommitGatePatch
} from "./businessCommitGate.js";
import type { WorkflowAgentRef } from "./workflowTypes.js";

export function registerBusinessWorkspaceIpc() {
  ipcMain.handle("businessWorkspaces:list", () => listBusinessWorkspaces());
  ipcMain.handle("businessWorkspaces:get", (_e, id: string) => getBusinessWorkspace(id));
  ipcMain.handle("businessWorkspaces:create", (_e, input: UpsertBusinessWorkspaceInput) => {
    const validation = validateBusinessWorkspace(
      { ...input, createdAt: "", updatedAt: "" },
      businessAgents()
    );
    if (!validation.ok) return { ok: false as const, errors: validation.errors };
    return { ok: true as const, workspace: insertBusinessWorkspace(input) };
  });
  ipcMain.handle(
    "businessWorkspaces:update",
    (_e, args: { id: string; patch: UpdateBusinessWorkspacePatch }) => {
      const existing = getBusinessWorkspace(args.id);
      if (!existing) return { ok: false as const, errors: ["workspace not found"] };
      const merged = { ...existing, ...args.patch };
      const validation = validateBusinessWorkspace(merged, businessAgents());
      if (!validation.ok) return { ok: false as const, errors: validation.errors };
      const workspace = updateBusinessWorkspace(args.id, args.patch);
      return workspace
        ? { ok: true as const, workspace }
        : { ok: false as const, errors: ["workspace not found"] };
    }
  );
  ipcMain.handle("businessWorkspaces:delete", (_e, id: string) => deleteBusinessWorkspace(id));
  ipcMain.handle(
    "businessRequirements:previewAssignment",
    (_e, input: { workspaceId: string; goal: string }) => {
      const workspace = getBusinessWorkspace(input.workspaceId);
      if (!workspace) return { ok: false as const, errors: ["workspace not found"] };
      const validation = validateBusinessWorkspace(workspace, businessAgents());
      if (!validation.ok) return { ok: false as const, errors: validation.errors };
      return previewBusinessAssignment(workspace, input.goal);
    }
  );
  ipcMain.handle(
    "businessRequirements:createRun",
    (_e, input: { workspaceId: string; goal: string; teamId?: string }) => {
      const workspace = getBusinessWorkspace(input.workspaceId);
      if (!workspace) {
        return { ok: false as const, errors: ["workspace not found"] };
      }
      const validation = validateBusinessWorkspace(workspace, businessAgents());
      if (!validation.ok) {
        return { ok: false as const, errors: validation.errors };
      }
      // Server is the source of truth: re-derive the assignment plan and
      // contract draft from the persisted workspace. Renderer-submitted
      // plans/snapshots are intentionally ignored.
      const derived = previewBusinessAssignment(workspace, input.goal);
      if (!derived.ok) return derived;
      return createRunFromAssignment({
        workspace,
        goal: input.goal,
        teamId: input.teamId,
        assignmentPlan: derived.assignmentPlan,
        contractDraft: derived.contractDraft
      });
    }
  );
  ipcMain.handle("businessRequirements:startRun", (event, runId: string) =>
    startBusinessRun(event.sender, runId)
  );
  ipcMain.handle("businessRequirements:getRun", (_e, runId: string) =>
    getBusinessRequirementRun(runId)
  );
  ipcMain.handle("businessRequirements:previewCommitGate", (_e, runId: string) =>
    previewBusinessCommitGateForRun(runId)
  );
  ipcMain.handle(
    "businessRequirements:approveCommitGate",
    (_e, args: { runId: string; patch?: CommitGatePatch }) =>
      approveBusinessCommitGateForRun(args.runId, args.patch ?? {})
  );
}

function businessAgents(): WorkflowAgentRef[] {
  return builtinCliMembers.map((m) => ({
    id: m.id,
    name: m.name,
    adapter: m.cli.adapter,
    enabled: m.enabled !== false
  }));
}

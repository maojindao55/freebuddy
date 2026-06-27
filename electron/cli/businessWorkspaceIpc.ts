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
  ipcMain.handle("businessRequirements:previewAssignment", () => ({
    ok: false as const,
    errors: ["assignment planner is not registered yet"]
  }));
}

function businessAgents(): WorkflowAgentRef[] {
  return builtinCliMembers.map((m) => ({
    id: m.id,
    name: m.name,
    adapter: m.cli.adapter,
    enabled: m.enabled !== false
  }));
}

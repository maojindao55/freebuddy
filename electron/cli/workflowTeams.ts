import { BrowserWindow } from "electron";
import { logMain } from "../debugLog.js";
import { safeSendToWebContents } from "./ipcSend.js";
import { getDb } from "./db.js";
import type {
  WorkflowTeam,
  WorkflowTeamPolicy,
  WorkflowTeamRole,
  WorkflowTemplate2
} from "./workflowTeamTypes.js";
import { builtinWorkflowTeams } from "./workflowTeamBuiltins.js";
import * as sqlite from "@freebuddy/storage-sqlite";

function notifyWorkflowTeamsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSendToWebContents(win.webContents, "workflowTeams://changed", undefined);
  }
}

export function auditTeamWrite(
  action: string,
  teamId: string,
  roles: WorkflowTeamRole[] | undefined,
  extra?: Record<string, unknown>
): void {
  try {
    logMain().info("workflowTeams", "audit write", {
      action,
      teamId,
      pid: process.pid,
      ppid: process.ppid,
      roleCount: roles?.length ?? 0,
      skillCounts: roles?.map((r) => ({ id: r.id, n: r.skillIds?.length ?? 0 })),
      ...extra
    });
  } catch {
    /* audit logging must never disrupt the write path */
  }
}

export function listWorkflowTeams(): WorkflowTeam[] {
  return sqlite.listWorkflowTeams(getDb());
}

export function getWorkflowTeam(id: string): WorkflowTeam | undefined {
  return sqlite.getWorkflowTeam(getDb(), id);
}

export type UpsertWorkflowTeamInput = sqlite.UpsertWorkflowTeamInput;
export type UpdateWorkflowTeamPatch = sqlite.UpdateWorkflowTeamPatch;

export function insertWorkflowTeam(input: UpsertWorkflowTeamInput): WorkflowTeam {
  auditTeamWrite("insert", input.id, input.roles, { source: input.source });
  const created = sqlite.insertWorkflowTeam(getDb(), input);
  notifyWorkflowTeamsChanged();
  return created;
}

export function updateWorkflowTeam(
  id: string,
  patch: UpdateWorkflowTeamPatch
): WorkflowTeam | undefined {
  const existing = getWorkflowTeam(id);
  if (!existing) return undefined;
  auditTeamWrite(
    "update",
    id,
    patch.roles ?? existing.roles,
    patch.roles !== undefined ? { changedRoles: true } : { changedRoles: false }
  );
  const updated = sqlite.updateWorkflowTeam(getDb(), id, patch);
  notifyWorkflowTeamsChanged();
  return updated;
}

export function deleteWorkflowTeam(id: string): boolean {
  const team = getWorkflowTeam(id);
  if (!team) return false;
  if (team.source === "builtin") return false;
  auditTeamWrite("delete", id, team.roles, { source: team.source });
  const ok = sqlite.deleteWorkflowTeam(getDb(), id);
  if (ok) notifyWorkflowTeamsChanged();
  return ok;
}

export { builtinWorkflowTeams };

const removedBuiltinWorkflowTeamIds = [
  "team-code-review",
  "team-readonly-analysis",
  "team-quick-implement",
  "team-implement-review-loop"
];

function mergeBuiltinRoles(existing: WorkflowTeam, builtin: WorkflowTeam): WorkflowTeamRole[] {
  const existingRoleById = new Map(existing.roles.map((role) => [role.id, role]));
  return builtin.roles.map((role) => {
    const savedRole = existingRoleById.get(role.id);
    return {
      ...role,
      agentId: savedRole?.agentId ?? role.agentId,
      ...(savedRole?.model ? { model: savedRole.model } : {}),
      ...(savedRole?.modelOptionId ? { modelOptionId: savedRole.modelOptionId } : {}),
      ...(savedRole?.thoughtLevel ? { thoughtLevel: savedRole.thoughtLevel } : {}),
      ...(savedRole?.thoughtLevelOptionId
        ? { thoughtLevelOptionId: savedRole.thoughtLevelOptionId }
        : {}),
      skillIds: savedRole?.skillIds ?? role.skillIds
    };
  });
}

function mergeBuiltinPolicy(existing: WorkflowTeam, builtin: WorkflowTeam): WorkflowTeamPolicy {
  return {
    ...builtin.policy,
    ...existing.policy,
    maxParallelWriteSteps: 1
  };
}

export function seedBuiltinWorkflowTeams(): void {
  logMain().info("workflowTeams", "seed builtins start", { pid: process.pid });
  const db = getDb();
  for (const id of removedBuiltinWorkflowTeamIds) {
    const row = sqlite.deleteBuiltinWorkflowTeam(db, id);
    if (row) {
      auditTeamWrite("seed-retire", id, row.roles_json ? JSON.parse(String(row.roles_json)) : undefined, {
        source: row.source
      });
    }
  }

  const existing = listWorkflowTeams();
  const existingById = new Map(existing.map((t) => [t.id, t]));
  for (const team of builtinWorkflowTeams()) {
    const saved = existingById.get(team.id);
    if (!saved) {
      auditTeamWrite("seed-insert", team.id, team.roles, { reason: "missing" });
      insertWorkflowTeam(team);
      continue;
    }
    if (saved.source !== "builtin") continue;
    const mergedRoles = mergeBuiltinRoles(saved, team);
    auditTeamWrite("seed-merge", team.id, mergedRoles, {
      savedSkillCounts: saved.roles.map((r) => ({ id: r.id, n: r.skillIds?.length ?? 0 }))
    });
    updateWorkflowTeam(team.id, {
      name: team.name,
      description: team.description,
      icon: team.icon,
      enabled: saved.enabled,
      roles: mergeBuiltinRoles(saved, team),
      template: team.template,
      policy: mergeBuiltinPolicy(saved, team)
    });
  }
  logMain().info("workflowTeams", "seed builtins done", { pid: process.pid });
}

export type { WorkflowTeam, WorkflowTemplate2 };

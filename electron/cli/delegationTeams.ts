import { BrowserWindow } from "electron";
import { getDb } from "./db.js";
import { logMain } from "../debugLog.js";
import { safeSendToWebContents } from "./ipcSend.js";
import type {
  DelegationPolicy,
  DelegationRosterEntry,
  DelegationTeam
} from "./delegationTeamTypes.js";
import { builtinDelegationTeams } from "./delegationTeamBuiltins.js";
import { auditTeamWrite } from "./workflowTeams.js";
import * as sqlite from "@freebuddy/storage-sqlite";

function notifyDelegationTeamsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSendToWebContents(win.webContents, "delegationTeams://changed", undefined);
  }
}

export function listDelegationTeams(): DelegationTeam[] {
  return sqlite.listDelegationTeams(getDb());
}

export function getDelegationTeam(id: string): DelegationTeam | undefined {
  return sqlite.getDelegationTeam(getDb(), id);
}

export type UpsertDelegationTeamInput = sqlite.UpsertDelegationTeamInput;
export type UpdateDelegationTeamPatch = sqlite.UpdateDelegationTeamPatch;

export function insertDelegationTeam(input: UpsertDelegationTeamInput): DelegationTeam {
  const created = sqlite.insertDelegationTeam(getDb(), input);
  notifyDelegationTeamsChanged();
  return created;
}

export function updateDelegationTeam(
  id: string,
  patch: UpdateDelegationTeamPatch
): DelegationTeam | undefined {
  const updated = sqlite.updateDelegationTeam(getDb(), id, patch);
  if (updated) notifyDelegationTeamsChanged();
  return updated;
}

export function deleteDelegationTeam(id: string): boolean {
  const ok = sqlite.deleteDelegationTeam(getDb(), id);
  if (ok) notifyDelegationTeamsChanged();
  return ok;
}

function mergeBuiltinRoster(saved: DelegationTeam, builtin: DelegationTeam): DelegationRosterEntry[] {
  const savedById = new Map(saved.roster.map((r) => [r.id, r]));
  return builtin.roster.map((r) => {
    const s = savedById.get(r.id);
    return {
      ...r,
      agentId: s?.agentId ?? r.agentId,
      ...(s?.model ? { model: s.model } : {}),
      ...(s?.modelOptionId ? { modelOptionId: s.modelOptionId } : {}),
      instructions: s?.instructions ?? r.instructions,
      skillIds: s?.skillIds ?? r.skillIds
    };
  });
}

export function seedBuiltinDelegationTeams(): void {
  logMain().info("delegationTeams", "seed builtins start", { pid: process.pid });
  for (const team of builtinDelegationTeams()) {
    const saved = getDelegationTeam(team.id);
    if (!saved) {
      auditTeamWrite("seed-insert", team.id, team.roster as never, { reason: "missing" });
      insertDelegationTeam(team);
      continue;
    }
    if (saved.source !== "builtin") continue;
    auditTeamWrite("seed-merge", team.id, mergeBuiltinRoster(saved, team) as never, {
      savedSkillCounts: saved.roster.map((r) => ({ id: r.id, n: r.skillIds?.length ?? 0 }))
    });
    updateDelegationTeam(team.id, {
      name: team.name,
      description: team.description,
      icon: team.icon,
      enabled: saved.enabled,
      entryRoleId: team.entryRoleId,
      roster: mergeBuiltinRoster(saved, team),
      policy: { ...team.policy, ...saved.policy }
    });
  }
  logMain().info("delegationTeams", "seed builtins done", { pid: process.pid });
}

export type { DelegationPolicy };

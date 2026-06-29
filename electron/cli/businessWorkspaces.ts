import { getDb } from "./db.js";
import type { BusinessWorkspace } from "./businessWorkspaceTypes.js";

function rowToWorkspace(row: any): BusinessWorkspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    surfaces: JSON.parse(row.surfaces_json),
    defaultTeamId: row.default_team_id ?? undefined,
    policy: JSON.parse(row.policy_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type UpsertBusinessWorkspaceInput = Omit<BusinessWorkspace, "createdAt" | "updatedAt">;
export type UpdateBusinessWorkspacePatch = Partial<Omit<UpsertBusinessWorkspaceInput, "id">>;

export function listBusinessWorkspaces(): BusinessWorkspace[] {
  const rows = getDb()
    .prepare("SELECT * FROM business_workspaces ORDER BY updated_at DESC")
    .all() as any[];
  return rows.map(rowToWorkspace);
}

export function getBusinessWorkspace(id: string): BusinessWorkspace | undefined {
  const row = getDb().prepare("SELECT * FROM business_workspaces WHERE id = ?").get(id) as any;
  return row ? rowToWorkspace(row) : undefined;
}

export function insertBusinessWorkspace(input: UpsertBusinessWorkspaceInput): BusinessWorkspace {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO business_workspaces
         (id, name, description, surfaces_json, default_team_id, policy_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.name,
      input.description ?? null,
      JSON.stringify(input.surfaces),
      input.defaultTeamId ?? null,
      JSON.stringify(input.policy),
      now,
      now
    );
  return getBusinessWorkspace(input.id) as BusinessWorkspace;
}

export function updateBusinessWorkspace(
  id: string,
  patch: UpdateBusinessWorkspacePatch
): BusinessWorkspace | undefined {
  const existing = getBusinessWorkspace(id);
  if (!existing) return undefined;
  const next: UpsertBusinessWorkspaceInput = {
    id,
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    surfaces: patch.surfaces ?? existing.surfaces,
    defaultTeamId: patch.defaultTeamId ?? existing.defaultTeamId,
    policy: patch.policy ?? existing.policy
  };
  getDb()
    .prepare(
      `UPDATE business_workspaces
       SET name = ?, description = ?, surfaces_json = ?, default_team_id = ?, policy_json = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.name,
      next.description ?? null,
      JSON.stringify(next.surfaces),
      next.defaultTeamId ?? null,
      JSON.stringify(next.policy),
      new Date().toISOString(),
      id
    );
  return getBusinessWorkspace(id);
}

export function deleteBusinessWorkspace(id: string): boolean {
  const existing = getBusinessWorkspace(id);
  if (!existing) return false;
  getDb().prepare("DELETE FROM business_workspaces WHERE id = ?").run(id);
  return true;
}

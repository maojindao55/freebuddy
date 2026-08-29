import type {
  DelegationPolicy,
  DelegationRosterEntry,
  DelegationTeam
} from "@freebuddy/protocol/delegation";
import type { SqliteDatabase } from "./types.js";

function defaultDelegationPolicy(): DelegationPolicy {
  return {
    allowWrites: true,
    requireApprovalBeforeDelegateWrite: true,
    maxDepth: 3,
    delegateTimeoutMs: 600000,
    maxConcurrentDelegates: 1,
    stopOnDelegateFailure: false
  };
}

function rowToDelegationTeam(r: Record<string, unknown>): DelegationTeam {
  const meta = r.delegation_meta_json ? JSON.parse(String(r.delegation_meta_json)) : {};
  return {
    id: String(r.id),
    name: String(r.name),
    description: (r.description as string | null) ?? undefined,
    sharedInstructions: meta.sharedInstructions ?? undefined,
    icon: (r.icon as string | null) ?? undefined,
    enabled: r.enabled === 1 || r.enabled === true,
    source: ((r.source as "builtin" | "user") ?? "user") as DelegationTeam["source"],
    kind: "delegation",
    entryRoleId: meta.entryRoleId ?? "",
    roster: JSON.parse(String(r.roles_json)) as DelegationRosterEntry[],
    policy: {
      ...defaultDelegationPolicy(),
      ...(JSON.parse(String(r.policy_json)) as Partial<DelegationPolicy>)
    },
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  };
}

export function listDelegationTeams(db: SqliteDatabase): DelegationTeam[] {
  const rows = db
    .prepare(
      "SELECT * FROM workflow_teams WHERE kind = 'delegation' ORDER BY source DESC, created_at ASC"
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToDelegationTeam);
}

export function getDelegationTeam(db: SqliteDatabase, id: string): DelegationTeam | undefined {
  const row = db
    .prepare("SELECT * FROM workflow_teams WHERE id = ? AND kind = 'delegation'")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToDelegationTeam(row) : undefined;
}

export interface UpsertDelegationTeamInput {
  id: string;
  name: string;
  description?: string;
  sharedInstructions?: string;
  icon?: string;
  enabled: boolean;
  source: "builtin" | "user";
  entryRoleId: string;
  roster: DelegationRosterEntry[];
  policy: DelegationPolicy;
}

export function insertDelegationTeam(
  db: SqliteDatabase,
  input: UpsertDelegationTeamInput,
  now = new Date().toISOString()
): DelegationTeam {
  db.prepare(
    `INSERT INTO workflow_teams
       (id, name, description, icon, enabled, source, kind,
        roles_json, template_json, policy_json, delegation_meta_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'delegation', ?, '{}', ?, ?, ?, ?)`
  ).run(
    input.id,
    input.name,
    input.description ?? null,
    input.icon ?? null,
    input.enabled ? 1 : 0,
    input.source,
    JSON.stringify(input.roster),
    JSON.stringify(input.policy),
    JSON.stringify({
      entryRoleId: input.entryRoleId,
      ...(input.sharedInstructions?.trim()
        ? { sharedInstructions: input.sharedInstructions.trim() }
        : {})
    }),
    now,
    now
  );
  return getDelegationTeam(db, input.id) as DelegationTeam;
}

export interface UpdateDelegationTeamPatch {
  name?: string;
  description?: string | null;
  sharedInstructions?: string | null;
  icon?: string | null;
  enabled?: boolean;
  entryRoleId?: string;
  roster?: DelegationRosterEntry[];
  policy?: DelegationPolicy;
}

export function updateDelegationTeam(
  db: SqliteDatabase,
  id: string,
  patch: UpdateDelegationTeamPatch
): DelegationTeam | undefined {
  const existing = getDelegationTeam(db, id);
  if (!existing) return undefined;
  const fields: string[] = ["updated_at = ?"];
  const params: unknown[] = [new Date().toISOString()];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    fields.push("description = ?");
    params.push(patch.description);
  }
  if (patch.icon !== undefined) {
    fields.push("icon = ?");
    params.push(patch.icon);
  }
  if (patch.enabled !== undefined) {
    fields.push("enabled = ?");
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.roster !== undefined) {
    fields.push("roles_json = ?");
    params.push(JSON.stringify(patch.roster));
  }
  if (patch.policy !== undefined) {
    fields.push("policy_json = ?");
    params.push(JSON.stringify(patch.policy));
  }
  if (patch.entryRoleId !== undefined || patch.sharedInstructions !== undefined) {
    fields.push("delegation_meta_json = ?");
    const sharedInstructions =
      patch.sharedInstructions === undefined
        ? existing.sharedInstructions
        : patch.sharedInstructions?.trim() || undefined;
    params.push(
      JSON.stringify({
        entryRoleId: patch.entryRoleId ?? existing.entryRoleId,
        ...(sharedInstructions ? { sharedInstructions } : {})
      })
    );
  }
  params.push(id);
  db.prepare(
    `UPDATE workflow_teams SET ${fields.join(", ")} WHERE id = ? AND kind = 'delegation'`
  ).run(...params);
  return getDelegationTeam(db, id);
}

export function deleteDelegationTeam(db: SqliteDatabase, id: string): boolean {
  const team = getDelegationTeam(db, id);
  if (!team || team.source === "builtin") return false;
  db.prepare("DELETE FROM workflow_teams WHERE id = ? AND kind = 'delegation'").run(id);
  return true;
}

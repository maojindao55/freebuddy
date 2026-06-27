import { getDb } from "./db.js";
import type { BusinessRequirementRun } from "./businessWorkspaceTypes.js";

function rowToRun(row: any): BusinessRequirementRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceSnapshot: JSON.parse(row.workspace_snapshot_json),
    teamId: row.team_id ?? undefined,
    goal: row.goal,
    status: row.status,
    assignmentPlan: row.assignment_plan_json ? JSON.parse(row.assignment_plan_json) : undefined,
    contractDraft: row.contract_draft_json ? JSON.parse(row.contract_draft_json) : undefined,
    surfaceRuns: JSON.parse(row.surface_runs_json),
    commitGate: row.commit_gate_json ? JSON.parse(row.commit_gate_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type InsertBusinessRequirementRunInput = Omit<
  BusinessRequirementRun,
  "createdAt" | "updatedAt"
>;

export type UpdateBusinessRequirementRunPatch = Partial<
  Pick<
    BusinessRequirementRun,
    | "status"
    | "assignmentPlan"
    | "contractDraft"
    | "surfaceRuns"
    | "commitGate"
  >
>;

export function insertBusinessRequirementRun(
  input: InsertBusinessRequirementRunInput
): BusinessRequirementRun {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO business_requirement_runs
         (id, workspace_id, workspace_snapshot_json, team_id, goal, status,
          assignment_plan_json, contract_draft_json, surface_runs_json, commit_gate_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.workspaceId,
      JSON.stringify(input.workspaceSnapshot),
      input.teamId ?? null,
      input.goal,
      input.status,
      input.assignmentPlan ? JSON.stringify(input.assignmentPlan) : null,
      input.contractDraft ? JSON.stringify(input.contractDraft) : null,
      JSON.stringify(input.surfaceRuns),
      input.commitGate ? JSON.stringify(input.commitGate) : null,
      now,
      now
    );
  return getBusinessRequirementRun(input.id) as BusinessRequirementRun;
}

export function getBusinessRequirementRun(id: string): BusinessRequirementRun | undefined {
  const row = getDb()
    .prepare("SELECT * FROM business_requirement_runs WHERE id = ?")
    .get(id) as any;
  return row ? rowToRun(row) : undefined;
}

export function updateBusinessRequirementRun(
  id: string,
  patch: UpdateBusinessRequirementRunPatch
): BusinessRequirementRun | undefined {
  const existing = getBusinessRequirementRun(id);
  if (!existing) return undefined;
  const fields: string[] = ["updated_at = ?"];
  const params: any[] = [new Date().toISOString()];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    params.push(patch.status);
  }
  if (patch.assignmentPlan !== undefined) {
    fields.push("assignment_plan_json = ?");
    params.push(JSON.stringify(patch.assignmentPlan));
  }
  if (patch.contractDraft !== undefined) {
    fields.push("contract_draft_json = ?");
    params.push(JSON.stringify(patch.contractDraft));
  }
  if (patch.surfaceRuns !== undefined) {
    fields.push("surface_runs_json = ?");
    params.push(JSON.stringify(patch.surfaceRuns));
  }
  if (patch.commitGate !== undefined) {
    fields.push("commit_gate_json = ?");
    params.push(JSON.stringify(patch.commitGate));
  }
  params.push(id);
  getDb()
    .prepare(`UPDATE business_requirement_runs SET ${fields.join(", ")} WHERE id = ?`)
    .run(...params);
  return getBusinessRequirementRun(id);
}

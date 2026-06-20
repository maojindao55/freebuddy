import { getDb } from "./db.js";
import type {
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStepRow,
  WorkflowStepStatus
} from "./workflowTypes.js";

function rowToRun(r: any): WorkflowRunRow {
  return {
    id: r.id,
    conversationId: r.conversation_id ?? undefined,
    name: r.name,
    goal: r.goal,
    status: r.status as WorkflowRunStatus,
    cwd: r.cwd ?? undefined,
    template: r.template ?? undefined,
    loopIndex: r.loop_index,
    maxLoops: r.max_loops,
    planJson: r.plan_json,
    summary: r.summary ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at ?? undefined
  };
}

function rowToStep(r: any): WorkflowStepRow {
  return {
    id: r.id,
    workflowRunId: r.workflow_run_id,
    phaseId: r.phase_id,
    stepId: r.step_id,
    title: r.title,
    agentId: r.agent_id,
    agentName: r.agent_name,
    adapter: r.adapter,
    mode: r.mode,
    status: r.status as WorkflowStepStatus,
    prompt: r.prompt,
    dependsOn: r.depends_on ? (JSON.parse(r.depends_on) as string[]) : undefined,
    targetPaths: r.target_paths
      ? (JSON.parse(r.target_paths) as string[])
      : undefined,
    summary: r.summary ?? undefined,
    resultJson: r.result_json ?? undefined,
    cliTaskId: r.cli_task_id ?? undefined,
    startedAt: r.started_at ?? undefined,
    endedAt: r.ended_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export interface CreateWorkflowRunInput {
  id: string;
  conversationId?: string;
  name: string;
  goal: string;
  cwd?: string;
  template?: string;
  maxLoops: number;
  planJson: string;
  status?: WorkflowRunStatus;
}

export function createWorkflowRun(input: CreateWorkflowRunInput): WorkflowRunRow {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO workflow_runs
         (id, conversation_id, name, goal, status, cwd, template,
          loop_index, max_loops, plan_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.conversationId ?? null,
      input.name,
      input.goal,
      input.status ?? "pending_approval",
      input.cwd ?? null,
      input.template ?? null,
      input.maxLoops,
      input.planJson,
      now,
      now
    );
  return getWorkflowRun(input.id) as WorkflowRunRow;
}

export interface UpdateWorkflowRunPatch {
  status?: WorkflowRunStatus;
  loopIndex?: number;
  summary?: string;
  endedAt?: string | null;
}

export function updateWorkflowRun(
  id: string,
  patch: UpdateWorkflowRunPatch
): void {
  const fields: string[] = ["updated_at = ?"];
  const params: any[] = [new Date().toISOString()];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    params.push(patch.status);
  }
  if (patch.loopIndex !== undefined) {
    fields.push("loop_index = ?");
    params.push(patch.loopIndex);
  }
  if (patch.summary !== undefined) {
    fields.push("summary = ?");
    params.push(patch.summary);
  }
  if (patch.endedAt !== undefined) {
    fields.push("ended_at = ?");
    params.push(patch.endedAt);
  }
  params.push(id);
  getDb()
    .prepare(`UPDATE workflow_runs SET ${fields.join(", ")} WHERE id = ?`)
    .run(...params);
}

export function getWorkflowRun(id: string): WorkflowRunRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM workflow_runs WHERE id = ?`)
    .get(id) as any;
  return row ? rowToRun(row) : undefined;
}

export function listWorkflowRunsByConversation(
  conversationId: string
): WorkflowRunRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM workflow_runs WHERE conversation_id = ?
       ORDER BY created_at DESC`
    )
    .all(conversationId) as any[];
  return rows.map(rowToRun);
}

export function listActiveWorkflowRuns(): WorkflowRunRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM workflow_runs
       WHERE status IN ('running','paused','blocked','pending_approval')
       ORDER BY created_at DESC`
    )
    .all() as any[];
  return rows.map(rowToRun);
}

export interface CreateWorkflowStepInput {
  id: string;
  workflowRunId: string;
  phaseId: string;
  stepId: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  mode: string;
  prompt: string;
  dependsOn?: string[];
  targetPaths?: string[];
}

export function createWorkflowStep(input: CreateWorkflowStepInput): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO workflow_steps
         (id, workflow_run_id, phase_id, step_id, title, agent_id, agent_name,
          adapter, mode, status, prompt, depends_on, target_paths,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.workflowRunId,
      input.phaseId,
      input.stepId,
      input.title,
      input.agentId,
      input.agentName,
      input.adapter,
      input.mode,
      input.prompt,
      input.dependsOn ? JSON.stringify(input.dependsOn) : null,
      input.targetPaths ? JSON.stringify(input.targetPaths) : null,
      now,
      now
    );
}

export interface UpdateWorkflowStepPatch {
  status?: WorkflowStepStatus;
  summary?: string;
  resultJson?: string;
  cliTaskId?: string;
  startedAt?: string;
  endedAt?: string;
}

export function updateWorkflowStep(
  id: string,
  patch: UpdateWorkflowStepPatch
): void {
  const fields: string[] = ["updated_at = ?"];
  const params: any[] = [new Date().toISOString()];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    params.push(patch.status);
  }
  if (patch.summary !== undefined) {
    fields.push("summary = ?");
    params.push(patch.summary);
  }
  if (patch.resultJson !== undefined) {
    fields.push("result_json = ?");
    params.push(patch.resultJson);
  }
  if (patch.cliTaskId !== undefined) {
    fields.push("cli_task_id = ?");
    params.push(patch.cliTaskId);
  }
  if (patch.startedAt !== undefined) {
    fields.push("started_at = ?");
    params.push(patch.startedAt);
  }
  if (patch.endedAt !== undefined) {
    fields.push("ended_at = ?");
    params.push(patch.endedAt);
  }
  params.push(id);
  getDb()
    .prepare(`UPDATE workflow_steps SET ${fields.join(", ")} WHERE id = ?`)
    .run(...params);
}

export function getWorkflowSteps(runId: string): WorkflowStepRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM workflow_steps WHERE workflow_run_id = ?
       ORDER BY created_at ASC`
    )
    .all(runId) as any[];
  return rows.map(rowToStep);
}

/** Reset a set of phase steps back to pending for Review Loop re-execution. */
export function resetWorkflowStepsForLoop(
  runId: string,
  phaseIds: string[]
): void {
  if (phaseIds.length === 0) return;
  const placeholders = phaseIds.map(() => "?").join(",");
  getDb()
    .prepare(
      `UPDATE workflow_steps
         SET status = 'pending', summary = NULL, result_json = NULL,
             cli_task_id = NULL, started_at = NULL, ended_at = NULL,
             updated_at = ?
       WHERE workflow_run_id = ? AND phase_id IN (${placeholders})`
    )
    .run(new Date().toISOString(), runId, ...phaseIds);
}

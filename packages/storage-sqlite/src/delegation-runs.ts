import { randomUUID } from "node:crypto";
import type { WorkflowRunStatus } from "@freebuddy/protocol/workflow";
import type {
  DelegationArtifact,
  DelegationEvent,
  DelegationEventStatus,
  DelegationResult,
  DelegationRunRow,
  DelegationVerdict
} from "@freebuddy/protocol/delegation";
import { canAccessDelegationRun, getDelegationRunOwnerId, ownsConversation } from "./owner.js";
import type { SqliteStoreContext } from "./types.js";

const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "killed", "partial"]);
const ACTIVE_DELEGATION_STATUSES = ["running", "pending"] as const;
const TERMINAL_DELEGATION_STATUSES = ["done", "failed", "timeout", "cancelled"] as const;

export type CreateDelegationRunInput = {
  id?: string;
  goal: string;
  cwd?: string;
  teamId: string;
  teamSnapshotJson: string;
  conversationId?: string;
  runtimeVersion?: string | null;
  runtimeApiVersion?: string | null;
};

export type DelegationRunFinishedEvent = {
  runId: string;
  conversationId?: string;
  status: string;
  name: string;
};

function nowIso(ctx: SqliteStoreContext): string {
  return ctx.nowIso?.() ?? new Date().toISOString();
}

function isSqliteConstraint(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? "";
  return code.startsWith("SQLITE_CONSTRAINT");
}

function workflowRunIdExists(ctx: SqliteStoreContext, id: string): boolean {
  return Boolean(
    ctx.db.prepare("SELECT id FROM workflow_runs WHERE id = ?").get(id) as { id: string } | undefined
  );
}

function delegationEventIdExists(ctx: SqliteStoreContext, id: string): boolean {
  return Boolean(
    ctx.db.prepare("SELECT id FROM delegation_events WHERE id = ?").get(id) as
      | { id: string }
      | undefined
  );
}

export function mapDelegationRunRow(r: Record<string, unknown>): DelegationRunRow {
  return {
    id: String(r.id),
    kind: "delegation",
    conversationId: (r.conversation_id as string | null) ?? null,
    name: typeof r.name === "string" && r.name.trim() ? r.name : String(r.goal),
    goal: String(r.goal),
    status: String(r.status),
    cwd: (r.cwd as string | null) ?? null,
    teamId: (r.team_id as string | null) ?? null,
    teamSnapshotJson: (r.team_snapshot_json as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    endedAt: (r.ended_at as string | null) ?? null,
    runtimeVersion: (r.runtime_version as string | null) ?? undefined,
    runtimeApiVersion: (r.runtime_api_version as string | null) ?? undefined
  };
}

export function callerCanAccessDelegationRun(ctx: SqliteStoreContext, runId: string): boolean {
  return canAccessDelegationRun(ctx.db, ctx.owner, runId);
}

export function lookupDelegationRunOwnerId(ctx: SqliteStoreContext, runId: string): string | null {
  return getDelegationRunOwnerId(ctx.db, runId);
}

export function createDelegationRun(ctx: SqliteStoreContext, input: CreateDelegationRunInput): string {
  const id = input.id ?? randomUUID();
  const already = ctx.db.prepare("SELECT id FROM workflow_runs WHERE id = ?").get(id) as
    | { id: string }
    | undefined;
  if (already) return already.id;
  const now = nowIso(ctx);
  try {
    ctx.db
      .prepare(
        `INSERT INTO workflow_runs
         (id, conversation_id, name, goal, status, cwd, template,
          loop_index, max_loops, plan_json, team_id, team_snapshot_json, kind,
          runtime_version, runtime_api_version,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, 'delegation', 0, 1, '{}', ?, ?, 'delegation', ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId ?? null,
        input.goal.slice(0, 80) || "Delegation run",
        input.goal,
        input.cwd ?? null,
        input.teamId,
        input.teamSnapshotJson,
        input.runtimeVersion ?? null,
        input.runtimeApiVersion ?? null,
        now,
        now
      );
  } catch (error) {
    if (isSqliteConstraint(error) && workflowRunIdExists(ctx, id)) return id;
    throw error;
  }
  return id;
}

export function getDelegationRun(
  ctx: SqliteStoreContext,
  id: string
): DelegationRunRow | undefined {
  const r = ctx.db
    .prepare("SELECT * FROM workflow_runs WHERE id = ? AND kind = 'delegation'")
    .get(id) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  const run = mapDelegationRunRow(r);
  return ownsConversation(ctx.db, ctx.owner, run.conversationId) ? run : undefined;
}

export function getDelegationRunByConversation(
  ctx: SqliteStoreContext,
  conversationId: string
): DelegationRunRow | undefined {
  if (!ownsConversation(ctx.db, ctx.owner, conversationId)) return undefined;
  const r = ctx.db
    .prepare(
      "SELECT * FROM workflow_runs WHERE kind = 'delegation' AND conversation_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(conversationId) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return mapDelegationRunRow(r);
}

export function setDelegationRunStatus(
  ctx: SqliteStoreContext,
  id: string,
  status: WorkflowRunStatus | string,
  options?: { allowReopen?: boolean }
): { ok: boolean; previous?: DelegationRunRow } {
  const previous = getDelegationRun(ctx, id);
  if (!previous) return { ok: false };
  if (
    TERMINAL_RUN_STATUSES.has(previous.status) &&
    previous.status !== status &&
    !options?.allowReopen
  ) {
    return { ok: false, previous };
  }
  const now = nowIso(ctx);
  const result = ctx.db
    .prepare(
      `UPDATE workflow_runs SET status = ?, updated_at = ?, ended_at = ?
       WHERE id = ? AND kind = 'delegation' AND status = ?`
    )
    .run(
      status,
      now,
      TERMINAL_RUN_STATUSES.has(status) ? now : null,
      id,
      previous.status
    );
  return { ok: result.changes > 0, previous };
}

function parseDelegationResult(value: unknown): DelegationResult | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as DelegationResult;
    return parsed?.schemaVersion === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function rowToDelegationEvent(r: Record<string, unknown>): DelegationEvent {
  const verdict = (r.verdict as DelegationVerdict | null) ?? null;
  const verdictSummary = (r.verdict_summary as string | null) ?? null;
  const storedResult = parseDelegationResult(r.result_json);
  return {
    id: String(r.id),
    runId: String(r.run_id),
    parentEventId: (r.parent_event_id as string | null) ?? null,
    agentId: String(r.agent_id),
    agentName: String(r.agent_name),
    roleLabel: String(r.role_label),
    taskText: String(r.task_text),
    depth: Number(r.depth ?? 0),
    status: r.status as DelegationEventStatus,
    resultSummary: (r.result_summary as string | null) ?? null,
    result: storedResult ? { ...storedResult, verdict, verdictSummary } : null,
    canWrite: r.can_write === 1 || r.can_write === true,
    acceptedAt: (r.accepted_at as string | null) ?? (r.started_at as string | null) ?? null,
    startedAt: (r.started_at as string | null) ?? null,
    endedAt: (r.ended_at as string | null) ?? null,
    verdict,
    verdictSummary
  };
}

export type InsertDelegationEventInput = {
  id?: string;
  runId: string;
  parentEventId: string | null;
  agentId: string;
  agentName: string;
  roleLabel: string;
  taskText: string;
  depth: number;
  canWrite: boolean;
  status: DelegationEventStatus;
};

function createDelegationEventId(): string {
  return randomUUID();
}

const INSERT_DELEGATION_EVENT_SQL = `INSERT INTO delegation_events
  (id, run_id, parent_event_id, agent_id, agent_name, role_label,
   task_text, depth, status, result_summary, can_write, accepted_at, started_at, ended_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`;

export function insertDelegationEvent(
  ctx: SqliteStoreContext,
  input: InsertDelegationEventInput
): string {
  const id = input.id ?? createDelegationEventId();
  if (input.id) {
    const existing = getDelegationEvent(ctx, input.id);
    if (existing) return existing.id;
  }
  const now = nowIso(ctx);
  try {
    ctx.db
      .prepare(INSERT_DELEGATION_EVENT_SQL)
      .run(
        id,
        input.runId,
        input.parentEventId,
        input.agentId,
        input.agentName,
        input.roleLabel,
        input.taskText,
        input.depth,
        input.status,
        input.canWrite ? 1 : 0,
        now,
        input.status === "running" ? now : null
      );
  } catch (error) {
    if (isSqliteConstraint(error) && delegationEventIdExists(ctx, id)) return id;
    throw error;
  }
  return id;
}

export function insertDelegationEventsAtomic(
  ctx: SqliteStoreContext,
  inputs: InsertDelegationEventInput[]
): string[] {
  if (inputs.length === 0) return [];
  const statement = ctx.db.prepare(INSERT_DELEGATION_EVENT_SQL);
  const tx = ctx.db.transaction(() =>
    inputs.map((input) => {
      const id = input.id ?? createDelegationEventId();
      if (input.id) {
        const existing = getDelegationEvent(ctx, input.id);
        if (existing) return existing.id;
      }
      const now = nowIso(ctx);
      try {
        statement.run(
          id,
          input.runId,
          input.parentEventId,
          input.agentId,
          input.agentName,
          input.roleLabel,
          input.taskText,
          input.depth,
          input.status,
          input.canWrite ? 1 : 0,
          now,
          input.status === "running" ? now : null
        );
      } catch (error) {
        if (isSqliteConstraint(error) && delegationEventIdExists(ctx, id)) return id;
        throw error;
      }
      return id;
    })
  );
  return tx();
}

type TerminalDelegationStatus = DelegationResult["status"];

export function buildDelegationResult(input: {
  status: TerminalDelegationStatus;
  summary?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  artifacts?: DelegationArtifact[];
  verdict?: DelegationVerdict | null;
  verdictSummary?: string | null;
}): DelegationResult {
  const summary = input.summary ?? input.errorMessage ?? "";
  const error =
    input.status === "done"
      ? null
      : {
          code:
            input.status === "timeout"
              ? ("delegate_timeout" as const)
              : input.status === "cancelled"
                ? ("delegate_cancelled" as const)
                : ("delegate_failed" as const),
          message: input.errorMessage ?? summary,
          retryable: input.status !== "cancelled"
        };
  return {
    schemaVersion: 1,
    status: input.status,
    summary,
    exitCode: input.exitCode ?? null,
    error,
    artifacts: input.artifacts ?? [],
    verdict: input.verdict ?? null,
    verdictSummary: input.verdictSummary ?? null
  };
}

const EVENT_TRANSITION_SOURCES: Record<DelegationEventStatus, DelegationEventStatus[]> = {
  pending: [],
  running: ["pending"],
  done: ["running"],
  failed: ["pending", "running"],
  timeout: ["pending", "running"],
  cancelled: ["pending", "running"]
};

export function isTerminalDelegationStatus(status: string): boolean {
  return (TERMINAL_DELEGATION_STATUSES as readonly string[]).includes(status);
}

export function transitionDelegationEvent(
  ctx: SqliteStoreContext,
  id: string,
  status: DelegationEventStatus,
  resultSummary?: string | null,
  options?: { allowReopen?: boolean; result?: DelegationResult | null }
): boolean {
  const sources = options?.allowReopen
    ? (["pending", "running", "done", "failed", "timeout", "cancelled"] as DelegationEventStatus[])
    : EVENT_TRANSITION_SOURCES[status];
  if (sources.length === 0) return false;
  const terminal = isTerminalDelegationStatus(status);
  const transitionedAt = nowIso(ctx);
  const current = ctx.db
    .prepare("SELECT status, verdict, verdict_summary FROM delegation_events WHERE id = ?")
    .get(id) as
      | {
          status?: DelegationEventStatus;
          verdict?: DelegationVerdict | null;
          verdict_summary?: string | null;
        }
      | undefined;
  const resetAttemptStart =
    options?.allowReopen === true &&
    status === "running" &&
    isTerminalDelegationStatus(current?.status ?? "");
  const structuredResult = terminal
    ? {
        ...(options?.result ??
          buildDelegationResult({
            status: status as TerminalDelegationStatus,
            summary: resultSummary
          })),
        status: status as TerminalDelegationStatus,
        summary: resultSummary ?? options?.result?.summary ?? "",
        verdict: current?.verdict ?? options?.result?.verdict ?? null,
        verdictSummary: current?.verdict_summary ?? options?.result?.verdictSummary ?? null
      }
    : null;
  const placeholders = sources.map(() => "?").join(",");
  const result = ctx.db
    .prepare(
      `UPDATE delegation_events
       SET status = ?, result_summary = ?, result_json = ?,
           started_at = CASE
             WHEN ? = 'running' AND ? = 1 THEN ?
             WHEN ? = 'running' THEN COALESCE(started_at, ?)
             ELSE started_at
           END,
           ended_at = ?
       WHERE id = ? AND status IN (${placeholders})`
    )
    .run(
      status,
      resultSummary ?? null,
      structuredResult ? JSON.stringify(structuredResult) : null,
      status,
      resetAttemptStart ? 1 : 0,
      transitionedAt,
      status,
      transitionedAt,
      terminal ? transitionedAt : null,
      id,
      ...sources
    );
  return result.changes > 0;
}

export function updateDelegationEvent(
  ctx: SqliteStoreContext,
  id: string,
  patch: {
    status?: DelegationEventStatus;
    resultSummary?: string | null;
    verdict?: DelegationVerdict | null;
    verdictSummary?: string | null;
  }
): void {
  if (patch.status !== undefined) {
    transitionDelegationEvent(ctx, id, patch.status, patch.resultSummary);
    patch = { ...patch, status: undefined, resultSummary: undefined };
  }
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.resultSummary !== undefined) {
    fields.push("result_summary = ?");
    params.push(patch.resultSummary);
  }
  if (patch.verdict !== undefined) {
    fields.push("verdict = ?");
    params.push(patch.verdict);
  }
  if (patch.verdictSummary !== undefined) {
    fields.push("verdict_summary = ?");
    params.push(patch.verdictSummary);
  }
  if (fields.length === 0) return;
  params.push(id);
  ctx.db.prepare(`UPDATE delegation_events SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  if (patch.verdict !== undefined || patch.verdictSummary !== undefined) {
    const row = ctx.db
      .prepare("SELECT result_json, verdict, verdict_summary FROM delegation_events WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    const stored = parseDelegationResult(row?.result_json);
    if (stored) {
      ctx.db
        .prepare("UPDATE delegation_events SET result_json = ? WHERE id = ?")
        .run(
          JSON.stringify({
            ...stored,
            verdict: (row?.verdict as DelegationVerdict | null) ?? null,
            verdictSummary: (row?.verdict_summary as string | null) ?? null
          }),
          id
        );
    }
  }
}

export function listDelegationEvents(ctx: SqliteStoreContext, runId: string): DelegationEvent[] {
  if (!callerCanAccessDelegationRun(ctx, runId)) return [];
  const rows = ctx.db
    .prepare(
      "SELECT * FROM delegation_events WHERE run_id = ? ORDER BY COALESCE(accepted_at, started_at) ASC"
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(rowToDelegationEvent);
}

export function getDelegationEvent(
  ctx: SqliteStoreContext,
  id: string
): DelegationEvent | undefined {
  const row = ctx.db.prepare("SELECT * FROM delegation_events WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row || !callerCanAccessDelegationRun(ctx, String(row.run_id))) return undefined;
  return rowToDelegationEvent(row);
}

export function countActiveDelegationEvents(ctx: SqliteStoreContext, runId: string): number {
  const placeholders = ACTIVE_DELEGATION_STATUSES.map(() => "?").join(",");
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM delegation_events
       WHERE run_id = ? AND parent_event_id IS NOT NULL AND status IN (${placeholders})`
    )
    .get(runId, ...ACTIVE_DELEGATION_STATUSES) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function countRunningDelegationEvents(ctx: SqliteStoreContext, runId: string): number {
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM delegation_events
       WHERE run_id = ? AND parent_event_id IS NOT NULL AND status = 'running'`
    )
    .get(runId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function countActiveDelegateLeaves(ctx: SqliteStoreContext, runId: string): number {
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM delegation_events AS d
       WHERE d.run_id = ? AND d.parent_event_id IS NOT NULL AND d.status = 'running'
         AND NOT EXISTS (
           SELECT 1 FROM delegation_events AS c
           WHERE c.run_id = d.run_id AND c.parent_event_id = d.id
             AND c.status IN ('running','pending')
         )`
    )
    .get(runId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function cancelActiveDelegationEvents(
  ctx: SqliteStoreContext,
  runId: string,
  reason: string
): string[] {
  const active = listDelegationEvents(ctx, runId).filter(
    (e) => e.status === "pending" || e.status === "running"
  );
  const ids: string[] = [];
  for (const ev of active) {
    if (transitionDelegationEvent(ctx, ev.id, "cancelled", reason)) ids.push(ev.id);
  }
  return ids;
}

export function listPendingChildEvents(
  ctx: SqliteStoreContext,
  runId: string,
  parentEventId: string
): DelegationEvent[] {
  const placeholders = ACTIVE_DELEGATION_STATUSES.map(() => "?").join(",");
  const rows = ctx.db
    .prepare(
      `SELECT * FROM delegation_events
       WHERE run_id = ? AND parent_event_id = ? AND status IN (${placeholders})
       ORDER BY started_at ASC`
    )
    .all(runId, parentEventId, ...ACTIVE_DELEGATION_STATUSES) as Record<string, unknown>[];
  return rows.map(rowToDelegationEvent);
}

export function recoverInterruptedDelegationRuns(ctx: SqliteStoreContext): number {
  const now = nowIso(ctx);
  const rows = ctx.db
    .prepare(
      "SELECT id FROM workflow_runs WHERE kind = 'delegation' AND status IN ('running','blocked')"
    )
    .all() as Array<{ id: string }>;
  const update = ctx.db.prepare(
    "UPDATE workflow_runs SET status = 'failed', summary = COALESCE(summary, 'Interrupted by app restart.'), updated_at = ? WHERE id = ? AND status IN ('running','blocked')"
  );
  const interruptedEvents = ctx.db
    .prepare("SELECT id FROM delegation_events WHERE status IN ('pending','running')")
    .all() as Array<{ id: string }>;
  for (const row of rows) update.run(now, row.id);
  for (const event of interruptedEvents) {
    transitionDelegationEvent(ctx, event.id, "failed", "Interrupted by app restart.");
  }
  return rows.length;
}

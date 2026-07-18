import type { Database as DB } from "better-sqlite3";

import { getDb } from "./db.js";
import {
  normalizeUsageSessionKey,
  tokscaleClientForAdapter,
  type AgentUsagePeriod,
  type TokscaleUsageReport
} from "./usageCore.js";

let testDb: DB | null = null;

function usageDb(): DB {
  return testDb ?? getDb();
}

/** Test-only database injection; production always uses FreeBuddy's singleton. */
export function setUsageDbForTest(db: DB | null): void {
  testDb = db;
}

interface UsageTaskRow {
  id: string;
  agent_id: string;
  agent_name: string;
  adapter: string;
  base_adapter: string | null;
  tool_session_id: string | null;
  created_at: string;
  updated_at: string;
}

function upsertAgentUsageSession(
  db: DB,
  task: UsageTaskRow,
  statement = db.prepare(UPSERT_AGENT_USAGE_SESSION_SQL)
): boolean {
  const toolSessionId = task.tool_session_id?.trim();
  if (!toolSessionId) return false;
  const client = tokscaleClientForAdapter(task.adapter, task.base_adapter);
  if (!client) return false;
  const sessionKey = normalizeUsageSessionKey(client, toolSessionId);
  if (!sessionKey) return false;

  statement.run(
    client,
    sessionKey,
    toolSessionId,
    task.adapter,
    task.agent_id,
    task.agent_name,
    task.id,
    task.id,
    task.created_at,
    task.updated_at
  );
  return true;
}

const UPSERT_AGENT_USAGE_SESSION_SQL = `
  INSERT INTO agent_usage_sessions
       (client, session_key, tool_session_id, adapter, agent_id, agent_name,
        first_task_id, last_task_id, ambiguous, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT(client, session_key) DO UPDATE SET
    tool_session_id = excluded.tool_session_id,
    adapter = excluded.adapter,
    last_task_id = excluded.last_task_id,
    last_seen_at = excluded.last_seen_at,
    agent_name = CASE
      WHEN agent_usage_sessions.agent_id = excluded.agent_id
      THEN excluded.agent_name
      ELSE agent_usage_sessions.agent_name
    END,
    ambiguous = CASE
      WHEN agent_usage_sessions.agent_id = excluded.agent_id
      THEN agent_usage_sessions.ambiguous
      ELSE 1
    END
`;

const TASK_WITH_BASE_ADAPTER_SQL = `
  SELECT t.id, t.agent_id, t.agent_name, t.adapter, o.base_adapter,
         t.tool_session_id, t.created_at, t.updated_at
  FROM cli_tasks t
  LEFT JOIN cli_executor_overrides o ON o.id = t.adapter
`;

export function linkAgentUsageSessionForTask(taskId: string): boolean {
  const db = usageDb();
  const task = db
    .prepare(`${TASK_WITH_BASE_ADAPTER_SQL} WHERE t.id = ?`)
    .get(taskId) as UsageTaskRow | undefined;
  return task ? upsertAgentUsageSession(db, task) : false;
}

/** Populate links for sessions created before usage collection was installed. */
export function backfillAgentUsageSessions(): number {
  const db = usageDb();
  const tasks = db
    .prepare(
      `${TASK_WITH_BASE_ADAPTER_SQL}
       WHERE t.tool_session_id IS NOT NULL AND TRIM(t.tool_session_id) <> ''
       ORDER BY t.created_at ASC`
    )
    .all() as UsageTaskRow[];
  let linked = 0;
  const upsert = db.prepare(UPSERT_AGENT_USAGE_SESSION_SQL);
  db.transaction(() => {
    for (const task of tasks) {
      if (upsertAgentUsageSession(db, task, upsert)) linked += 1;
    }
  })();
  return linked;
}

export interface StoredUsageScanResult {
  reportEntries: number;
  attributedEntries: number;
  attributedSessions: number;
}

export function storeTokscaleUsageReport(
  report: TokscaleUsageReport,
  scannedAt = new Date().toISOString()
): StoredUsageScanResult {
  const db = usageDb();
  const linkedRows = db
    .prepare(
      `SELECT client, session_key
       FROM agent_usage_sessions
       WHERE ambiguous = 0`
    )
    .all() as Array<{ client: string; session_key: string }>;
  const linked = new Set(
    linkedRows.map((row) => `${row.client}\u0000${row.session_key}`)
  );
  const attributedSessions = new Set<string>();
  let attributedEntries = 0;

  const upsert = db.prepare(
    `INSERT INTO agent_usage_snapshots
       (client, session_key, source_session_id, model_id, provider_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, message_count, estimated_cost_usd,
        first_observed_at, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client, session_key, model_id) DO UPDATE SET
       source_session_id = excluded.source_session_id,
       provider_id = excluded.provider_id,
       input_tokens = MAX(agent_usage_snapshots.input_tokens, excluded.input_tokens),
       output_tokens = MAX(agent_usage_snapshots.output_tokens, excluded.output_tokens),
       cache_read_tokens = MAX(agent_usage_snapshots.cache_read_tokens, excluded.cache_read_tokens),
       cache_write_tokens = MAX(agent_usage_snapshots.cache_write_tokens, excluded.cache_write_tokens),
       reasoning_tokens = MAX(agent_usage_snapshots.reasoning_tokens, excluded.reasoning_tokens),
       message_count = MAX(agent_usage_snapshots.message_count, excluded.message_count),
       estimated_cost_usd = MAX(agent_usage_snapshots.estimated_cost_usd, excluded.estimated_cost_usd),
       scanned_at = excluded.scanned_at`
  );

  db.transaction(() => {
    for (const entry of report.entries) {
      const linkKey = `${entry.client}\u0000${entry.sessionKey}`;
      if (!linked.has(linkKey)) continue;
      upsert.run(
        entry.client,
        entry.sessionKey,
        entry.sessionId,
        entry.modelId,
        entry.providerId,
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheReadTokens,
        entry.cacheWriteTokens,
        entry.reasoningTokens,
        entry.messageCount,
        entry.estimatedCostUsd,
        scannedAt,
        scannedAt
      );
      attributedEntries += 1;
      attributedSessions.add(linkKey);
    }
  })();

  return {
    reportEntries: report.entries.length,
    attributedEntries,
    attributedSessions: attributedSessions.size
  };
}

/** Replace the cache for one bounded period with a fresh tokscale report. */
export function storeTokscaleUsagePeriodReport(
  period: Exclude<AgentUsagePeriod, "all">,
  report: TokscaleUsageReport,
  scannedAt = new Date().toISOString()
): StoredUsageScanResult {
  const db = usageDb();
  const linkedRows = db
    .prepare(
      `SELECT client, session_key
       FROM agent_usage_sessions
       WHERE ambiguous = 0`
    )
    .all() as Array<{ client: string; session_key: string }>;
  const linked = new Set(
    linkedRows.map((row) => `${row.client}\u0000${row.session_key}`)
  );
  const attributedSessions = new Set<string>();
  let attributedEntries = 0;
  const insert = db.prepare(
    `INSERT INTO agent_usage_period_snapshots
       (usage_period, client, session_key, source_session_id, model_id, provider_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, message_count, estimated_cost_usd, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    db.prepare(
      `DELETE FROM agent_usage_period_snapshots WHERE usage_period = ?`
    ).run(period);
    for (const entry of report.entries) {
      const linkKey = `${entry.client}\u0000${entry.sessionKey}`;
      if (!linked.has(linkKey)) continue;
      insert.run(
        period,
        entry.client,
        entry.sessionKey,
        entry.sessionId,
        entry.modelId,
        entry.providerId,
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheReadTokens,
        entry.cacheWriteTokens,
        entry.reasoningTokens,
        entry.messageCount,
        entry.estimatedCostUsd,
        scannedAt
      );
      attributedEntries += 1;
      attributedSessions.add(linkKey);
    }
  })();

  return {
    reportEntries: report.entries.length,
    attributedEntries,
    attributedSessions: attributedSessions.size
  };
}

export type UsageScanStatus = "running" | "ok" | "error";

export function setUsageScanState(
  period: AgentUsagePeriod,
  status: UsageScanStatus,
  options: { startedAt?: string; completedAt?: string; error?: string } = {}
): void {
  const now = new Date().toISOString();
  if (period !== "all") {
    usageDb()
      .prepare(
        `INSERT INTO agent_usage_period_scan_state
           (usage_period, status, started_at, completed_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(usage_period) DO UPDATE SET
           status = excluded.status,
           started_at = COALESCE(excluded.started_at, agent_usage_period_scan_state.started_at),
           completed_at = excluded.completed_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      )
      .run(
        period,
        status,
        options.startedAt ?? null,
        options.completedAt ?? null,
        options.error ?? null,
        now
      );
    return;
  }
  usageDb()
    .prepare(
      `INSERT INTO agent_usage_scan_state
         (id, status, started_at, completed_at, last_error, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         started_at = COALESCE(excluded.started_at, agent_usage_scan_state.started_at),
         completed_at = excluded.completed_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    )
    .run(
      status,
      options.startedAt ?? null,
      options.completedAt ?? null,
      options.error ?? null,
      now
    );
}

export interface AgentModelUsage {
  agentId: string;
  agentName: string;
  modelId: string;
  providerId: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  messageCount: number;
  estimatedCostUsd: number;
}

export interface AgentUsageSummary {
  period: AgentUsagePeriod;
  byAgentModel: AgentModelUsage[];
  usageSessionCount: number;
  linkedSessionCount: number;
  attributedSessionCount: number;
  ambiguousSessionCount: number;
  coverageGaps: Array<{
    adapter: string;
    sessionCount: number;
    reason: "session_attribution_unavailable" | "tokscale_client_unsupported";
  }>;
  scan: {
    status: UsageScanStatus;
    startedAt?: string;
    completedAt?: string;
    error?: string;
  } | null;
}

export function getAgentUsageSummary(
  period: AgentUsagePeriod = "all"
): AgentUsageSummary {
  const db = usageDb();
  const usageTable = period === "all"
    ? "agent_usage_snapshots"
    : "agent_usage_period_snapshots";
  const periodClause = period === "all" ? "" : "AND s.usage_period = ?";
  const periodParams = period === "all" ? [] : [period];
  const rows = db
    .prepare(
      `SELECT l.agent_id, l.agent_name, s.model_id, s.provider_id,
              COUNT(DISTINCT s.client || char(0) || s.session_key) AS session_count,
              SUM(s.input_tokens) AS input_tokens,
              SUM(s.output_tokens) AS output_tokens,
              SUM(s.cache_read_tokens) AS cache_read_tokens,
              SUM(s.cache_write_tokens) AS cache_write_tokens,
              SUM(s.reasoning_tokens) AS reasoning_tokens,
              SUM(s.message_count) AS message_count,
              SUM(s.estimated_cost_usd) AS estimated_cost_usd
       FROM ${usageTable} s
       JOIN agent_usage_sessions l
         ON l.client = s.client AND l.session_key = s.session_key
       WHERE l.ambiguous = 0 ${periodClause}
       GROUP BY l.agent_id, l.agent_name, s.model_id, s.provider_id
       ORDER BY l.agent_name COLLATE NOCASE, s.model_id COLLATE NOCASE`
    )
    .all(...periodParams) as Array<Record<string, string | number>>;
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS linked_count,
         SUM(CASE WHEN ambiguous <> 0 THEN 1 ELSE 0 END) AS ambiguous_count,
         SUM(CASE WHEN ambiguous = 0 AND EXISTS (
           SELECT 1 FROM agent_usage_snapshots s
           WHERE s.client = l.client AND s.session_key = l.session_key
         ) THEN 1 ELSE 0 END) AS attributed_count
       FROM agent_usage_sessions l`
    )
    .get() as {
    linked_count: number;
    ambiguous_count: number | null;
    attributed_count: number | null;
  };
  const scan = db
    .prepare(
      period === "all"
        ? `SELECT status, started_at, completed_at, last_error
           FROM agent_usage_scan_state WHERE id = 1`
        : `SELECT status, started_at, completed_at, last_error
           FROM agent_usage_period_scan_state WHERE usage_period = ?`
    )
    .get(...periodParams) as
    | {
        status: UsageScanStatus;
        started_at: string | null;
        completed_at: string | null;
        last_error: string | null;
      }
    | undefined;
  const usageSessionCount = db
    .prepare(
      `SELECT COUNT(DISTINCT s.client || char(0) || s.session_key) AS session_count
       FROM ${usageTable} s
       JOIN agent_usage_sessions l
         ON l.client = s.client AND l.session_key = s.session_key
       WHERE l.ambiguous = 0 ${periodClause}`
    )
    .get(...periodParams) as { session_count: number };
  const adapterRows = db
    .prepare(
      `SELECT t.adapter, o.base_adapter,
              COUNT(DISTINCT t.tool_session_id) AS session_count
       FROM cli_tasks t
       LEFT JOIN cli_executor_overrides o ON o.id = t.adapter
       WHERE t.tool_session_id IS NOT NULL AND TRIM(t.tool_session_id) <> ''
       GROUP BY t.adapter, o.base_adapter
       ORDER BY t.adapter`
    )
    .all() as Array<{
    adapter: string;
    base_adapter: string | null;
    session_count: number;
  }>;

  return {
    period,
    byAgentModel: rows.map((row) => ({
      agentId: String(row.agent_id),
      agentName: String(row.agent_name),
      modelId: String(row.model_id),
      providerId: String(row.provider_id),
      sessionCount: Number(row.session_count),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      reasoningTokens: Number(row.reasoning_tokens),
      messageCount: Number(row.message_count),
      estimatedCostUsd: Number(row.estimated_cost_usd)
    })),
    usageSessionCount: usageSessionCount.session_count,
    linkedSessionCount: counts.linked_count,
    attributedSessionCount: counts.attributed_count ?? 0,
    ambiguousSessionCount: counts.ambiguous_count ?? 0,
    coverageGaps: adapterRows
      .filter(
        (row) => !tokscaleClientForAdapter(row.adapter, row.base_adapter)
      )
      .map((row) => {
        const base = row.base_adapter ?? row.adapter;
        return {
          adapter: row.adapter,
          sessionCount: row.session_count,
          reason: base === "cursor-agent-acp"
            ? "session_attribution_unavailable" as const
            : "tokscale_client_unsupported" as const
        };
      }),
    scan: scan
      ? {
          status: scan.status,
          ...(scan.started_at ? { startedAt: scan.started_at } : {}),
          ...(scan.completed_at ? { completedAt: scan.completed_at } : {}),
          ...(scan.last_error ? { error: scan.last_error } : {})
        }
      : null
  };
}

export function listLinkedTokscaleClients() {
  const rows = usageDb()
    .prepare(
      `SELECT DISTINCT client FROM agent_usage_sessions
       WHERE ambiguous = 0 ORDER BY client`
    )
    .all() as Array<{ client: string }>;
  return rows
    .map((row) => tokscaleClientForAdapter(row.client))
    .filter((client): client is NonNullable<typeof client> => Boolean(client));
}

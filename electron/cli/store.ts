import type { CLIAdapterId } from "./adapters.js";
import { getDb } from "./db.js";

export interface CLIExecutorOverride {
  id: CLIAdapterId;
  baseAdapter?: CLIAdapterId;
  label?: string;
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  installHint?: string;
  docsUrl?: string;
  enabled?: boolean;
}

export function listOverrides(): CLIExecutorOverride[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, base_adapter, label, binary, extra_args, env, install_hint, docs_url, enabled
       FROM cli_executor_overrides ORDER BY id`
    )
    .all() as Array<{
    id: string;
    base_adapter: string | null;
    label: string | null;
    binary: string | null;
    extra_args: string | null;
    env: string | null;
    install_hint: string | null;
    docs_url: string | null;
    enabled: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    baseAdapter: r.base_adapter ?? undefined,
    label: r.label ?? undefined,
    binary: r.binary ?? undefined,
    extraArgs: r.extra_args ? (JSON.parse(r.extra_args) as string[]) : [],
    env: r.env ? (JSON.parse(r.env) as Record<string, string>) : undefined,
    installHint: r.install_hint ?? undefined,
    docsUrl: r.docs_url ?? undefined,
    enabled: r.enabled !== 0
  }));
}

export function upsertOverride(o: CLIExecutorOverride): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cli_executor_overrides
       (id, base_adapter, label, binary, extra_args, env, install_hint, docs_url, enabled, updated_at)
     VALUES (@id, @base_adapter, @label, @binary, @extra_args, @env, @install_hint, @docs_url, @enabled, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       base_adapter=excluded.base_adapter,
       label=excluded.label,
       binary=excluded.binary,
       extra_args=excluded.extra_args,
       env=excluded.env,
       install_hint=excluded.install_hint,
       docs_url=excluded.docs_url,
       enabled=excluded.enabled,
       updated_at=excluded.updated_at`
  ).run({
    id: o.id,
    base_adapter: o.baseAdapter ?? null,
    label: o.label ?? null,
    binary: o.binary ?? null,
    extra_args: JSON.stringify(o.extraArgs ?? []),
    env: o.env ? JSON.stringify(o.env) : null,
    install_hint: o.installHint ?? null,
    docs_url: o.docsUrl ?? null,
    enabled: o.enabled === false ? 0 : 1,
    updated_at: now
  });
}

export function resetOverride(id: string): void {
  getDb().prepare(`DELETE FROM cli_executor_overrides WHERE id = ?`).run(id);
}

// ---- Tool sessions ------------------------------------------------------

export interface ToolSessionRecord {
  key: string;
  agentId: string;
  workspacePath: string;
  adapter: string;
  sessionId: string;
  title?: string;
  updatedAt: string;
}

export function toolSessionKey(
  agentId: string,
  workspacePath: string
): string {
  return `${agentId}::${workspacePath}`;
}

export function getToolSession(
  agentId: string,
  workspacePath: string
): ToolSessionRecord | undefined {
  const row = getDb()
    .prepare(
      `SELECT key, agent_id, workspace_path, adapter, session_id, title, updated_at
       FROM cli_tool_sessions WHERE key = ?`
    )
    .get(toolSessionKey(agentId, workspacePath)) as
    | {
        key: string;
        agent_id: string;
        workspace_path: string;
        adapter: string;
        session_id: string;
        title: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    key: row.key,
    agentId: row.agent_id,
    workspacePath: row.workspace_path,
    adapter: row.adapter,
    sessionId: row.session_id,
    title: row.title ?? undefined,
    updatedAt: row.updated_at
  };
}

export function saveToolSession(
  agentId: string,
  workspacePath: string,
  adapter: string,
  sessionId: string,
  title?: string
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO cli_tool_sessions
         (key, agent_id, workspace_path, adapter, session_id, title, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         adapter=excluded.adapter,
         session_id=excluded.session_id,
         title=COALESCE(excluded.title, cli_tool_sessions.title),
         updated_at=excluded.updated_at`
    )
    .run(
      toolSessionKey(agentId, workspacePath),
      agentId,
      workspacePath,
      adapter,
      sessionId,
      title ?? null,
      now
    );
}

import Database, { type Database as DB } from "better-sqlite3";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { cleanupOrphanHandoffTranscriptSnapshots } from "../shared/handoffTranscript.js";

let dbInstance: DB | null = null;

export function getDb(): DB {
  if (dbInstance) return dbInstance;

  const dir = path.join(app.getPath("userData"), "freebuddy");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "freebuddy.db");

  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const transcriptRows = db
    .prepare("SELECT transcript_path FROM handoff_briefs WHERE transcript_path IS NOT NULL")
    .all() as Array<{ transcript_path: string }>;
  cleanupOrphanHandoffTranscriptSnapshots(
    dir,
    transcriptRows.map((row) => row.transcript_path)
  );
  dbInstance = db;
  return db;
}

export function getDataDir(): string {
  const dir = path.join(app.getPath("userData"), "freebuddy");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getLogDir(): string {
  const dir = path.join(getDataDir(), "cli-logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_executor_overrides (
      id TEXT PRIMARY KEY,
      base_adapter TEXT,
      label TEXT,
      binary TEXT,
      extra_args TEXT,
      env TEXT,
      install_hint TEXT,
      docs_url TEXT,
      enabled INTEGER DEFAULT 1,
      codex_byok TEXT,
      claude_byok TEXT,
      skill_ids TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      version TEXT NOT NULL,
      source TEXT NOT NULL,
      root_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      trusted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      market_provider TEXT,
      market_skill_id TEXT,
      market_slug TEXT,
      market_version TEXT,
      market_url TEXT,
      market_content_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_skills_source_name
      ON skills(source, name);

    CREATE TABLE IF NOT EXISTS cli_runtimes (
      adapter TEXT PRIMARY KEY,
      installed INTEGER NOT NULL DEFAULT 0,
      binary_path TEXT,
      version TEXT,
      latest_version TEXT,
      update_status TEXT,
      last_update_check_at TEXT,
      last_update_error TEXT,
      last_check_at TEXT,
      last_run_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cli_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      cwd TEXT,
      prompt TEXT NOT NULL,
      prompt_summary TEXT,
      session_id TEXT,
      tool_session_id TEXT,
      pid INTEGER,
      exit_code INTEGER,
      error_message TEXT,
      log_path TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cli_tasks_agent ON cli_tasks(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cli_tasks_status ON cli_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_cli_tasks_tool_session
      ON cli_tasks(adapter, tool_session_id);

    -- tokscale reports absolute usage by the native agent session. Keep the
    -- FreeBuddy ownership link separate from usage snapshots so rescans never
    -- double-count a session that is resumed by multiple cli_tasks.
    CREATE TABLE IF NOT EXISTS agent_usage_sessions (
      client TEXT NOT NULL,
      session_key TEXT NOT NULL,
      tool_session_id TEXT NOT NULL,
      adapter TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      first_task_id TEXT NOT NULL,
      last_task_id TEXT NOT NULL,
      ambiguous INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(client, session_key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_usage_sessions_agent
      ON agent_usage_sessions(agent_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS agent_usage_snapshots (
      client TEXT NOT NULL,
      session_key TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      first_observed_at TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY(client, session_key, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_usage_snapshots_scanned
      ON agent_usage_snapshots(scanned_at DESC);

    -- Filtered tokscale reports remain absolute within their requested range.
    -- Keep one replaceable cache per range so switching dashboard periods does
    -- not corrupt the all-time session snapshots above.
    CREATE TABLE IF NOT EXISTS agent_usage_period_snapshots (
      usage_period TEXT NOT NULL,
      client TEXT NOT NULL,
      session_key TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY(usage_period, client, session_key, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_usage_period_snapshots_scanned
      ON agent_usage_period_snapshots(usage_period, scanned_at DESC);

    -- Daily totals power the overall trend independently of Agent attribution.
    -- Keep the client dimension so disconnecting Cursor can remove its share.
    CREATE TABLE IF NOT EXISTS agent_usage_daily_snapshots (
      usage_period TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      client TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY(usage_period, usage_date, client)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_usage_daily_snapshots_date
      ON agent_usage_daily_snapshots(usage_period, usage_date);

    CREATE TABLE IF NOT EXISTS agent_usage_hourly_snapshots (
      usage_hour TEXT PRIMARY KEY,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      scanned_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_usage_scan_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_usage_period_scan_state (
      usage_period TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cli_tool_sessions (
      key TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      adapter TEXT NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      adapter TEXT NOT NULL,
      cwd TEXT,
      approval_mode TEXT,
      config_option_overrides TEXT,
      skill_snapshot TEXT,
      title_source TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_updated
      ON conversations(archived, updated_at DESC);

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      task_id TEXT,
      agent_id TEXT,
      agent_name TEXT,
      adapter TEXT,
      role_label TEXT,
      workflow_run_id TEXT,
      workflow_step_row_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_time
      ON conversation_messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feed_sources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fetched_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feed_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      summary TEXT,
      author TEXT,
      published_at TEXT,
      raw_id TEXT,
      read_at TEXT,
      interpreted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(source_id) REFERENCES feed_sources(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_feed_items_latest
      ON feed_items(COALESCE(published_at, created_at) DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_items_source_link
      ON feed_items(source_id, link);

    CREATE TABLE IF NOT EXISTS info_card_snapshots (
      card_id TEXT PRIMARY KEY,
      source_url TEXT,
      payload_json TEXT NOT NULL DEFAULT '[]',
      fetched_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      cwd TEXT,
      template TEXT,
      loop_index INTEGER NOT NULL DEFAULT 0,
      max_loops INTEGER NOT NULL DEFAULT 1,
      plan_json TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation
      ON workflow_runs(conversation_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      title TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      adapter TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      depends_on TEXT,
      target_paths TEXT,
      summary TEXT,
      result_json TEXT,
      cli_task_id TEXT,
      tool_session_id TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_run
      ON workflow_steps(workflow_run_id, phase_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_task
      ON workflow_steps(cli_task_id);

    CREATE TABLE IF NOT EXISTS workflow_teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      template_json TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      time_local TEXT NOT NULL,
      schedule_type TEXT NOT NULL DEFAULT 'daily',
      schedule_date TEXT,
      weekdays TEXT,
      month_day INTEGER,
      cwd TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'new_conversation',
      config_option_overrides TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      last_conversation_id TEXT,
      last_workflow_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
      ON scheduled_tasks(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      conversation_id TEXT,
      workflow_run_id TEXT,
      error TEXT,
      FOREIGN KEY(task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
      ON scheduled_task_runs(task_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS handoff_briefs (
      id                       TEXT PRIMARY KEY,
      source_conversation_id   TEXT NOT NULL,
      target_conversation_id   TEXT NOT NULL,
      source_agent_id          TEXT NOT NULL,
      source_agent_name        TEXT NOT NULL,
      source_adapter           TEXT NOT NULL,
      brief_json               TEXT NOT NULL,
      source_message_count     INTEGER NOT NULL,
      source_last_message_id   TEXT,
      transcript_path          TEXT,
      transcript_message_count INTEGER,
      transcript_byte_size     INTEGER,
      transcript_truncated     INTEGER NOT NULL DEFAULT 0,
      created_at               TEXT NOT NULL,
      FOREIGN KEY(target_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_handoff_briefs_target
      ON handoff_briefs(target_conversation_id);
    CREATE INDEX IF NOT EXISTS idx_handoff_briefs_source
      ON handoff_briefs(source_conversation_id, created_at DESC);
  `);

  const handoffColumns = db
    .prepare("PRAGMA table_info(handoff_briefs)")
    .all() as Array<{ name: string }>;
  if (!handoffColumns.some((column) => column.name === "transcript_path")) {
    db.exec("ALTER TABLE handoff_briefs ADD COLUMN transcript_path TEXT");
  }
  if (!handoffColumns.some((column) => column.name === "transcript_message_count")) {
    db.exec("ALTER TABLE handoff_briefs ADD COLUMN transcript_message_count INTEGER");
  }
  if (!handoffColumns.some((column) => column.name === "transcript_byte_size")) {
    db.exec("ALTER TABLE handoff_briefs ADD COLUMN transcript_byte_size INTEGER");
  }
  if (!handoffColumns.some((column) => column.name === "transcript_truncated")) {
    db.exec(
      "ALTER TABLE handoff_briefs ADD COLUMN transcript_truncated INTEGER NOT NULL DEFAULT 0"
    );
  }

  // Early handoff builds tied the snapshot to both conversations. That made
  // deleting the source destroy context that the target had not consumed yet.
  // Handoff briefs belong to the target; source_conversation_id is retained as
  // immutable provenance rather than as a foreign key.
  const handoffForeignKeys = db
    .prepare("PRAGMA foreign_key_list(handoff_briefs)")
    .all() as Array<{ from: string }>;
  if (handoffForeignKeys.some((key) => key.from === "source_conversation_id")) {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS handoff_briefs_next;
        CREATE TABLE handoff_briefs_next (
          id                       TEXT PRIMARY KEY,
          source_conversation_id   TEXT NOT NULL,
          target_conversation_id   TEXT NOT NULL,
          source_agent_id          TEXT NOT NULL,
          source_agent_name        TEXT NOT NULL,
          source_adapter           TEXT NOT NULL,
          brief_json               TEXT NOT NULL,
          source_message_count     INTEGER NOT NULL,
          source_last_message_id   TEXT,
          transcript_path          TEXT,
          transcript_message_count INTEGER,
          transcript_byte_size     INTEGER,
          transcript_truncated     INTEGER NOT NULL DEFAULT 0,
          created_at               TEXT NOT NULL,
          FOREIGN KEY(target_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        INSERT INTO handoff_briefs_next
          (id, source_conversation_id, target_conversation_id,
           source_agent_id, source_agent_name, source_adapter,
           brief_json, source_message_count, source_last_message_id,
           transcript_path, transcript_message_count, transcript_byte_size,
           transcript_truncated, created_at)
        SELECT id, source_conversation_id, target_conversation_id,
               source_agent_id, source_agent_name, source_adapter,
               brief_json, source_message_count, source_last_message_id,
               transcript_path, transcript_message_count, transcript_byte_size,
               transcript_truncated, created_at
        FROM handoff_briefs;
        DROP TABLE handoff_briefs;
        ALTER TABLE handoff_briefs_next RENAME TO handoff_briefs;
        CREATE INDEX idx_handoff_briefs_target
          ON handoff_briefs(target_conversation_id);
        CREATE INDEX idx_handoff_briefs_source
          ON handoff_briefs(source_conversation_id, created_at DESC);
      `);
    })();
  }

  const skillCols = db
    .prepare("PRAGMA table_info(skills)")
    .all() as Array<{ name: string }>;
  const skillColumnNames = new Set(skillCols.map((column) => column.name));
  const skillMarketColumns: Array<[string, string]> = [
    ["market_provider", "TEXT"],
    ["market_skill_id", "TEXT"],
    ["market_slug", "TEXT"],
    ["market_version", "TEXT"],
    ["market_url", "TEXT"],
    ["market_content_hash", "TEXT"]
  ];
  for (const [name, type] of skillMarketColumns) {
    if (!skillColumnNames.has(name)) {
      db.exec(`ALTER TABLE skills ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_market_identity
      ON skills(market_provider, market_skill_id)
      WHERE market_provider IS NOT NULL AND market_skill_id IS NOT NULL
  `);

  const overrideCols = db
    .prepare("PRAGMA table_info(cli_executor_overrides)")
    .all() as Array<{ name: string }>;
  if (!overrideCols.some((c) => c.name === "icon")) {
    db.exec("ALTER TABLE cli_executor_overrides ADD COLUMN icon TEXT");
  }
  if (!overrideCols.some((c) => c.name === "codex_byok")) {
    db.exec("ALTER TABLE cli_executor_overrides ADD COLUMN codex_byok TEXT");
  }
  if (!overrideCols.some((c) => c.name === "claude_byok")) {
    db.exec("ALTER TABLE cli_executor_overrides ADD COLUMN claude_byok TEXT");
  }
  if (!overrideCols.some((c) => c.name === "skill_ids")) {
    db.exec("ALTER TABLE cli_executor_overrides ADD COLUMN skill_ids TEXT");
  }

  const runtimeCols = db
    .prepare("PRAGMA table_info(cli_runtimes)")
    .all() as Array<{ name: string }>;
  if (!runtimeCols.some((c) => c.name === "latest_version")) {
    db.exec("ALTER TABLE cli_runtimes ADD COLUMN latest_version TEXT");
  }
  if (!runtimeCols.some((c) => c.name === "update_status")) {
    db.exec("ALTER TABLE cli_runtimes ADD COLUMN update_status TEXT");
  }
  if (!runtimeCols.some((c) => c.name === "last_update_check_at")) {
    db.exec("ALTER TABLE cli_runtimes ADD COLUMN last_update_check_at TEXT");
  }
  if (!runtimeCols.some((c) => c.name === "last_update_error")) {
    db.exec("ALTER TABLE cli_runtimes ADD COLUMN last_update_error TEXT");
  }

  const messageCols = db
    .prepare("PRAGMA table_info(conversation_messages)")
    .all() as Array<{ name: string }>;
  if (!messageCols.some((c) => c.name === "attachments")) {
    db.exec("ALTER TABLE conversation_messages ADD COLUMN attachments TEXT");
  }
  if (!messageCols.some((c) => c.name === "agent_id")) {
    db.exec("ALTER TABLE conversation_messages ADD COLUMN agent_id TEXT");
  }
  if (!messageCols.some((c) => c.name === "agent_name")) {
    db.exec("ALTER TABLE conversation_messages ADD COLUMN agent_name TEXT");
  }
  if (!messageCols.some((c) => c.name === "adapter")) {
    db.exec("ALTER TABLE conversation_messages ADD COLUMN adapter TEXT");
  }
  if (!messageCols.some((c) => c.name === "role_label")) {
    db.exec("ALTER TABLE conversation_messages ADD COLUMN role_label TEXT");
  }
  if (!messageCols.some((c) => c.name === "workflow_run_id")) {
    db.exec(
      "ALTER TABLE conversation_messages ADD COLUMN workflow_run_id TEXT"
    );
  }
  if (!messageCols.some((c) => c.name === "workflow_step_row_id")) {
    db.exec(
      "ALTER TABLE conversation_messages ADD COLUMN workflow_step_row_id TEXT"
    );
  }

  const conversationCols = db
    .prepare("PRAGMA table_info(conversations)")
    .all() as Array<{ name: string }>;
  if (!conversationCols.some((c) => c.name === "approval_mode")) {
    db.exec("ALTER TABLE conversations ADD COLUMN approval_mode TEXT");
  }
  if (!conversationCols.some((c) => c.name === "config_option_overrides")) {
    db.exec("ALTER TABLE conversations ADD COLUMN config_option_overrides TEXT");
  }
  if (!conversationCols.some((c) => c.name === "title_source")) {
    db.exec("ALTER TABLE conversations ADD COLUMN title_source TEXT");
  }
  if (!conversationCols.some((c) => c.name === "skill_snapshot")) {
    db.exec("ALTER TABLE conversations ADD COLUMN skill_snapshot TEXT");
  }
  if (!conversationCols.some((c) => c.name === "source_conversation_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_conversation_id TEXT");
  }
  if (!conversationCols.some((c) => c.name === "source_agent_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_agent_id TEXT");
  }
  if (!conversationCols.some((c) => c.name === "source_agent_name")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_agent_name TEXT");
  }
  if (!conversationCols.some((c) => c.name === "source_adapter")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_adapter TEXT");
  }
  if (!conversationCols.some((c) => c.name === "source_brief_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_brief_id TEXT");
  }

  const workflowRunCols = db
    .prepare("PRAGMA table_info(workflow_runs)")
    .all() as Array<{ name: string }>;
  if (!workflowRunCols.some((c) => c.name === "team_id")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN team_id TEXT");
  }
  if (!workflowRunCols.some((c) => c.name === "team_snapshot_json")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN team_snapshot_json TEXT");
  }
  if (!workflowRunCols.some((c) => c.name === "plan_version")) {
    db.exec(
      "ALTER TABLE workflow_runs ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 1"
    );
  }

  const workflowStepCols = db
    .prepare("PRAGMA table_info(workflow_steps)")
    .all() as Array<{ name: string }>;
  if (!workflowStepCols.some((c) => c.name === "tool_session_id")) {
    db.exec("ALTER TABLE workflow_steps ADD COLUMN tool_session_id TEXT");
  }

  const scheduledTaskCols = db
    .prepare("PRAGMA table_info(scheduled_tasks)")
    .all() as Array<{ name: string }>;
  if (!scheduledTaskCols.some((c) => c.name === "schedule_type")) {
    db.exec(
      "ALTER TABLE scheduled_tasks ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'daily'"
    );
  }
  if (!scheduledTaskCols.some((c) => c.name === "schedule_date")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN schedule_date TEXT");
  }
  if (!scheduledTaskCols.some((c) => c.name === "weekdays")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN weekdays TEXT");
  }
  if (!scheduledTaskCols.some((c) => c.name === "month_day")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN month_day INTEGER");
  }
  if (!scheduledTaskCols.some((c) => c.name === "cwd")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN cwd TEXT");
  }
  if (!scheduledTaskCols.some((c) => c.name === "execution_mode")) {
    db.exec(
      "ALTER TABLE scheduled_tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'new_conversation'"
    );
  }
  const hasLegacyUrl = scheduledTaskCols.some((c) => c.name === "url");
  const hasLegacyTimeZone = scheduledTaskCols.some((c) => c.name === "time_zone");
  if (hasLegacyUrl || hasLegacyTimeZone) {
    db.transaction(() => {
      if (hasLegacyUrl) {
        db.exec(`
          UPDATE scheduled_tasks
          SET prompt = prompt || '\n\nSource: ' || url
          WHERE TRIM(COALESCE(url, '')) <> ''
        `);
      }
      db.exec(`
        DROP TABLE IF EXISTS scheduled_tasks_next;
        CREATE TABLE scheduled_tasks_next (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          time_local TEXT NOT NULL,
          schedule_type TEXT NOT NULL DEFAULT 'daily',
          schedule_date TEXT,
          weekdays TEXT,
          month_day INTEGER,
          cwd TEXT,
          execution_mode TEXT NOT NULL DEFAULT 'new_conversation',
          config_option_overrides TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          next_run_at TEXT,
          last_run_at TEXT,
          last_status TEXT,
          last_error TEXT,
          last_conversation_id TEXT,
          last_workflow_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO scheduled_tasks_next
          (id, title, prompt, agent_id, time_local, schedule_type,
           schedule_date, weekdays, month_day, cwd, execution_mode,
           config_option_overrides, enabled, next_run_at,
           last_run_at, last_status, last_error, last_conversation_id,
           last_workflow_run_id, created_at, updated_at)
        SELECT id, title, prompt, agent_id, time_local, schedule_type,
               schedule_date, weekdays, month_day, cwd, execution_mode,
               NULL, enabled, next_run_at,
               last_run_at, last_status, last_error, last_conversation_id,
               last_workflow_run_id, created_at, updated_at
        FROM scheduled_tasks;
        DROP TABLE scheduled_tasks;
        ALTER TABLE scheduled_tasks_next RENAME TO scheduled_tasks;
        CREATE INDEX idx_scheduled_tasks_due
          ON scheduled_tasks(enabled, next_run_at);
      `);
    })();
  }
  const currentScheduledTaskCols = db
    .prepare("PRAGMA table_info(scheduled_tasks)")
    .all() as Array<{ name: string }>;
  if (!currentScheduledTaskCols.some((c) => c.name === "config_option_overrides")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN config_option_overrides TEXT");
  }
}

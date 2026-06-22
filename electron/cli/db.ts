import Database, { type Database as DB } from "better-sqlite3";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

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

function migrate(db: DB) {
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
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cli_runtimes (
      adapter TEXT PRIMARY KEY,
      installed INTEGER NOT NULL DEFAULT 0,
      binary_path TEXT,
      version TEXT,
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
  `);

  const overrideCols = db
    .prepare("PRAGMA table_info(cli_executor_overrides)")
    .all() as Array<{ name: string }>;
  if (!overrideCols.some((c) => c.name === "icon")) {
    db.exec("ALTER TABLE cli_executor_overrides ADD COLUMN icon TEXT");
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
}

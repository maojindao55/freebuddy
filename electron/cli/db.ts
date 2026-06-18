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
      task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_time
      ON conversation_messages(conversation_id, created_at);
  `);
}

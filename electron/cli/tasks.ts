import fs from "node:fs";
import readline from "node:readline";
import { getDb } from "./db.js";

export interface CliTaskRow {
  id: string;
  agentId: string;
  agentName: string;
  adapter: string;
  status: string;
  cwd?: string;
  prompt: string;
  promptSummary?: string;
  sessionId?: string;
  toolSessionId?: string;
  pid?: number;
  exitCode?: number;
  errorMessage?: string;
  logPath?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToTask(r: any): CliTaskRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    adapter: r.adapter,
    status: r.status,
    cwd: r.cwd ?? undefined,
    prompt: r.prompt,
    promptSummary: r.prompt_summary ?? undefined,
    sessionId: r.session_id ?? undefined,
    toolSessionId: r.tool_session_id ?? undefined,
    pid: r.pid ?? undefined,
    exitCode: r.exit_code ?? undefined,
    errorMessage: r.error_message ?? undefined,
    logPath: r.log_path ?? undefined,
    startedAt: r.started_at ?? undefined,
    endedAt: r.ended_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export interface CliTaskListArgs {
  agentId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export function listTasks(args: CliTaskListArgs = {}): CliTaskRow[] {
  const where: string[] = [];
  const params: any[] = [];
  if (args.agentId) {
    where.push("agent_id = ?");
    params.push(args.agentId);
  }
  if (args.status) {
    where.push("status = ?");
    params.push(args.status);
  }
  const sql = `
    SELECT * FROM cli_tasks
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?`;
  params.push(args.limit ?? 50, args.offset ?? 0);
  return (getDb().prepare(sql).all(...params) as any[]).map(rowToTask);
}

export function getTask(id: string): CliTaskRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM cli_tasks WHERE id = ?`)
    .get(id) as any;
  return row ? rowToTask(row) : undefined;
}

export interface CliTaskLogEntry {
  ts: string;
  type: string;
  content: string;
}

export interface CliTaskLogPage {
  entries: CliTaskLogEntry[];
  total: number;
  truncated: boolean;
}

export async function readTaskLog(
  taskId: string,
  opts: { startLine?: number; limit?: number; maxBytes?: number } = {}
): Promise<CliTaskLogPage> {
  const task = getTask(taskId);
  if (!task || !task.logPath || !fs.existsSync(task.logPath)) {
    return { entries: [], total: 0, truncated: false };
  }
  const startLine = opts.startLine ?? 0;
  const limit = opts.limit ?? 5000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;

  const stream = fs.createReadStream(task.logPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let index = 0;
  let bytes = 0;
  let truncated = false;
  const entries: CliTaskLogEntry[] = [];

  for await (const raw of rl) {
    if (index >= startLine && entries.length < limit) {
      bytes += raw.length + 1;
      if (bytes > maxBytes) {
        truncated = true;
        break;
      }
      try {
        const obj = JSON.parse(raw) as CliTaskLogEntry;
        entries.push(obj);
      } catch {
        entries.push({ ts: "", type: "raw", content: raw });
      }
    }
    index += 1;
  }
  rl.close();
  return { entries, total: index, truncated };
}

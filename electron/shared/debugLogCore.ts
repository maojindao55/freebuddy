/**
 * Core debug-log writer. Pure Node (fs/path only, directory and clock
 * injected) so tests can transpile and load it directly. The Electron
 * singleton wiring lives in electron/debugLog.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { redactsecrets } from "./logSanitize.js";

export type DebugLogLevel = "info" | "warn" | "error" | "debug";

export const LOG_RETENTION_DAYS = 7;
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROTATIONS = 2; // base file + .1 + .2 = 同日最多 3 份

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ISO 8601 timestamp in the local timezone, e.g. 2026-07-31T07:18:13.481+08:00. */
export function formatLocalTimestamp(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const tz = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `.${String(date.getMilliseconds()).padStart(3, "0")}${tz}`
  );
}

export interface DebugLogger {
  write(level: DebugLogLevel, scope: string, msg: string, data?: unknown, ts?: string): void;
  info(scope: string, msg: string, data?: unknown): void;
  warn(scope: string, msg: string, data?: unknown): void;
  error(scope: string, msg: string, data?: unknown): void;
  debug(scope: string, msg: string, data?: unknown): void;
  readonly droppedLines: number;
  readonly dir: string;
}

/** Delete *.log / *.jsonl (and .N rotations) older than retentionDays. */
export function pruneOldLogs(dir: string, retentionDays: number, now = new Date()): number {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(log|jsonl)(\.\d+)?$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

function dayStamp(date: Date, formatTimestamp: (d: Date) => string): string {
  return formatTimestamp(date).slice(0, 10);
}

function rotateIfFull(file: string, maxFileBytes: number): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // does not exist yet
  }
  if (size < maxFileBytes) return;
  for (let i = MAX_ROTATIONS - 1; i >= 1; i -= 1) {
    const from = `${file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

export function createDebugLogger(opts: {
  dir: string;
  source: string;
  maxFileBytes?: number;
  now?: () => Date;
  formatTimestamp?: (date: Date) => string;
}): DebugLogger {
  const maxFileBytes = opts.maxFileBytes ?? MAX_LOG_FILE_BYTES;
  const now = opts.now ?? (() => new Date());
  const formatTimestamp = opts.formatTimestamp ?? formatLocalTimestamp;
  let droppedLines = 0;
  try {
    fs.mkdirSync(opts.dir, { recursive: true });
    pruneOldLogs(opts.dir, LOG_RETENTION_DAYS, now());
  } catch {
    /* logging must never take the app down */
  }

  const write = (level: DebugLogLevel, scope: string, msg: string, data?: unknown, ts?: string): void => {
    try {
      const nowDate = now();
      const entry: Record<string, unknown> = {
        ts: typeof ts === "string" && ts.length > 0 ? ts : formatTimestamp(nowDate),
        level,
        scope,
        msg
      };
      if (data !== undefined) entry.data = data;
      const line = redactsecrets(JSON.stringify(entry));
      const file = path.join(opts.dir, `${opts.source}-${dayStamp(nowDate, formatTimestamp)}.log`);
      rotateIfFull(file, maxFileBytes);
      fs.appendFileSync(file, line + "\n");
    } catch {
      droppedLines += 1;
    }
  };

  return {
    write,
    info: (scope, msg, data) => write("info", scope, msg, data),
    warn: (scope, msg, data) => write("warn", scope, msg, data),
    error: (scope, msg, data) => write("error", scope, msg, data),
    debug: (scope, msg, data) => write("debug", scope, msg, data),
    get droppedLines() {
      return droppedLines;
    },
    dir: opts.dir
  };
}

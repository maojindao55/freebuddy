/**
 * Renderer-side debug logger. Batches entries and forwards them to the
 * main process (debugLog:write IPC), which persists them to
 * renderer-YYYY-MM-DD.log. Never throws: logging must not break the app.
 */

type Level = "info" | "warn" | "error" | "debug";

interface Entry {
  ts: string;
  level: Level;
  scope: string;
  msg: string;
  data?: unknown;
}

const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH = 100;
const MAX_MSG_CHARS = 4000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ISO 8601 timestamp in the local timezone, e.g. 2026-07-31T07:18:13.481+08:00. */
function formatLocalTimestamp(date: Date): string {
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

let queue: Entry[] = [];
let timer: number | null = null;

function cloneData(data: unknown): unknown {
  if (data === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return String(data);
  }
}

function enqueue(level: Level, scope: string, msg: string, data?: unknown): void {
  queue.push({
    ts: formatLocalTimestamp(new Date()),
    level,
    scope: scope.slice(0, 40),
    msg: String(msg).slice(0, MAX_MSG_CHARS),
    ...(data !== undefined ? { data: cloneData(data) } : {})
  });
  if (queue.length > MAX_BATCH) queue.splice(0, queue.length - MAX_BATCH);
  schedule();
}

function schedule(): void {
  if (timer !== null) return;
  timer = window.setTimeout(flush, FLUSH_INTERVAL_MS);
}

function flush(): void {
  timer = null;
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    void window.freebuddy?.debugLogs?.write(batch)?.catch(() => {
      /* drop on IPC failure */
    });
  } catch {
    /* drop */
  }
}

export const debugLogClient = {
  info: (scope: string, msg: string, data?: unknown) => enqueue("info", scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown) => enqueue("warn", scope, msg, data),
  error: (scope: string, msg: string, data?: unknown) => enqueue("error", scope, msg, data),
  debug: (scope: string, msg: string, data?: unknown) => enqueue("debug", scope, msg, data)
};

let installed = false;

/** Global error hooks. Call once from the renderer entry point. */
export function installDebugLogClient(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    enqueue("error", "renderer", event.message, {
      stack: event.error?.stack?.slice(0, 2000)
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    enqueue("error", "renderer", "unhandled rejection", {
      reason: (reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason)
      ).slice(0, 1000)
    });
  });
  window.addEventListener("pagehide", flush);
}

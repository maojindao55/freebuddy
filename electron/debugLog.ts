/**
 * Electron-bound debug log singleton: owns the main-process logger,
 * intercepts console.* and process-level crash hooks, and accepts
 * batched log entries forwarded from the renderer.
 */
import { app } from "electron";
import path from "node:path";
import {
  createDebugLogger,
  type DebugLogger,
  type DebugLogLevel
} from "./shared/debugLogCore.js";

const LEVELS: ReadonlySet<string> = new Set(["info", "warn", "error", "debug"]);
const MAX_RENDERER_MSG_CHARS = 4000;
const MAX_RENDERER_BATCH = 100;

let mainLogger: DebugLogger | null = null;
let rendererLogger: DebugLogger | null = null;

const noopLogger: DebugLogger = {
  write: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  droppedLines: 0,
  dir: ""
};

export function logMain(): DebugLogger {
  return mainLogger ?? noopLogger;
}

export function mainLogDroppedLines(): number {
  return mainLogger?.droppedLines ?? 0;
}

export function debugLogDir(): string {
  return path.join(app.getPath("userData"), "freebuddy", "logs");
}

/** Route console.* into the log file while preserving original output. */
function interceptConsole(logger: DebugLogger): void {
  const wrap =
    (level: DebugLogLevel, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const msg = args
        .map((a) => (typeof a === "string" ? a : safeStringify(a)))
        .join(" ");
      logger.write(level, "console", msg);
      original.apply(console, args);
    };
  console.log = wrap("info", console.log.bind(console));
  console.info = wrap("info", console.info.bind(console));
  console.warn = wrap("warn", console.warn.bind(console));
  console.error = wrap("error", console.error.bind(console));
  console.debug = wrap("debug", console.debug.bind(console));
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

/** Small objects keep their shape; oversized ones become a truncated string. */
function capRendererData(data: unknown): unknown {
  if (data === undefined) return undefined;
  const serialized = safeStringify(data);
  return serialized.length <= MAX_RENDERER_MSG_CHARS
    ? data
    : `${serialized.slice(0, MAX_RENDERER_MSG_CHARS)}… [truncated]`;
}

export function initDebugLog(): void {
  if (mainLogger) return;
  try {
    const dir = debugLogDir();
    mainLogger = createDebugLogger({ dir, source: "main" });
    rendererLogger = createDebugLogger({ dir, source: "renderer" });
    interceptConsole(mainLogger);
    process.on("uncaughtException", (err) => {
      logMain().error("crash", "uncaughtException", {
        message: err.message,
        stack: err.stack?.slice(0, 4000)
      });
      // The write above is synchronous (appendFileSync); exit so the app
      // doesn't keep running in a corrupted state.
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      logMain().error("crash", "unhandledRejection", {
        reason: safeStringify(reason).slice(0, 2000)
      });
    });
    logMain().info("main", "debug log initialized", { dir });
  } catch {
    mainLogger = null; // degrade to no-op
  }
}

/** Validate and persist a batch of renderer entries (IPC debugLog:write). */
export function appendRendererLogEntries(entries: unknown): void {
  const logger = rendererLogger;
  if (!logger || !Array.isArray(entries)) return;
  for (const raw of entries.slice(0, MAX_RENDERER_BATCH)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.msg !== "string" || typeof e.scope !== "string") continue;
    const level = LEVELS.has(e.level as string) ? (e.level as DebugLogLevel) : "info";
    const ts = typeof e.ts === "string" && !Number.isNaN(Date.parse(e.ts)) ? e.ts : undefined;
    logger.write(
      level,
      e.scope.slice(0, 40),
      e.msg.slice(0, MAX_RENDERER_MSG_CHARS),
      capRendererData(e.data),
      ts
    );
  }
}

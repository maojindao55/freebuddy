/**
 * Formats the operator-facing report for a failed startup step.
 *
 * `app.whenReady()` bootstrapping runs inside one promise chain: a synchronous
 * throw in an early step (for example `getDb()` failing to load the
 * better-sqlite3 native module) rejects that chain and skips every later step,
 * including `createWindow()`. The process stays alive with no window, and the
 * only trace is the JSONL debug log, so the failure looks like "the app started
 * but the UI never appeared". These helpers turn that rejection into a message
 * that is visible in the terminal and in a native error box.
 *
 * Kept free of `electron` imports so it can be unit tested directly.
 */

export interface StartupFailureInput {
  /** Logical startup step that failed, e.g. "startup" or "database". */
  stage: string;
  error: unknown;
  appName?: string;
  /** Values from `app.getLocale()`, e.g. "zh-CN" or "en-US". */
  locale?: string;
}

export interface StartupFailureReport {
  title: string;
  message: string;
  detail: string;
  /** Single line for the terminal; always safe to print. */
  summary: string;
}

const MAX_ERROR_CHARS = 400;
const MAX_STACK_CHARS = 1800;

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

const TRUNCATION_MARKER = "… [truncated]";

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  // Keep the marker inside the budget so callers can rely on `<= limit`.
  const budget = Math.max(0, limit - TRUNCATION_MARKER.length);
  return `${value.slice(0, budget)}${TRUNCATION_MARKER}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = normalizeWhitespace(error.message ?? "");
    return message || error.name || "Unknown error";
  }
  if (typeof error === "string") {
    return normalizeWhitespace(error) || "Unknown error";
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized !== undefined) return normalizeWhitespace(serialized);
  } catch {
    // Fall through to String() for circular structures.
  }
  return normalizeWhitespace(String(error)) || "Unknown error";
}

function describeStack(error: unknown): string {
  if (!(error instanceof Error) || !error.stack) return "";
  // The first line repeats the message; keep only the frames.
  const frames = error.stack
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(1)
    .join("\n")
    .trim();
  return truncate(frames, MAX_STACK_CHARS);
}

function isChineseLocale(locale: string | undefined): boolean {
  return Boolean(locale && locale.toLowerCase().startsWith("zh"));
}

export function formatStartupFailure({
  stage,
  error,
  appName = "FreeBuddy",
  locale
}: StartupFailureInput): StartupFailureReport {
  const summaryError = truncate(describeError(error), MAX_ERROR_CHARS);
  const stack = describeStack(error);
  const chinese = isChineseLocale(locale);

  const title = chinese
    ? `${appName} 启动失败`
    : `${appName} failed to start`;

  const message = chinese
    ? `${appName} 在启动过程中遇到错误，主窗口未能打开。`
    : `${appName} hit an error while starting up, so the main window never opened.`;

  const detailLines = chinese
    ? [
        `启动阶段: ${stage}`,
        `错误: ${summaryError}`,
        "",
        "详细堆栈已写入调试日志。",
        "若这是开发环境，请确认原生模块已按 Electron ABI 重新编译（npm run rebuild）。"
      ]
    : [
        `Stage: ${stage}`,
        `Error: ${summaryError}`,
        "",
        "The full stack trace was written to the debug log.",
        "In a development checkout, make sure native modules are rebuilt for the Electron ABI (npm run rebuild)."
      ];

  if (stack) detailLines.push("", stack);

  return {
    title,
    message,
    detail: detailLines.join("\n"),
    summary: truncate(`${stage}: ${summaryError}`, MAX_ERROR_CHARS)
  };
}

export const SCHEDULED_SEND_PRESET_MINUTES = [15, 30, 60, 120, 300] as const;

/** Extra slack added on top of the provider reset time so the quota is really back. */
export const SCHEDULED_SEND_RESET_BUFFER_MS = 60_000;

export const CODEX_USAGE_ADAPTERS: ReadonlySet<string> = new Set([
  "codex",
  "codex-acp"
]);

export type ScheduledSendStatus = "pending" | "waiting" | "sending" | "failed";

export interface CodexUsageWindowLike {
  leftPercent: number;
  resetAt: number;
}

export function supportsCodexUsageReset(adapter: string | undefined): boolean {
  return !!adapter && CODEX_USAGE_ADAPTERS.has(adapter);
}

/** Codex reports `resetAt` either in seconds or milliseconds depending on the endpoint. */
export function normalizeCodexResetAtMs(resetAt: number): number | undefined {
  if (!Number.isFinite(resetAt) || resetAt <= 0) return undefined;
  return resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
}

/**
 * Picks the reset time that most likely unblocks the conversation: the earliest
 * reset among exhausted windows, falling back to the earliest reset overall.
 */
export function pickCodexUsageResetAt(
  windows: readonly CodexUsageWindowLike[],
  now: number = Date.now()
): number | undefined {
  const candidates = windows
    .map((window) => ({
      resetAt: normalizeCodexResetAtMs(window.resetAt),
      exhausted: window.leftPercent <= 0
    }))
    .filter(
      (entry): entry is { resetAt: number; exhausted: boolean } =>
        entry.resetAt !== undefined && entry.resetAt > now
    );
  if (candidates.length === 0) return undefined;

  const exhausted = candidates.filter((entry) => entry.exhausted);
  const pool = exhausted.length > 0 ? exhausted : candidates;
  return Math.min(...pool.map((entry) => entry.resetAt));
}

export function presetFireAt(minutes: number, now: number = Date.now()): number {
  return now + minutes * 60_000;
}

export function isValidScheduledFireAt(
  fireAt: number | undefined,
  now: number = Date.now()
): fireAt is number {
  return typeof fireAt === "number" && Number.isFinite(fireAt) && fireAt > now;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local-time value accepted by `<input type="datetime-local">`. */
export function toDateTimeLocalInputValue(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`;
}

export function parseDateTimeLocalInputValue(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value.trim()
  );
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    second ? Number(second) : 0
  );
  const ms = date.getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "HH:mm" when today, otherwise includes month/day. */
export function formatScheduledFireTime(
  fireAt: number,
  now: number = Date.now(),
  locale?: string
): string {
  const date = new Date(fireAt);
  if (Number.isNaN(date.getTime())) return "";
  const today = sameLocalDay(date, new Date(now));
  return new Intl.DateTimeFormat(locale || undefined, {
    month: today ? undefined : "2-digit",
    day: today ? undefined : "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

/** Compact countdown: "1:05:09" above an hour, otherwise "05:09". */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

export function truncatePromptPreview(prompt: string, max = 80): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}\u2026`;
}

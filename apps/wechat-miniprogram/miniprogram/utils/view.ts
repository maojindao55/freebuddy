/**
 * Presentation helpers shared by pages.
 *
 * These helpers are the only place that shapes text for WXML, and deliberately do not accept
 * token material: pages render a fixed mask instead of anything the operator typed. Markdown
 * and rich text are never interpreted — everything is rendered as literal text, so there is
 * no HTML/JS execution surface in a WeChat page.
 */

/** Fixed placeholder for secrets. Independent of length, so it leaks nothing. */
export const SECRET_MASK = "••••••••";

export function maskSecret(): string {
  return SECRET_MASK;
}

const MAX_PREVIEW_CHARS = 240;

/** Collapses whitespace, keeps RPG-length preview bounded, and never renders control codes. */
export function previewText(text: string, max = MAX_PREVIEW_CHARS): string {
  const normalized = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/** `2026-09-01T10:00:00.000Z` -> `09-01 18:00` (localtime). Invalid input never throws. */
export function formatClock(value: string | undefined | null): string {
  if (typeof value !== "string" || value.length === 0) {
    return "--:--";
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return "--:--";
  }
  const date = new Date(parsed);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type Tone = "neutral" | "ok" | "warn" | "error";

export function toneOf(online: boolean | undefined): Tone {
  return online ? "ok" : "warn";
}

/** Shortens identifiers for display without ever truncating them into ambiguity. */
export function shortId(value: string | undefined | null, keep = 8): string {
  if (typeof value !== "string" || value.length === 0) {
    return "—";
  }
  return value.length <= keep ? value : `${value.slice(0, keep)}…`;
}

export function pluralizeCount(count: number, unit: string): string {
  return `${count} ${unit}`;
}

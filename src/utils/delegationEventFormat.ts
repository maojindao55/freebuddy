import type { DelegationEventRow } from "@/services/delegation/client";

const EM_DASH = "—";

/** Wall-clock time of a delegation timestamp, or an em dash when missing. */
export function formatEventClock(value: string | null): string {
  if (!value) return EM_DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

/**
 * Elapsed time of an event, still counting while it runs.
 * Returns null when the event never started or the timestamps are unusable.
 */
export function formatEventDuration(event: DelegationEventRow): string | null {
  const from = event.startedAt ?? event.acceptedAt;
  if (!from) return null;
  const start = new Date(from).getTime();
  const end = event.endedAt ? new Date(event.endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.round((end - start) / 100) / 10;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Terminal failure text, which is only meaningful for failed/timeout events. */
export function eventFailureReason(
  event: DelegationEventRow
): string | undefined {
  if (event.status !== "failed" && event.status !== "timeout") return undefined;
  const summary = event.resultSummary?.trim();
  return summary ? summary : undefined;
}

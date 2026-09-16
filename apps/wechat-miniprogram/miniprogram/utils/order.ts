/**
 * Version comparison for cached entities.
 *
 * The host is authoritative and every cache entry carries an `updatedAt` (or, for messages,
 * `createdAt`). Without this guard a slow page response could land after a fresh event and
 * silently roll the UI back — the classic "stale write wins" bug.
 *
 * Timestamps are RFC3339 UTC with a trailing `Z`, so lexical comparison is chronological.
 * Entities without a usable timestamp have no versioning channel, so the newest arrival wins.
 */

export function isNewerTimestamp(candidate: string | undefined, current: string | undefined): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return false;
  }
  if (typeof current !== "string" || current.length === 0) {
    return true;
  }
  return candidate > current;
}

/** Total order used for message rendering: `createdAt`, then id for stability. */
export function compareMessagesByCreation(
  left: { createdAt?: string; messageId: string },
  right: { createdAt?: string; messageId: string }
): number {
  const leftAt = typeof left.createdAt === "string" ? left.createdAt : "";
  const rightAt = typeof right.createdAt === "string" ? right.createdAt : "";
  if (leftAt !== rightAt) {
    return leftAt < rightAt ? -1 : 1;
  }
  return left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0;
}

import type {
  DelegationEvent,
  DelegationRosterEntry
} from "@freebuddy/protocol/delegation";

type DelegationEventRow = DelegationEvent;

/** Normalize task text for whole-task / bounce similarity checks. */
export function normalizeTaskText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"'`]/g, "")
    .trim();
}

/**
 * Jaccard-like token overlap on whitespace tokens.
 * Returns 0..1. Used to reject near-identical whole-task re-delegates.
 */
export function taskSimilarity(a: string, b: string): number {
  const na = normalizeTaskText(a);
  const nb = normalizeTaskText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(" ").filter(Boolean));
  const tb = new Set(nb.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Default threshold: reject when child task is a near copy of parent/root task. */
export const WHOLE_TASK_SIMILARITY_THRESHOLD = 0.92;

export function isWholeTaskRedelegate(
  childTask: string,
  parentOrRootTask: string,
  threshold = WHOLE_TASK_SIMILARITY_THRESHOLD
): boolean {
  return taskSimilarity(childTask, parentOrRootTask) >= threshold;
}

export type DelegationEventRoleRef = Pick<DelegationEvent, "agentId" | "roleLabel">;

/** Map a persisted event to a roster role id (best-effort). */
export function rosterIdForEvent(
  event: DelegationEventRoleRef,
  roster: DelegationRosterEntry[]
): string | undefined {
  const exact = roster.find(
    (r) => r.agentId === event.agentId && r.label === event.roleLabel
  );
  if (exact) return exact.id;
  const byAgent = roster.filter((r) => r.agentId === event.agentId);
  if (byAgent.length === 1) return byAgent[0]!.id;
  return undefined;
}

/** Events that belong to one roster role, even when several roles share an agentId. */
export function eventsForRosterRole<T extends DelegationEventRoleRef>(
  events: T[],
  role: Pick<DelegationRosterEntry, "id">,
  roster: DelegationRosterEntry[]
): T[] {
  return events.filter((event) => rosterIdForEvent(event, roster) === role.id);
}

/**
 * Which roster role currently owns the live slot.
 * Keyed by role id so two roles sharing a CLI adapter (e.g. Codex) do not
 * inherit each other's running state.
 */
export function resolveActiveDelegationRoleId(opts: {
  roster: DelegationRosterEntry[];
  entryRoleId: string;
  events: Array<Pick<DelegationEvent, "agentId" | "roleLabel" | "status" | "depth">>;
  runStatus?: string;
  liveStatus?: string;
}): string | undefined {
  const runningChild = opts.events.find(
    (event) => event.status === "running" && event.depth > 0
  );
  if (runningChild) {
    return rosterIdForEvent(runningChild, opts.roster);
  }
  const runLive = opts.runStatus === "running" || opts.runStatus === "blocked";
  const isLive =
    runLive || opts.liveStatus === "running" || opts.liveStatus === "starting";
  if (!isLive) return undefined;
  const entry =
    opts.roster.find((role) => role.id === opts.entryRoleId) ?? opts.roster[0];
  return entry?.id;
}

/**
 * Roster ids on the call chain that must not receive a bounce:
 * the caller itself plus every ancestor event's role.
 */
export function ancestorRosterIds(opts: {
  selfRosterId: string;
  parentEventId: string | null;
  getEvent: (id: string) => DelegationEventRow | undefined;
  roster: DelegationRosterEntry[];
}): Set<string> {
  const banned = new Set<string>([opts.selfRosterId]);
  let cursor = opts.parentEventId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const ev = opts.getEvent(cursor);
    if (!ev) break;
    const rid = rosterIdForEvent(ev, opts.roster);
    if (rid) banned.add(rid);
    cursor = ev.parentEventId;
  }
  return banned;
}

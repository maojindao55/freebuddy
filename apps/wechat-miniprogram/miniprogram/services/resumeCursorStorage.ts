/**
 * Persistence seam for per-host event cursors.
 *
 * What is stored is deliberately tiny: `hostId -> { baseSeq, lastSeq }`. No host name, no
 * project, no conversation, no message, no terminal output and certainly no token. A cursor is
 * only a number, so a leaked storage record cannot resurrect content the Relay is forbidden to
 * keep.
 *
 * The storage is also deliberately *not* the source of truth for whether a cursor may be used:
 * `services/resumeManager.ts` keeps that decision, because a persisted cursor without a
 * reconstructible entity cache must never let a cold start skip the initial snapshot. This file
 * only moves a whitelisted, sanitised map in and out of the platform store.
 */

import type { WechatApi } from "../platform/wechatApi";

export interface ResumeCursorRecord {
  /** `baseSeq` of the last applied snapshot. */
  readonly baseSeq: number | null;
  /** Last event sequence completely applied for this host. */
  readonly lastSeq: number | null;
}

export type ResumeCursorMap = Readonly<Record<string, ResumeCursorRecord>>;

export interface ResumeCursorStorage {
  /** `null` when nothing was ever written or the stored value is unusable. */
  read(): ResumeCursorMap | null;
  write(value: ResumeCursorMap): void;
  clear(): void;
}

export const RESUME_CURSOR_STORAGE_KEY = "freebuddy.remote.resumeCursors.v1";

/** Bounded so a long-lived operator session cannot grow the storage record without limit. */
export const MAX_PERSISTED_HOSTS = 8;

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalSeq(value: unknown): number | null {
  return isSeq(value) ? value : null;
}

/**
 * Keeps only known fields and only usable values. Anything malformed — a string seq, a negative
 * seq, an extra key a future build persisted — is dropped rather than repaired, so a hostile or
 * drifted storage value can never become a sequence this client believes in.
 */
export function sanitizeResumeCursorMap(value: unknown): ResumeCursorMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, ResumeCursorRecord> = {};
  for (const [hostId, record] of Object.entries(value as Record<string, unknown>)) {
    if (typeof hostId !== "string" || hostId.length === 0 || hostId.length > 128) {
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      continue;
    }
    const entry = record as Record<string, unknown>;
    result[hostId] = { baseSeq: optionalSeq(entry.baseSeq), lastSeq: optionalSeq(entry.lastSeq) };
  }
  return result;
}

export interface MemoryResumeCursorStorage extends ResumeCursorStorage {
  /** Current contents. Tests use it to prove what survived a simulated restart. */
  snapshot(): ResumeCursorMap;
  writes(): number;
}

export function createMemoryResumeCursorStorage(
  initial: ResumeCursorMap = {}
): MemoryResumeCursorStorage {
  let value: ResumeCursorMap = sanitizeResumeCursorMap(initial);
  let writes = 0;

  return {
    read() {
      return value;
    },
    write(next) {
      value = sanitizeResumeCursorMap(next);
      writes += 1;
    },
    clear() {
      value = {};
      writes += 1;
    },
    snapshot() {
      return value;
    },
    writes() {
      return writes;
    }
  };
}

/** Storage subset the cursor writer needs; tests inject a fake `WechatApi`. */
export type StorageSyncApi = Pick<WechatApi, "getStorageSync" | "setStorageSync" | "removeStorageSync">;

/**
 * WeChat storage adapter.
 *
 * Failures are swallowed on purpose: a client that cannot persist its cursor still works, it just
 * falls back to a full snapshot on the next cold start. A storage failure must never become a
 * reconnect loop or a crash inside an event callback.
 */
export function createWechatResumeCursorStorage(
  api: StorageSyncApi,
  key: string = RESUME_CURSOR_STORAGE_KEY
): ResumeCursorStorage {
  return {
    read() {
      try {
        const raw = api.getStorageSync(key);
        return raw === null || raw === undefined || raw === "" ? null : sanitizeResumeCursorMap(raw);
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        api.setStorageSync(key, sanitizeResumeCursorMap(value));
      } catch {
        // Nothing to do: persistence is an optimisation, not a correctness requirement.
      }
    },
    clear() {
      try {
        api.removeStorageSync(key);
      } catch {
        // See above.
      }
    }
  };
}

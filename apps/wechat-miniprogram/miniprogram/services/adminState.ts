/**
 * Recovery and cache coordination for one admin session.
 *
 * This is the only place that decides *what the wire means* for the stores, and it is owned by
 * the App rather than by a page:
 *
 * - **Every connection starts by re-establishing a baseline.** After `auth.ok` the session either
 *   resumes (`resume` frame with the last completely applied seq) or, when no usable cursor
 *   exists, asks for `sync.snapshot`. A cold start always lands in the second case: a persisted
 *   cursor without the entities it describes may never skip the initial snapshot.
 * - **Events are gated by sequence.** Duplicate seqs are idempotently ignored, a gap immediately
 *   requests the authoritative snapshot, a sequence below the snapshot baseline means the host
 *   restarted and also requests a snapshot, and nothing is applied while one is outstanding.
 * - **Snapshots replace, never merge.** Both entry points (the `snapshot` frame and the
 *   `sync.snapshot` RPC result) funnel through one function, so they cannot diverge.
 * - **Reads are bounded and host-scoped.** Paged reads merge through the store's own fetch
 *   sequence and `updatedAt` rules, and a page that arrives after the host changed — or after a
 *   newer fetch started — is dropped instead of being applied to another host's cache.
 * - **A superseded read can never win.** Accepting a snapshot, switching host and signing out all
 *   bump a generation counter, so a `sync.snapshot` result or a page read that was in flight
 *   before it is discarded rather than restoring entities against a state that no longer exists.
 *
 * There is deliberately no write path, no page, and no terminal here: writes arrive with W5 and
 * are unreachable in this read-only stage.
 */

import { describeErrorCode } from "../stores/connectionStore";
import { createRemoteStateApplier } from "../stores/remoteStateApplier";
import type { AdminStores } from "../stores/adminStores";
import type { ReadRpcApi } from "./readRpc";
import type { ResumeManager } from "./resumeManager";
import type { RpcResult } from "./rpcClient";
import type {
  EventFrame,
  HostStatus,
  RemoteErrorCode,
  RemoteId,
  SnapshotFrame,
  SnapshotPayload
} from "../protocol/remote.generated";

export const CONVERSATION_PAGE_SIZE = 50;
export const MESSAGE_PAGE_SIZE = 50;
const SNAPSHOT_CONVERSATION_LIMIT = 50;
const NO_HOST_MESSAGE = "尚未显式配置 hostId";

export type LoadReason = "no_host" | "dropped" | "rpc_error";

export type LoadOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: LoadReason; readonly message: string };

export interface AdminStateOptions {
  readonly stores: AdminStores;
  readonly resume: ResumeManager;
  readonly reads: ReadRpcApi;
  /** Puts a `resume` frame on the wire. False when the transport refused it. */
  readonly sendResume: (hostId: string, resumeFrom: number) => boolean;
  readonly getHostId: () => string | null;
  /**
   * Whether the transport would accept a frame right now. Snapshot requests are only issued when
   * they can actually reach the host: an attempt made while offline must not be remembered as
   * "in flight", or the reconnect that follows would coalesce into it and never send anything.
   */
  readonly canSend: () => boolean;
  readonly nowMs: () => number;
}

export interface AdminState {
  /** After `auth.ok`: resume from the cursor, or take the snapshot when there is none. */
  onAuthenticated(): void;
  /**
   * Host identity changed: every cached entity belongs to the previous host.
   *
   * The previous host's cursor is dematerialized with its caches — a cursor is only ever usable
   * together with the entities it describes, so switching back later takes a fresh snapshot
   * instead of resuming with a number whose state was just thrown away.
   */
  onHostChanged(previousHostId: string | null, nextHostId: string | null): void;
  onEventFrame(frame: EventFrame): void;
  onSnapshotFrame(frame: SnapshotFrame): void;
  /** Explicit `sync.snapshot`. Coalesced while one is in flight. */
  requestSnapshot(reason: string): Promise<boolean>;
  loadHostStatus(): Promise<RpcResult<HostStatus>>;
  loadConversations(refresh?: boolean): Promise<LoadOutcome>;
  loadMessages(conversationId: RemoteId, refresh?: boolean): Promise<LoadOutcome>;
  /** Persists the cursor before the process may be frozen or reclaimed. */
  flush(): void;
  /** Sign-out: drop every cached entity and every cursor. */
  clearAll(): void;
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createAdminState(options: AdminStateOptions): AdminState {
  const { stores, resume, reads } = options;
  const applier = createRemoteStateApplier({ stores, nowMs: options.nowMs });

  let snapshotInFlight: Promise<boolean> | null = null;
  /**
   * Bumped whenever the authoritative state is replaced or thrown away: a snapshot is accepted,
   * the host changes, or the operator signs out.
   *
   * Anything that started before the bump — a `sync.snapshot` RPC, a page read — was computed
   * against a state that no longer exists. Applying it afterwards would resurrect entities (and
   * a cursor) that were already discarded, so it is dropped instead.
   */
  let stateGeneration = 0;
  /** Applied events since process start; used to detect a read that raced with live events. */
  let appliedEvents = 0;

  function diagnostic(scope: string, message: string): void {
    stores.connection.pushDiagnostic(scope, message, options.nowMs());
  }

  function mirror(): void {
    const hostId = options.getHostId();
    stores.connection.setResyncRequired(hostId === null ? false : resume.needsSnapshot(hostId));
    stores.connection.setResumeFrom(hostId === null ? null : resume.resumeFrom(hostId));
  }

  /**
   * The single place a snapshot is accepted. `baseSeq` is the sequence the payload is valid at,
   * so the cursor and the entities move together — a page can never see new entities under an old
   * cursor, or a new cursor without entities.
   */
  function acceptSnapshot(hostId: string, payload: SnapshotPayload, source: string): void {
    const before = resume.state(hostId);
    const baseSeq = isSeq(payload?.baseSeq) ? payload.baseSeq : null;
    if (baseSeq === null) {
      diagnostic("snapshot", `${source} 快照缺少合法 baseSeq，已丢弃`);
      return;
    }
    if (before.lastSeq !== null && baseSeq < before.lastSeq) {
      // The host's sequence is behind the cursor we remember (host restart, or a cursor restored
      // from another host generation). The snapshot is authoritative, so it wins and the cursor
      // is reset instead of leaving the client waiting forever for an unreachable seq.
      diagnostic("snapshot", `快照基线 ${baseSeq} 落后于本地游标 ${before.lastSeq}：以主机快照为准重置`);
    }
    if (!resume.applySnapshot(hostId, baseSeq)) {
      diagnostic("snapshot", `${source} 快照 baseSeq 非法，已丢弃`);
      return;
    }
    if (!applier.applySnapshot(payload)) {
      // An unusable payload means the entities were *not* reconstructed, so the cursor must not
      // claim they were: the session keeps asking for a snapshot it can actually trust.
      resume.dematerialize(hostId);
      diagnostic("snapshot", `${source} 快照实体不合法，已丢弃并继续等待可用快照`);
    } else {
      // A new authoritative baseline supersedes every read that started before it.
      stateGeneration += 1;
    }
    mirror();
  }

  function requestSnapshot(reason: string): Promise<boolean> {
    if (snapshotInFlight !== null) {
      // Coalesced: two gaps must not produce two concurrent authoritative reloads.
      return snapshotInFlight;
    }
    const hostId = options.getHostId();
    if (hostId === null) {
      return Promise.resolve(false);
    }
    if (!options.canSend()) {
      // Offline: nothing can be sent, and nothing may be remembered as outstanding, or the
      // reconnect that follows would coalesce into this dead attempt. The session stays flagged
      // as needing a snapshot, so the next `auth.ok` primes it.
      mirror();
      return Promise.resolve(false);
    }
    const generationAtStart = stateGeneration;
    const pending = (async (): Promise<boolean> => {
      const result = await reads.syncSnapshot(SNAPSHOT_CONVERSATION_LIMIT);
      // The host may have been switched, a newer snapshot (for example an unsolicited `snapshot`
      // frame) may already have been accepted, or the operator may have signed out while this
      // request was in flight. In every case the result describes a state that is no longer
      // current, and applying it would clobber the newer one.
      if (stateGeneration !== generationAtStart || options.getHostId() !== hostId) {
        return false;
      }
      if (!result.ok) {
        diagnostic("snapshot", `${reason}：${describeErrorCode(result.error.code) || result.error.message}`);
        mirror();
        return false;
      }
      acceptSnapshot(hostId, result.value, "sync.snapshot");
      return true;
    })();

    snapshotInFlight = pending;
    const release = (): void => {
      // Only the attempt that still owns the slot may clear it: a stale one settling late must
      // not detach the request that replaced it.
      if (snapshotInFlight === pending) {
        snapshotInFlight = null;
      }
    };
    void pending.then(release, release);
    return pending;
  }

  function onEventFrame(frame: EventFrame): void {
    const hostId = options.getHostId();
    if (hostId === null || frame.hostId !== hostId) {
      return;
    }
    const observation = resume.observe(hostId, frame.seq);
    switch (observation.kind) {
      case "applied":
        if (applier.applyEvent(frame)) {
          appliedEvents += 1;
        }
        break;
      case "duplicate":
        // Idempotent by definition: the host may resend after a resume.
        break;
      case "gap":
        diagnostic(
          "resume",
          `事件缺口：期望 seq ${observation.expected}，收到 ${observation.received}，改为请求快照`
        );
        void requestSnapshot("事件缺口");
        break;
      case "stale":
        diagnostic("resume", `事件 seq ${observation.seq} 落后于快照基线：主机序号已回退，改为请求快照`);
        void requestSnapshot("序号回退");
        break;
      case "unprimed":
        void requestSnapshot("尚无快照基线");
        break;
      case "invalid":
        diagnostic("resume", "事件 seq 非法，改为请求快照");
        void requestSnapshot("seq 非法");
        break;
      case "awaiting_snapshot":
        break;
    }
    mirror();
  }

  function onSnapshotFrame(frame: SnapshotFrame): void {
    const hostId = options.getHostId();
    if (hostId === null || frame.hostId !== hostId) {
      return;
    }
    // `payload.baseSeq` is the state the payload describes; the envelope `seq` only positions this
    // frame. Prefer the payload, fall back to the envelope when a host omits it.
    const payload: SnapshotPayload = isSeq(frame.payload?.baseSeq)
      ? frame.payload
      : { ...frame.payload, baseSeq: frame.seq };
    acceptSnapshot(hostId, payload, "snapshot 帧");
  }

  function onAuthenticated(): void {
    const hostId = options.getHostId();
    if (hostId === null) {
      mirror();
      return;
    }
    const resumeFrom = resume.resumeFrom(hostId);
    if (resumeFrom === null) {
      void requestSnapshot("缺少可用游标");
      mirror();
      return;
    }
    if (!options.sendResume(hostId, resumeFrom)) {
      void requestSnapshot("resume 未发出");
    }
    mirror();
  }

  function onHostChanged(previousHostId: string | null, nextHostId: string | null): void {
    // Host-scoped caches: showing another host's conversations is worse than showing none, so
    // everything is dropped and re-established from the new host's snapshot. The generation bump
    // also strands any read still in flight for the previous host.
    stateGeneration += 1;
    snapshotInFlight = null;
    applier.clearAll();
    if (previousHostId !== null) {
      resume.dematerialize(previousHostId);
    }
    if (nextHostId !== null) {
      diagnostic("host", `已切换到主机 ${nextHostId}，本地缓存已清空并等待快照`);
    }
    mirror();
  }

  function errorOutcome(reason: LoadReason, message: string): LoadOutcome {
    return { ok: false, reason, message };
  }

  function failureMessage(error: { readonly code: RemoteErrorCode; readonly message: string }): string {
    return describeErrorCode(error.code) || error.message;
  }

  async function loadConversations(refresh = false): Promise<LoadOutcome> {
    const hostId = options.getHostId();
    if (hostId === null) {
      return errorOutcome("no_host", NO_HOST_MESSAGE);
    }
    const store = stores.conversations;
    const fetchSeq = store.beginFetch(refresh);
    const eventsAtStart = appliedEvents;
    const generationAtStart = stateGeneration;
    const cursor = refresh ? null : store.getState().cursor;
    const result = await reads.listConversations({
      ...(cursor === null ? {} : { cursor }),
      limit: CONVERSATION_PAGE_SIZE
    });
    if (stateGeneration !== generationAtStart || options.getHostId() !== hostId) {
      return errorOutcome("dropped", "主机或权威快照已变化，分页结果已丢弃");
    }
    if (!result.ok) {
      const message = failureMessage(result.error);
      store.fail(fetchSeq, message);
      return errorOutcome("rpc_error", message);
    }
    // `applyPage` drops the page itself when a newer fetch superseded this one, and merges by
    // `updatedAt`, so a slow page cannot overwrite an event that arrived while it was in flight.
    // A refresh that raced with live events merges instead of replacing for the same reason: the
    // page was read before the event, and a replace would silently lose it.
    store.applyPage(fetchSeq, result.value, refresh && appliedEvents === eventsAtStart);
    return { ok: true };
  }

  async function loadMessages(conversationId: RemoteId, refresh = false): Promise<LoadOutcome> {
    const hostId = options.getHostId();
    if (hostId === null) {
      return errorOutcome("no_host", NO_HOST_MESSAGE);
    }
    const store = stores.messages;
    const thread = store.thread(conversationId);
    const fetchSeq = store.beginFetch(conversationId, refresh);
    const eventsAtStart = appliedEvents;
    const generationAtStart = stateGeneration;
    const cursor = refresh ? null : thread.cursor;
    const result = await reads.listMessages(conversationId, {
      ...(cursor === null ? {} : { cursor }),
      limit: MESSAGE_PAGE_SIZE
    });
    if (stateGeneration !== generationAtStart || options.getHostId() !== hostId) {
      return errorOutcome("dropped", "主机或权威快照已变化，分页结果已丢弃");
    }
    if (!result.ok) {
      const message = failureMessage(result.error);
      store.fail(conversationId, fetchSeq, message);
      return errorOutcome("rpc_error", message);
    }
    store.applyPage(
      conversationId,
      fetchSeq,
      result.value,
      refresh && appliedEvents === eventsAtStart
    );
    return { ok: true };
  }

  async function loadHostStatus(): Promise<RpcResult<HostStatus>> {
    const hostId = options.getHostId();
    const generationAtStart = stateGeneration;
    const result = await reads.hostStatus();
    // A status read that raced with a snapshot, a host switch or a sign-out must not write into
    // the mirror it was measured against.
    if (result.ok && stateGeneration === generationAtStart && options.getHostId() === hostId) {
      stores.host.setHostStatus(result.value, options.nowMs());
    }
    return result;
  }

  return {
    onAuthenticated,
    onHostChanged,
    onEventFrame,
    onSnapshotFrame,
    requestSnapshot,
    loadHostStatus,
    loadConversations,
    loadMessages,
    flush() {
      resume.flush();
    },
    clearAll() {
      // Isolation: no cache, no cursor and no request that started before the sign-out may
      // restore any of it.
      stateGeneration += 1;
      snapshotInFlight = null;
      applier.clearAll();
      resume.reset();
      mirror();
    }
  };
}

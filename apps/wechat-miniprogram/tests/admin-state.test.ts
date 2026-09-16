/**
 * W3 resume/store wiring tests.
 *
 * These drive the *production* `adminConnection` through the W2 fake transport (real frames, real
 * admission pipeline, real RPC correlation; only `wx.connectSocket` is a double). That is what
 * makes the sequence rules observable: a gap has to appear as a `sync.snapshot` on the wire, a
 * duplicate has to leave the caches untouched, and a late page has to lose to a newer event.
 *
 * No page, no write method and no terminal is exercised here: this substage ships the recovery
 * and read-through layer only.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createHostTargetRegistry } from "../miniprogram/config/hostTarget";
import { createOperatorTokenSession } from "../miniprogram/services/adminSession";
import { createAdminConnection, type AdminConnection } from "../miniprogram/services/adminConnection";
import { createAdminStores, type AdminStores } from "../miniprogram/stores/adminStores";
import { createMemoryResumeCursorStorage } from "../miniprogram/services/resumeCursorStorage";

import {
  ISOTIME,
  adminAuthOkFrame,
  conversationSummary,
  createManualScheduler,
  createSocketHub,
  createTestIdFactory,
  eventFrame,
  framesOfMethod,
  messageSummary,
  rpcResponseFrame,
  sentFrames,
  snapshotFrame,
  snapshotPayload,
  type SocketHub
} from "./helpers/fakeTransport";

const TOKEN = "local-dev-token";
const HOST_ID = "host-1";
const HOST_2 = "host-2";
const URL = "ws://127.0.0.1:8080/v1/ws/admin";

interface Harness {
  connection: AdminConnection;
  stores: AdminStores;
  hub: SocketHub;
  storage: ReturnType<typeof createMemoryResumeCursorStorage>;
  advance(ms: number): void;
  /** Sends `auth.ok` on the newest socket. */
  open(): void;
  /** Last `rpc.request` of a method, as it went on the wire. */
  lastRequest(method: string): Record<string, unknown>;
  /** Answers the last outstanding `sync.snapshot` with a payload. */
  answerSnapshot(baseSeq: number, overrides?: Record<string, unknown>): Promise<void>;
  /** Answers the last outstanding request of a method with a page. */
  answerPage(method: string, items: readonly unknown[], nextCursor: string | null): void;
}

function harness(): Harness {
  const hub = createSocketHub();
  const scheduler = createManualScheduler();
  const storage = createMemoryResumeCursorStorage();
  const stores = createAdminStores();
  const connection = createAdminConnection({
    adminSocketUrl: URL,
    clientVersion: "0.0.0",
    createSocket: (url) => hub.createSocket(url),
    scheduler,
    isoNow: () => ISOTIME,
    nextId: createTestIdFactory(),
    random: () => 0.5,
    tokenSession: createOperatorTokenSession(),
    hostTarget: createHostTargetRegistry(),
    stores,
    resumeStorage: storage
  });

  const h: Harness = {
    connection,
    stores,
    hub,
    storage,
    advance: (ms) => scheduler.advance(ms),
    open() {
      hub.last().fireOpen();
      hub.deliver(adminAuthOkFrame());
    },
    lastRequest(method) {
      const frames = framesOfMethod(hub.last(), method);
      const frame = frames[frames.length - 1];
      assert.ok(frame, `no ${method} request on the wire`);
      return frame;
    },
    async answerSnapshot(baseSeq, overrides = {}) {
      const request = h.lastRequest("sync.snapshot");
      hub.deliver(
        rpcResponseFrame(HOST_ID, request.id as string, snapshotPayload(HOST_ID, baseSeq, overrides))
      );
      await settle();
    },
    answerPage(method, items, nextCursor) {
      const request = h.lastRequest(method);
      hub.deliver(
        rpcResponseFrame(HOST_ID, request.id as string, { items: [...items], nextCursor })
      );
    }
  };

  connection.setToken(TOKEN);
  connection.setHostId(HOST_ID);
  return h;
}

/**
 * Lets the response path settle: an `rpc.response` is applied after the awaits inside the read
 * layer, so a synchronous test must yield once before it can observe the stores.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Cold start: connected, and the initial snapshot answered. */
async function booted(h: Harness, baseSeq = 7, overrides: Record<string, unknown> = {}): Promise<void> {
  h.connection.connect("test");
  h.open();
  await h.answerSnapshot(baseSeq, overrides);
}

/** `rpc.request` carries its method params under `payload.params`. */
function paramsOf(frame: Record<string, unknown>): Record<string, unknown> {
  return (frame.payload as { params?: Record<string, unknown> }).params ?? {};
}

function conversationEvent(seq: number, overrides: Record<string, unknown> = {}): string {
  return eventFrame(HOST_ID, "conversation.updated", seq, conversationSummary(overrides));
}

describe("cold start baseline", () => {
  test("a fresh connection takes sync.snapshot, never resume", () => {
    const h = harness();
    h.connection.connect("test");
    h.open();

    assert.equal(framesOfMethod(h.hub.last(), "sync.snapshot").length, 1);
    assert.equal(
      sentFrames(h.hub.last()).filter((frame) => frame.type === "resume").length,
      0,
      "没有游标时不得发送 resume"
    );
    assert.equal(h.stores.host.getState().host, null);
    assert.equal(h.connection.resume.needsSnapshot(HOST_ID), true);
  });

  test("the snapshot replaces host and conversations atomically and primes the cursor", async () => {
    const h = harness();
    await booted(h, 7, { conversations: [conversationSummary({ conversationId: "c1", title: "first" })] });

    assert.equal(h.stores.host.getState().host?.hostId, HOST_ID);
    assert.equal(h.stores.host.getState().baseSeq, 7);
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["first"]
    );
    assert.equal(h.connection.resume.state(HOST_ID).materialized, true);
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), 7);
    assert.equal(h.stores.connection.getState().resyncRequired, false);
    assert.equal(h.stores.connection.getState().resumeFrom, 7);
  });

  test("an unusable snapshot payload is rejected as a whole", async () => {
    const h = harness();
    h.connection.connect("test");
    h.open();
    const request = h.lastRequest("sync.snapshot");
    // `host` is required by `protocol/remote/v1`; without it there is nothing to reconstruct.
    h.hub.deliver(
      rpcResponseFrame(HOST_ID, request.id as string, { baseSeq: 9, conversations: [] })
    );
    await settle();

    assert.equal(h.stores.host.getState().host, null);
    assert.equal(h.connection.resume.state(HOST_ID).materialized, false);
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), null, "实体没重建时游标不得可用");
    assert.equal(h.stores.connection.getState().resyncRequired, true);
  });

  test("a snapshot frame supersedes a sync.snapshot that is still in flight", async () => {
    const h = harness();
    await booted(h, 7, { conversations: [conversationSummary({ title: "old" })] });

    const syncing = h.connection.state.requestSnapshot("gap");
    const request = h.lastRequest("sync.snapshot");

    // The host pushes a newer authoritative snapshot before answering the outstanding request.
    h.hub.deliver(
      snapshotFrame(HOST_ID, 20, { conversations: [conversationSummary({ title: "pushed" })] })
    );
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), 20);

    // The older RPC result then lands: it must be discarded, not layered over the newer baseline.
    h.hub.deliver(
      rpcResponseFrame(
        HOST_ID,
        request.id as string,
        snapshotPayload(HOST_ID, 15, { conversations: [conversationSummary({ title: "stale rpc" })] })
      )
    );
    assert.equal(await syncing, false, "被更新快照取代的在途结果必须丢弃");
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), 20, "在途旧快照不得回退游标");
    assert.equal(h.stores.host.getState().baseSeq, 20);
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["pushed"]
    );
  });

  test("a fetch superseded by a snapshot is dropped instead of overwriting it", async () => {
    const h = harness();
    await booted(h, 7);

    const pending = h.connection.state.loadConversations(true);
    const request = h.lastRequest("conversation.list");
    h.hub.deliver(
      snapshotFrame(HOST_ID, 30, { conversations: [conversationSummary({ title: "snapshot" })] })
    );
    h.hub.deliver(
      rpcResponseFrame(HOST_ID, request.id as string, {
        items: [conversationSummary({ title: "page" })],
        nextCursor: null
      })
    );

    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "dropped");
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["snapshot"]
    );
  });

  test("a failed snapshot keeps the session marked as needing one", async () => {
    const h = harness();
    h.connection.connect("test");
    h.open();
    const request = h.lastRequest("sync.snapshot");
    h.hub.deliver(
      JSON.stringify({
        v: 1,
        id: "m-fail",
        type: "rpc.response",
        hostId: HOST_ID,
        sentAt: ISOTIME,
        payload: {
          requestId: request.id,
          ok: false,
          error: { code: "host_offline", message: "host offline", retryable: true }
        }
      })
    );
    await settle();

    assert.equal(h.stores.host.getState().host, null);
    assert.equal(h.connection.resume.needsSnapshot(HOST_ID), true);
    assert.equal(h.stores.connection.getState().resyncRequired, true);
    assert.match(h.stores.connection.getState().lastViolation ?? "", /主机离线/);
  });
});

describe("event sequencing", () => {
  test("events apply in order and a repeated seq is idempotent", async () => {
    const h = harness();
    await booted(h, 7);

    h.hub.deliver(conversationEvent(8, { title: "after event" }));
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["after event"]
    );
    assert.equal(h.connection.resume.state(HOST_ID).lastSeq, 8);

    // Same seq twice: the second delivery must not re-apply, and a *different* payload under the
    // same seq must never overwrite the applied one (that is exactly what a replay looks like).
    h.hub.deliver(conversationEvent(8, { title: "replayed" }));
    h.hub.deliver(conversationEvent(8, { title: "replayed again" }));
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["after event"]
    );
    assert.equal(h.connection.resume.state(HOST_ID).lastSeq, 8);
    assert.equal(h.connection.resume.state(HOST_ID).duplicateCount, 2);
  });

  test("a gap immediately asks for the authoritative snapshot and blocks the stream", async () => {
    const h = harness();
    await booted(h, 7);

    h.hub.deliver(conversationEvent(12, { title: "never applied" }));
    assert.equal(h.stores.conversations.getState().items.length, 0, "缺口事件不得写入缓存");
    assert.equal(framesOfMethod(h.hub.last(), "sync.snapshot").length, 2);
    assert.equal(h.stores.connection.getState().resyncRequired, true);

    h.hub.deliver(conversationEvent(13, { title: "still blocked" }));
    assert.equal(h.stores.conversations.getState().items.length, 0);

    await h.answerSnapshot(20, { conversations: [conversationSummary({ title: "authoritative" })] });
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["authoritative"]
    );
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), 20);
    assert.equal(h.stores.connection.getState().resyncRequired, false);

    h.hub.deliver(
      conversationEvent(21, { title: "after resync", updatedAt: "2026-09-14T11:00:00.000Z" })
    );
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["after resync"]
    );
  });

  test("an event older than the snapshot baseline is treated as a host restart", async () => {
    const h = harness();
    await booted(h, 100);

    h.hub.deliver(conversationEvent(3, { title: "old" }));
    assert.equal(h.stores.conversations.getState().items.length, 0);
    assert.equal(framesOfMethod(h.hub.last(), "sync.snapshot").length, 2);
    assert.match(h.stores.connection.getState().lastViolation ?? "", /回退/);

    await h.answerSnapshot(4, { conversations: [conversationSummary({ title: "after restart" })] });
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), 4);
  });

  test("a snapshot frame behind the local cursor wins (future cursor fallback)", async () => {
    const h = harness();
    await booted(h, 500);
    h.hub.deliver(conversationEvent(501, { title: "before reset" }));
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), 501);

    // The host's sequence restarted: its snapshot is authoritative even though it is behind us.
    h.hub.deliver(snapshotFrame(HOST_ID, 2, { conversations: [conversationSummary({ title: "reset" })] }));
    assert.equal(h.connection.resume.state(HOST_ID).lastSeq, 2);
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["reset"]
    );
    assert.match(h.stores.connection.getState().lastViolation ?? "", /落后于本地游标/);

    h.hub.deliver(
      conversationEvent(3, { title: "after reset", updatedAt: "2026-09-14T11:00:00.000Z" })
    );
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["after reset"]
    );
  });

  test("an illegal event seq is rejected by the protocol layer, not applied", async () => {
    const h = harness();
    await booted(h, 7);
    const before = h.connection.getSnapshot().violations;

    h.hub.deliver(eventFrame(HOST_ID, "host.status.changed", -1, {}));

    // `parseRemoteFrame` rejects the frame, so it never reaches the sequence gate, the stores or
    // the resync path. (The `invalid` branch of the gate is covered by resume-manager tests.)
    assert.equal(h.connection.getSnapshot().violations, before + 1);
    assert.equal(framesOfMethod(h.hub.last(), "sync.snapshot").length, 1);
    assert.equal(h.connection.resume.state(HOST_ID).lastSeq, 7);
  });

  test("a snapshot prunes message threads of conversations the host no longer owns", async () => {
    const h = harness();
    await booted(h, 7);
    h.stores.messages.upsert(messageSummary({ conversationId: "c9" }) as never);
    assert.equal(h.stores.messages.thread("c9").items.length, 1);

    const syncing = h.connection.state.requestSnapshot("prune test");
    await h.answerSnapshot(8, { conversations: [conversationSummary({ conversationId: "c1" })] });
    assert.equal(await syncing, true);
    assert.equal(h.stores.messages.thread("c9").items.length, 0, "快照不拥有的会话线程必须被清理");
  });
});

describe("reconnect and lifecycle", () => {
  test("a reconnect resumes from the last applied seq instead of re-snapshotting", async () => {
    const h = harness();
    await booted(h, 7);
    h.hub.deliver(conversationEvent(8));

    h.hub.last().fireClose(1006, "gone");
    h.advance(5_000);
    assert.equal(h.hub.tasks.length, 2, "断线后必须重连");
    h.open();

    const resumes = sentFrames(h.hub.last()).filter((frame) => frame.type === "resume");
    assert.equal(resumes.length, 1);
    assert.equal((resumes[0].payload as { resumeFrom: number }).resumeFrom, 8);
    assert.equal(resumes[0].hostId, HOST_ID);
    assert.equal(framesOfMethod(h.hub.last(), "sync.snapshot").length, 0);
  });

  test("background persists the cursor; the cache stays authoritative in-session", async () => {
    const h = harness();
    await booted(h, 7);
    h.hub.deliver(conversationEvent(8));

    h.connection.notifyBackground();
    assert.deepEqual(h.storage.snapshot()[HOST_ID], { baseSeq: 7, lastSeq: 8 });
    // Still materialized in this process: a foreground return resumes instead of re-snapshotting.
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), 8);

    h.connection.notifyForeground();
    const pings = sentFrames(h.hub.last()).filter((frame) => frame.type === "ping");
    assert.equal(pings.length >= 1, true);
  });

  test("sign-out clears entities, cursors, persisted state and the credential", async () => {
    const h = harness();
    await booted(h, 7, { conversations: [conversationSummary()] });
    h.hub.deliver(eventFrame(HOST_ID, "message.created", 8, messageSummary()));
    assert.equal(h.stores.messages.thread("c1").items.length, 1);

    h.connection.signOut("operator signed out");

    assert.equal(h.connection.hasToken(), false);
    assert.equal(h.stores.host.getState().host, null);
    assert.equal(h.stores.conversations.getState().items.length, 0);
    assert.equal(h.stores.messages.getState().threads.c1, undefined);
    assert.deepEqual(h.connection.resume.states(), []);
    assert.deepEqual(h.storage.snapshot(), {}, "注销必须清掉持久化游标");
  });

  test("a snapshot that resolves after sign-out cannot repopulate anything", async () => {
    const h = harness();
    await booted(h, 7, { conversations: [conversationSummary({ title: "before" })] });

    const syncing = h.connection.state.requestSnapshot("in flight");
    const request = h.lastRequest("sync.snapshot");
    // The response lands while the socket is still up, so the read layer's continuation is queued
    // but has not run yet — the operator signs out in that window.
    h.hub.deliver(
      rpcResponseFrame(
        HOST_ID,
        request.id as string,
        snapshotPayload(HOST_ID, 9, { conversations: [conversationSummary({ title: "resurrected" })] })
      )
    );
    h.connection.signOut("operator signed out");

    assert.equal(await syncing, false, "注销后到达的快照必须被丢弃");
    await settle();
    assert.equal(h.stores.host.getState().host, null);
    assert.equal(h.stores.conversations.getState().items.length, 0);
    assert.deepEqual(h.connection.resume.states(), [], "注销后不得重建游标");
    assert.deepEqual(h.storage.snapshot(), {});
  });
});

describe("read-through paging", () => {
  test("pages merge, keep the cursor, and are bounded by the store cap", async () => {
    const h = harness();
    await booted(h, 7);

    const first = h.connection.state.loadConversations(true);
    h.answerPage("conversation.list", [conversationSummary({ conversationId: "c1" })], "page-2");
    assert.equal((await first).ok, true);
    assert.equal(h.stores.conversations.getState().hasMore, true);
    assert.equal(h.stores.conversations.getState().cursor, "page-2");

    const second = h.connection.state.loadConversations(false);
    const request = h.lastRequest("conversation.list");
    assert.equal(paramsOf(request).cursor, "page-2");
    assert.equal(paramsOf(request).limit, 50);
    h.answerPage("conversation.list", [conversationSummary({ conversationId: "c2" })], null);
    assert.equal((await second).ok, true);

    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.conversationId),
      ["c1", "c2"]
    );
    assert.equal(h.stores.conversations.getState().hasMore, false);
  });

  test("an old page never overwrites an event that arrived while it was in flight", async () => {
    const h = harness();
    await booted(h, 7);

    const pending = h.connection.state.loadConversations(true);
    const request = h.lastRequest("conversation.list");
    // Newer event wins by `updatedAt`, even though the page is the "authoritative" read.
    h.hub.deliver(
      conversationEvent(8, {
        conversationId: "c1",
        title: "from event",
        updatedAt: "2026-09-14T11:00:00.000Z"
      })
    );
    h.hub.deliver(
      rpcResponseFrame(HOST_ID, request.id as string, {
        items: [
          conversationSummary({ conversationId: "c1", title: "from page", updatedAt: "2026-09-14T09:00:00.000Z" })
        ],
        nextCursor: null
      })
    );
    assert.equal((await pending).ok, true);
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["from event"]
    );
  });

  test("a superseded fetch is dropped instead of interleaving pages", async () => {
    const h = harness();
    await booted(h, 7);

    const stale = h.connection.state.loadConversations(true);
    const staleRequest = h.lastRequest("conversation.list");
    const fresh = h.connection.state.loadConversations(true);
    const freshRequest = h.lastRequest("conversation.list");
    assert.notEqual(staleRequest.id, freshRequest.id);

    h.hub.deliver(
      rpcResponseFrame(HOST_ID, staleRequest.id as string, {
        items: [conversationSummary({ conversationId: "stale" })],
        nextCursor: null
      })
    );
    assert.equal((await stale).ok, true);
    assert.equal(h.stores.conversations.getState().items.length, 0, "过期分页不得写入");

    h.hub.deliver(
      rpcResponseFrame(HOST_ID, freshRequest.id as string, {
        items: [conversationSummary({ conversationId: "fresh" })],
        nextCursor: null
      })
    );
    assert.equal((await fresh).ok, true);
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.conversationId),
      ["fresh"]
    );
  });

  test("message pages are per conversation and bounded", async () => {
    const h = harness();
    await booted(h, 7);

    const pending = h.connection.state.loadMessages("c1", true);
    const request = h.lastRequest("message.list");
    assert.equal(paramsOf(request).conversationId, "c1");
    h.answerPage("message.list", [messageSummary({ messageId: "m1" }), messageSummary({ messageId: "m2" })], null);
    assert.equal((await pending).ok, true);
    assert.deepEqual(
      h.stores.messages.thread("c1").items.map((item) => item.messageId),
      ["m1", "m2"]
    );
  });

  test("a late message page does not overwrite an event that arrived while it was in flight", async () => {
    const h = harness();
    await booted(h, 7);

    // A live event carries the up-to-date content for the message the page will also return.
    h.hub.deliver(
      eventFrame(HOST_ID, "message.updated", 8, messageSummary({ messageId: "m1", content: "from event" }))
    );
    assert.equal(h.stores.messages.thread("c1").items[0]?.content, "from event");

    const pending = h.connection.state.loadMessages("c1", false);
    h.answerPage("message.list", [messageSummary({ messageId: "m1", content: "from page" })], null);
    assert.equal((await pending).ok, true);

    assert.equal(
      h.stores.messages.thread("c1").items[0]?.content,
      "from event",
      "晚到的分页不得把 live 事件回退成旧内容"
    );
  });

  test("host status reads merge into the host mirror", async () => {
    const h = harness();
    await booted(h, 7);
    const pending = h.connection.state.loadHostStatus();
    h.hub.deliver(
      rpcResponseFrame(HOST_ID, h.lastRequest("host.status").id as string, {
        hostId: HOST_ID,
        online: true,
        appVersion: "0.9.10",
        protocolVersion: 1,
        remoteEnabled: true,
        activeRunCount: 2,
        pendingDecisionCount: 1,
        activeTerminalCount: 0,
        serverTime: "2026-09-14T12:00:00.000Z"
      })
    );
    assert.equal((await pending).ok, true);
    assert.equal(h.stores.host.getState().host?.activeRunCount, 2);
  });
});

describe("host scoping", () => {
  test("switching hosts clears caches and withdraws the previous host's cursor", async () => {
    const h = harness();
    await booted(h, 7, { conversations: [conversationSummary({ title: "host one" })] });
    h.hub.deliver(conversationEvent(8));

    h.connection.setHostId(HOST_2);

    assert.equal(h.stores.host.getState().host, null, "不得显示上一台主机的实体");
    assert.equal(h.stores.conversations.getState().items.length, 0);
    assert.equal(h.connection.resume.state(HOST_ID).lastSeq, 8, "游标保留用于诊断");
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), null, "实体已丢弃，游标不得再用于 resume");

    // The new host has no baseline, so it is primed with its own snapshot.
    h.hub.deliver(
      rpcResponseFrame(HOST_2, h.lastRequest("sync.snapshot").id as string, {
        baseSeq: 3,
        host: {
          hostId: HOST_2,
          online: true,
          appVersion: "0.0.0",
          protocolVersion: 1,
          remoteEnabled: true,
          activeRunCount: 0,
          pendingDecisionCount: 0,
          activeTerminalCount: 0,
          serverTime: ISOTIME
        },
        conversations: [conversationSummary({ title: "host two" })]
      })
    );
    await settle();
    assert.deepEqual(
      h.stores.conversations.getState().items.map((item) => item.title),
      ["host two"]
    );
    assert.equal(h.connection.resume.resumeFrom(HOST_2), 3);

    // Switching back must not resume from the abandoned cursor.
    h.connection.setHostId(HOST_ID);
    assert.equal(h.connection.resume.resumeFrom(HOST_ID), null);
    assert.equal(h.connection.resume.needsSnapshot(HOST_ID), true);
  });

  test("a page that arrives after the host changed is dropped", async () => {
    const h = harness();
    await booted(h, 7);

    const pending = h.connection.state.loadConversations(true);
    const request = h.lastRequest("conversation.list");
    h.connection.setHostId(HOST_2);
    h.hub.deliver(
      rpcResponseFrame(HOST_ID, request.id as string, {
        items: [conversationSummary({ title: "other host" })],
        nextCursor: null
      })
    );
    // The transport refuses to settle a response for a host that is no longer selected, so the
    // request only resolves when the connection fails it — and then the switch discards it.
    assert.equal(h.connection.pendingCount() >= 1, true);
    h.hub.last().fireClose(1006, "gone");

    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "dropped");
    assert.equal(h.stores.conversations.getState().items.length, 0);
  });

  test("reads without a configured host are refused locally", async () => {
    const h = harness();
    h.connection.setHostId(null);
    const outcome = await h.connection.state.loadConversations();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "no_host");
    assert.equal(h.connection.pendingCount(), 0, "不得向服务端发出没有 hostId 的请求");
  });
});

describe("cached entity whitelist", () => {
  test("unknown fields — including token-looking ones — are never cached", async () => {
    const h = harness();
    await booted(h, 7, {
      conversations: [
        conversationSummary({
          conversationId: "c1",
          title: "ok",
          accessToken: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sessionKey: "kkkk",
          bogus: 1
        })
      ]
    });
    h.hub.deliver(
      eventFrame(HOST_ID, "message.created", 8, messageSummary({ content: "hi", refreshToken: "rrrr" }))
    );

    const cached = JSON.stringify({
      conversations: h.stores.conversations.getState().items,
      messages: h.stores.messages.thread("c1").items,
      host: h.stores.host.getState().host
    });
    assert.ok(!cached.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    assert.ok(!cached.includes("sessionKey"));
    assert.ok(!cached.includes("refreshToken"));
    assert.ok(!cached.includes("bogus"));
    assert.deepEqual(
      Object.keys(h.stores.conversations.getState().items[0] ?? {}).sort(),
      [
        "archived",
        "conversationId",
        "title",
        "updatedAt"
      ]
    );
  });

  test("a malformed entity is dropped instead of cached", async () => {
    const h = harness();
    await booted(h, 7);
    h.hub.deliver(eventFrame(HOST_ID, "conversation.updated", 8, { conversationId: "c1" }));
    assert.equal(h.stores.conversations.getState().items.length, 0);
    assert.equal(h.connection.resume.state(HOST_ID).lastSeq, 8, "游标仍然前进：事件已被完整应用");
  });
});

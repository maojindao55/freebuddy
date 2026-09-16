/**
 * W3 real-Relay resume tests.
 *
 * The unit tests drive the sequence gate through a fake transport; these drive the *production*
 * `adminConnection` against a real, freshly built Go Relay on a loopback port, with a simulated
 * desktop host that originates its own sequenced frames. Only two things are substituted:
 * `wx.connectSocket` → a real WebSocket, and the Electron host → a stand-in that speaks the same
 * frames. Nothing about framing, admission, correlation, sequencing or cache merging is
 * re-implemented here, and no Go behaviour and no protocol field is modified by this file.
 *
 * Covered: cold-start snapshot priming, in-order event application, gap → `sync.snapshot`
 * fallback, authoritative `snapshot` frame replacement, and reconnect → `resume` with the last
 * completely applied seq.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { createHostTargetRegistry } from "../miniprogram/config/hostTarget";
import { createAdminConnection, type AdminConnection } from "../miniprogram/services/adminConnection";
import { createOperatorTokenSession } from "../miniprogram/services/adminSession";
import { createAdminStores, type AdminStores } from "../miniprogram/stores/adminStores";
import { createMemoryResumeCursorStorage } from "../miniprogram/services/resumeCursorStorage";
import { createDefaultScheduler, nextIdFactory } from "../miniprogram/utils/scheduler";

import { connectFakeHost, type FakeRelayHost } from "./helpers/fakeRelayHost";
import {
  cleanupRelayBuild,
  startRelay,
  type RelayInstance
} from "./helpers/relayProcess";
import { createRealSocketTask } from "./helpers/realSocket";
import { waitFor } from "./helpers/wait";
import { conversationSummary, snapshotPayload } from "./helpers/fakeTransport";

interface Session {
  readonly relay: RelayInstance;
  readonly connection: AdminConnection;
  readonly stores: AdminStores;
  /** Raw frames this client put on the wire, in order. */
  readonly sent: string[];
}

function framesOfType(list: readonly string[], type: string): Record<string, unknown>[] {
  return list
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

function openSession(relay: RelayInstance): Session {
  const sent: string[] = [];
  const stores = createAdminStores();

  const connection = createAdminConnection({
    adminSocketUrl: relay.adminSocketUrl,
    clientVersion: "0.0.0-w3-integration",
    createSocket: (url) => {
      const task = createRealSocketTask(url);
      return {
        send(data) {
          sent.push(data);
          task.send(data);
        },
        close(code, reason) {
          task.close(code, reason);
        },
        onOpen(listener) {
          task.onOpen(listener);
        },
        onMessage(listener) {
          task.onMessage(listener);
        },
        onError(listener) {
          task.onError(listener);
        },
        onClose(listener) {
          task.onClose(listener);
        }
      };
    },
    scheduler: createDefaultScheduler(),
    isoNow: () => new Date().toISOString(),
    nextId: nextIdFactory,
    random: () => 0.5,
    tokenSession: createOperatorTokenSession(),
    hostTarget: createHostTargetRegistry(),
    stores,
    resumeStorage: createMemoryResumeCursorStorage()
  });

  return { relay, connection, stores, sent };
}

async function goOnline(session: Session, token: string): Promise<void> {
  assert.equal(session.connection.setToken(token).accepted, true);
  session.connection.connect("w3 real relay");
  await waitFor(
    () => (session.connection.getSnapshot().status === "online" ? true : null),
    10_000,
    "status online"
  );
}

/** Connected, host selected, and the baseline snapshot the host answered is applied. */
async function primed(
  relay: RelayInstance,
  baseSeq = 10
): Promise<{ host: FakeRelayHost; session: Session }> {
  const host = await connectFakeHost({
    hostSocketUrl: relay.hostSocketUrl,
    hostToken: relay.hostToken,
    hostId: relay.hostId
  });
  const session = openSession(relay);
  await goOnline(session, relay.adminToken);
  session.connection.setHostId(relay.hostId);

  const requests = await host.waitForRequests("sync.snapshot", 1, 5_000);
  host.respondOk(
    requests[0].requestId,
    snapshotPayload(host.hostId, baseSeq, {
      conversations: [conversationSummary({ conversationId: "c1", title: "one" })]
    })
  );
  await waitFor(
    () => (session.connection.resume.state(host.hostId).materialized ? true : null),
    5_000,
    "baseline snapshot applied"
  );
  return { host, session };
}

function conversationTitles(session: Session): string[] {
  return session.stores.conversations.getState().items.map((item) => item.title);
}

/** `updatedAt` must move forward: the store merges by it, and the host owns the clock. */
function at(seconds: number): string {
  return `2026-09-14T10:00:${String(seconds).padStart(2, "0")}.000Z`;
}

describe("W3 resume against a real Go Relay", () => {
  after(() => {
    cleanupRelayBuild();
  });

  test("cold start: sync.snapshot primes the cursor, then events apply in order", async () => {
    const relay = await startRelay();
    const { host, session } = await primed(relay, 10);
    try {
      assert.deepEqual(conversationTitles(session), ["one"]);
      assert.equal(session.connection.resume.resumeFrom(host.hostId), 10);
      assert.equal(session.stores.host.getState().baseSeq, 10);
      assert.equal(session.stores.connection.getState().resyncRequired, false);

      // Two live events through the real Relay.
      host.sendEvent(11, "conversation.updated", conversationSummary({ title: "two", updatedAt: at(11) }));
      host.sendEvent(12, "conversation.updated", conversationSummary({ title: "three", updatedAt: at(12) }));
      await waitFor(
        () => (session.connection.resume.state(host.hostId).lastSeq === 12 ? true : null),
        5_000,
        "events 11 and 12 applied"
      );
      assert.deepEqual(conversationTitles(session), ["three"]);
      assert.equal(session.connection.getSnapshot().violations, 0);

      // A replay of an already applied seq is idempotent end-to-end.
      host.sendEvent(12, "conversation.updated", conversationSummary({ title: "replay", updatedAt: at(13) }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(conversationTitles(session), ["three"]);
      assert.equal(session.connection.resume.state(host.hostId).duplicateCount, 1);
    } finally {
      session.connection.dispose();
      await host.close();
      await relay.stop();
    }
  });

  test("gap: a skipped seq is never applied, and the client re-requests sync.snapshot", async () => {
    const relay = await startRelay();
    const { host, session } = await primed(relay, 10);
    try {
      host.sendEvent(11, "conversation.updated", conversationSummary({ title: "eleven", updatedAt: at(11) }));
      await waitFor(
        () => (session.connection.resume.state(host.hostId).lastSeq === 11 ? true : null),
        5_000,
        "event 11 applied"
      );

      // seq 14 leaves a hole: nothing may be applied until the authoritative snapshot lands.
      host.sendEvent(14, "conversation.updated", conversationSummary({ title: "gap", updatedAt: at(14) }));
      const again = await host.waitForRequests("sync.snapshot", 2, 5_000);
      assert.equal(again.length, 2, "缺口必须触发新的 sync.snapshot");
      assert.deepEqual(conversationTitles(session), ["eleven"], "缺口事件不得写入缓存");
      assert.equal(session.stores.connection.getState().resyncRequired, true);

      host.respondOk(
        again[1].requestId,
        snapshotPayload(host.hostId, 20, {
          conversations: [conversationSummary({ title: "authoritative", updatedAt: at(20) })]
        })
      );
      await waitFor(
        () => (session.connection.resume.state(host.hostId).lastSeq === 20 ? true : null),
        5_000,
        "snapshot at 20 applied"
      );
      assert.deepEqual(conversationTitles(session), ["authoritative"]);
      assert.equal(session.stores.connection.getState().resyncRequired, false);

      // The stream continues above the new baseline.
      host.sendEvent(21, "conversation.updated", conversationSummary({ title: "after gap", updatedAt: at(21) }));
      await waitFor(
        () => (conversationTitles(session)[0] === "after gap" ? true : null),
        5_000,
        "event 21 applied"
      );
    } finally {
      session.connection.dispose();
      await host.close();
      await relay.stop();
    }
  });

  test("a host snapshot frame replaces the cache and resets the cursor", async () => {
    const relay = await startRelay();
    const { host, session } = await primed(relay, 10);
    try {
      host.sendEvent(11, "conversation.updated", conversationSummary({ title: "eleven", updatedAt: at(11) }));
      await waitFor(
        () => (session.connection.resume.state(host.hostId).lastSeq === 11 ? true : null),
        5_000,
        "event 11 applied"
      );

      // The host restarts its sequence: its snapshot is authoritative even though it is behind us.
      host.sendSnapshot(
        4,
        snapshotPayload(host.hostId, 4, {
          conversations: [conversationSummary({ title: "after restart", updatedAt: at(30) })]
        })
      );
      await waitFor(
        () => (session.connection.resume.state(host.hostId).lastSeq === 4 ? true : null),
        5_000,
        "snapshot frame applied"
      );
      assert.deepEqual(conversationTitles(session), ["after restart"]);
      assert.match(session.stores.connection.getState().lastViolation ?? "", /落后于本地游标/);
      assert.equal(session.connection.getSnapshot().violations, 0);
    } finally {
      session.connection.dispose();
      await host.close();
      await relay.stop();
    }
  });

  test("reconnect: the client resumes from the last applied seq instead of re-snapshotting", async () => {
    const relay = await startRelay();
    const { host, session } = await primed(relay, 10);
    try {
      host.sendEvent(11, "conversation.updated", conversationSummary({ title: "eleven", updatedAt: at(11) }));
      await waitFor(
        () => (session.connection.resume.state(host.hostId).lastSeq === 11 ? true : null),
        5_000,
        "event 11 applied"
      );

      session.connection.close("reconnect test");
      session.connection.connect("reconnect after close");
      await waitFor(
        () => (session.connection.getSnapshot().status === "online" ? true : null),
        10_000,
        "status online again"
      );

      const resume = await host.waitForResume(5_000);
      assert.equal(resume.resumeFrom, 11, "重连必须带上最后完整应用的 seq");
      assert.equal(resume.hostId, host.hostId);
      assert.equal(
        framesOfType(session.sent, "resume").length,
        1,
        "一次重连只发一个 resume"
      );
      assert.equal(
        host.requests().filter((request) => request.method === "sync.snapshot").length,
        1,
        "有游标时不得再次请求初始快照"
      );

      // The host continues above the resumed cursor.
      host.sendEvent(12, "conversation.updated", conversationSummary({ title: "twelve", updatedAt: at(12) }));
      await waitFor(
        () => (conversationTitles(session)[0] === "twelve" ? true : null),
        5_000,
        "event 12 applied after resume"
      );
      assert.equal(session.connection.resume.state(host.hostId).lastSeq, 12);
    } finally {
      session.connection.dispose();
      await host.close();
      await relay.stop();
    }
  });

  test("the real Relay never echoes the credential in what the client keeps", async () => {
    const relay = await startRelay();
    const { host, session } = await primed(relay, 10);
    try {
      host.sendEvent(11, "message.created", {
        messageId: "m1",
        conversationId: "c1",
        role: "user",
        content: "hello from the host",
        createdAt: at(11)
      });
      await waitFor(
        () => (session.connection.resume.state(host.hostId).lastSeq === 11 ? true : null),
        5_000,
        "message event applied"
      );
      assert.equal(session.stores.messages.thread("c1").items.length, 1);

      const diagnostics = JSON.stringify(session.stores.connection.getState().diagnostics);
      assert.ok(!diagnostics.includes(relay.adminToken), "诊断不得包含令牌");
      assert.ok(!relay.logs().includes(relay.adminToken), "Relay 日志不得出现 admin 令牌");
      assert.ok(!relay.logs().includes(relay.hostToken), "Relay 日志不得出现 host 令牌");
    } finally {
      session.connection.dispose();
      await host.close();
      await relay.stop();
    }
  });
});

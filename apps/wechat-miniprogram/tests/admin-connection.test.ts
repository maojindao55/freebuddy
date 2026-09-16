import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createHostTargetRegistry } from "../miniprogram/config/hostTarget";
import { createOperatorTokenSession } from "../miniprogram/services/adminSession";
import { createAdminConnection } from "../miniprogram/services/adminConnection";
import type { EventFrame, SnapshotFrame } from "../miniprogram/protocol/remote.generated";

import {
  ISOTIME,
  adminAuthOkFrame,
  createManualScheduler,
  createSocketHub,
  createTestIdFactory,
  eventFrame,
  framesOfMethod,
  requestErrorFrame,
  rpcFailureFrame,
  rpcResponseFrame,
  snapshotFrame,
  snapshotPayload,
  type SocketHub
} from "./helpers/fakeTransport";

const TOKEN = "local-dev-token";
const HOST_ID = "host-1";
const URL = "ws://127.0.0.1:8080/v1/ws/admin";

interface Harness {
  connection: ReturnType<typeof createAdminConnection>;
  hub: SocketHub;
  advance(ms: number): void;
}

function harness(): Harness {
  const hub = createSocketHub();
  const scheduler = createManualScheduler();
  const connection = createAdminConnection({
    adminSocketUrl: URL,
    clientVersion: "0.0.0",
    createSocket: (url) => hub.createSocket(url),
    scheduler,
    isoNow: () => ISOTIME,
    nextId: createTestIdFactory(),
    random: () => 0.5,
    tokenSession: createOperatorTokenSession(),
    hostTarget: createHostTargetRegistry()
  });
  return { connection, hub, advance: (ms) => scheduler.advance(ms) };
}

/**
 * Brings the socket online and, when a host is configured, answers the baseline `sync.snapshot`
 * W3 requests right after `auth.ok`. These W2 assertions count *their own* requests, so the
 * baseline must not stay pending.
 */
function goOnline(h: Harness): void {
  h.connection.connect("test");
  h.hub.last().fireOpen();
  h.hub.deliver(adminAuthOkFrame());
  const hostId = h.connection.getHostId();
  if (hostId === null) {
    return;
  }
  for (const frame of framesOfMethod(h.hub.last(), "sync.snapshot")) {
    h.hub.deliver(rpcResponseFrame(hostId, frame.id as string, snapshotPayload(hostId, 0)));
  }
}

describe("credential lifecycle", () => {
  test("connecting without an accepted credential opens nothing", () => {
    const h = harness();
    h.connection.connect("test");
    assert.equal(h.hub.tasks.length, 0);
    assert.equal(h.connection.getSnapshot().status, "signedOut");
  });

  test("an impossible token is refused and does not enable a connection", () => {
    const h = harness();
    assert.equal(h.connection.setToken("has space").accepted, false);
    h.connection.connect("test");
    assert.equal(h.hub.tasks.length, 0);
    assert.equal(h.connection.hasToken(), false);
  });

  test("sign-out drops the credential so a reconnect cannot reuse it", () => {
    const h = harness();
    assert.equal(h.connection.setToken(TOKEN).accepted, true);
    goOnline(h);
    assert.equal(h.connection.getSnapshot().status, "online");

    h.connection.signOut("operator signed out");
    assert.equal(h.connection.hasToken(), false);
    assert.equal(h.connection.getSnapshot().status, "signedOut");

    h.connection.connect("reconnect after sign-out");
    assert.equal(h.hub.tasks.length, 1, "no new socket without a credential");
    assert.equal(h.connection.getSnapshot().status, "signedOut");
  });
});

describe("host binding", () => {
  test("responses for another host are dropped before they can settle", async () => {
    const h = harness();
    h.connection.setToken(TOKEN);
    h.connection.setHostId(HOST_ID);
    goOnline(h);

    const pending = h.connection.reads.hostStatus();
    const requestId = JSON.parse(h.hub.last().sent.at(-1) as string).id as string;

    h.hub.deliver(rpcResponseFrame("host-2", requestId, { online: true }));
    assert.equal(h.connection.pendingCount(), 1, "another host's answer must not resolve our request");
    h.hub.deliver(rpcResponseFrame(HOST_ID, requestId, { online: true }));

    const result = await pending;
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : null, { online: true });
    assert.equal(h.connection.pendingCount(), 0);
  });

  test("read requests are refused while no host is configured", async () => {
    const h = harness();
    h.connection.setToken(TOKEN);
    goOnline(h);
    const result = await h.connection.reads.listConversations();
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "invalid_request");
    assert.match(result.ok === false ? result.error.message : "", /hostId/);
  });

  test("events from the configured host reach listeners, others do not", () => {
    const h = harness();
    h.connection.setToken(TOKEN);
    h.connection.setHostId(HOST_ID);
    goOnline(h);

    const seenEventHosts: string[] = [];
    const seenSnapshotHosts: string[] = [];
    h.connection.onEvent((frame: EventFrame) => seenEventHosts.push(frame.hostId));
    h.connection.onSnapshot((frame: SnapshotFrame) => seenSnapshotHosts.push(frame.hostId));

    h.hub.deliver(eventFrame("host-2", "host.status.changed", 1, {}));
    h.hub.deliver(snapshotFrame("host-2", 1));
    h.hub.deliver(eventFrame(HOST_ID, "host.status.changed", 2, {}));
    h.hub.deliver(snapshotFrame(HOST_ID, 2));

    assert.deepEqual(seenEventHosts, [HOST_ID]);
    assert.deepEqual(seenSnapshotHosts, [HOST_ID]);
    assert.equal(h.connection.getSnapshot().violations, 2);
  });
});

describe("disconnect cleanup", () => {
  test("a drop fails every pending read with an unknown outcome, immediately", async () => {
    const h = harness();
    h.connection.setToken(TOKEN);
    h.connection.setHostId(HOST_ID);
    goOnline(h);

    const first = h.connection.reads.hostStatus();
    const second = h.connection.reads.listProjects();
    assert.equal(h.connection.pendingCount(), 2);

    h.hub.last().fireClose(1006, "gone");
    assert.equal(h.connection.pendingCount(), 0, "nothing may wait for its own timeout after a drop");

    for (const settled of [await first, await second]) {
      assert.equal(settled.ok, false);
      assert.equal(settled.ok === false && settled.error.unknownOutcome, true);
      assert.equal(settled.ok === false && settled.error.retryable, true);
    }
  });

  test("a failed read keeps the server's error code", async () => {
    const h = harness();
    h.connection.setToken(TOKEN);
    h.connection.setHostId(HOST_ID);
    goOnline(h);

    const pending = h.connection.reads.hostStatus();
    const requestId = JSON.parse(h.hub.last().sent.at(-1) as string).id as string;
    h.hub.deliver(rpcFailureFrame(HOST_ID, requestId, "host_offline"));

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "host_offline");
  });

  test("a Relay error frame for a pending read reaches the caller as host_offline", async () => {
    const h = harness();
    h.connection.setToken(TOKEN);
    h.connection.setHostId(HOST_ID);
    goOnline(h);

    const pending = h.connection.reads.hostStatus();
    const requestId = JSON.parse(h.hub.last().sent.at(-1) as string).id as string;
    h.hub.deliver(requestErrorFrame(requestId, "host_offline", HOST_ID));

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "host_offline");
    assert.equal(h.connection.pendingCount(), 0);
    assert.equal(h.connection.getSnapshot().status, "online", "host_offline 不是连接级错误");
  });

  test("a Relay error frame for another host never settles a pending read", async () => {
    const h = harness();
    h.connection.setToken(TOKEN);
    h.connection.setHostId(HOST_ID);
    goOnline(h);

    const pending = h.connection.reads.hostStatus();
    const requestId = JSON.parse(h.hub.last().sent.at(-1) as string).id as string;
    h.hub.deliver(requestErrorFrame(requestId, "host_offline", "host-2"));

    h.advance(15_000);
    const result = await pending;
    assert.equal(result.ok === false && result.error.code, "rpc_timeout");
    assert.equal(h.connection.pendingCount(), 0);
  });

  test("background no longer proves liveness, foreground resumes it", () => {
    const h = harness();
    h.connection.setToken(TOKEN);
    h.connection.setHostId(HOST_ID);
    goOnline(h);

    h.connection.notifyBackground();
    const sentBeforeBackground = h.hub.last().sent.length;
    h.advance(60_000);
    assert.equal(h.hub.last().sent.length, sentBeforeBackground, "no heartbeat while suspended");

    h.connection.notifyForeground();
    const ping = JSON.parse(h.hub.last().sent.at(-1) as string);
    assert.equal(ping.type, "ping");
  });
});

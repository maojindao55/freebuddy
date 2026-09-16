/**
 * W2 real-Relay integration tests.
 *
 * Every unit test in this directory drives `RelaySocket`/`RpcClient` through a fake transport;
 * those prove intent. These tests prove interoperability with the authoritative implementation:
 * they build `services/remote-relay` into a temporary binary, run it on a random loopback port
 * with a temporary SQLite file and crypto-random DEV tokens, and connect the *production*
 * `adminConnection` through a real WebSocket (only the `WechatApi.connectSocket` seam is
 * swapped, exactly as it is swapped for `wx.connectSocket` on device).
 *
 * Not covered here because it is a later stage: resume/snapshot/seq (W3), pairing (W4) and write
 * RPC (W5). No protocol field and no Go behaviour is modified by this file.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, describe, test } from "node:test";

import { createHostTargetRegistry } from "../miniprogram/config/hostTarget";
import { createAdminConnection, type AdminConnection } from "../miniprogram/services/adminConnection";
import { createOperatorTokenSession } from "../miniprogram/services/adminSession";
import type { InboundViolation } from "../miniprogram/protocol/frameRules";
import type { AuthOkFrame, HostStatus } from "../miniprogram/protocol/remote.generated";
import { createDefaultScheduler, nextIdFactory } from "../miniprogram/utils/scheduler";

import { connectFakeHost, type FakeRelayHost } from "./helpers/fakeRelayHost";
import {
  cleanupRelayBuild,
  randomOpaqueToken,
  startRelay,
  type RelayInstance
} from "./helpers/relayProcess";
import { createRealSocketTask } from "./helpers/realSocket";
import { delay, waitFor } from "./helpers/wait";
import { snapshotPayload } from "./helpers/fakeTransport";

interface Session {
  readonly relay: RelayInstance;
  readonly connection: AdminConnection;
  /** Raw frames this client put on the wire, in order. */
  readonly sent: string[];
  /** Raw frames the real Relay delivered, in order. */
  readonly received: string[];
  readonly authOkFrames: AuthOkFrame[];
  readonly violations: InboundViolation[];
  socketCount(): number;
}

function framesOfType(list: readonly string[], type: string): Record<string, unknown>[] {
  return list
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

function openSession(relay: RelayInstance): Session {
  const sent: string[] = [];
  const received: string[] = [];
  const authOkFrames: AuthOkFrame[] = [];
  const violations: InboundViolation[] = [];
  let sockets = 0;

  const connection = createAdminConnection({
    adminSocketUrl: relay.adminSocketUrl,
    clientVersion: "0.0.0-w2-integration",
    // The only substitution in these tests: `wx.connectSocket` → a real WebSocket. Both produce
    // a `SocketTaskLike`; the transport above this seam is untouched.
    createSocket: (url) => {
      sockets += 1;
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
          task.onMessage((event) => {
            if (typeof event.data === "string") {
              received.push(event.data);
            }
            listener(event);
          });
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
    handlers: {
      onAuthOk(frame) {
        authOkFrames.push(frame);
      },
      onViolation(violation) {
        violations.push(violation);
      }
    }
  });

  return {
    relay,
    connection,
    sent,
    received,
    authOkFrames,
    violations,
    socketCount: () => sockets
  };
}

async function goOnline(session: Session, token: string): Promise<void> {
  assert.equal(session.connection.setToken(token).accepted, true);
  session.connection.connect("w2 real relay");
  try {
    await waitFor(
      () => (session.connection.getSnapshot().status === "online" ? true : null),
      10_000,
      "status online"
    );
  } catch (error) {
    const snapshot = session.connection.getSnapshot();
    throw new Error(
      `${(error as Error).message}; last status=${snapshot.status} ` +
        `reason=${snapshot.reasonMessage} violations=${snapshot.violations} ` +
        `relay=${session.relay.logs().slice(-800)}`
    );
  }
}

/**
 * W3: selecting a host also establishes the event baseline, so a `sync.snapshot` is in flight
 * right after `auth.ok`. Answering it keeps these W2 assertions about *their own* requests.
 */
async function answerBaselineSnapshot(session: Session, host: FakeRelayHost, baseSeq = 1): Promise<void> {
  const arrived = await host.waitForRequests("sync.snapshot", 1, 5_000);
  host.respondOk(arrived[0].requestId, snapshotPayload(host.hostId, baseSeq));
  await waitFor(
    () => (session.connection.resume.state(host.hostId).materialized ? true : null),
    5_000,
    "baseline snapshot applied"
  );
}

function hostStatus(hostId: string, label: string): HostStatus {
  return {
    hostId,
    displayName: label,
    online: true,
    appVersion: "0.9.10",
    protocolVersion: 1,
    remoteEnabled: true,
    activeRunCount: 0,
    pendingDecisionCount: 0,
    activeTerminalCount: 0,
    serverTime: new Date().toISOString()
  };
}

describe("W2 against a real Go Relay", () => {
  after(() => {
    cleanupRelayBuild();
  });

  test("authentication: auth.ok carries role=admin and no admin hostId", async () => {
    const relay = await startRelay();
    const session = openSession(relay);
    try {
      await goOnline(session, relay.adminToken);

      const snapshot = session.connection.getSnapshot();
      assert.equal(snapshot.status, "online");
      assert.match(snapshot.connectionId ?? "", /^conn_[0-9a-f]{32}$/);
      assert.equal(snapshot.limits?.maxFrameBytes, 262_144);
      assert.equal(snapshot.limits?.maxChunkBytes, 32_768);
      assert.equal(snapshot.violations, 0);
      assert.deepEqual(session.violations, []);

      const frame = session.authOkFrames.at(-1);
      assert.ok(frame, "auth.ok 必须到达客户端");
      assert.equal(frame.payload.role, "admin");
      assert.equal(
        Object.prototype.hasOwnProperty.call(frame.payload, "hostId"),
        false,
        "真实 Relay 的 admin auth.ok 不带 hostId：admin 不由 hostId 标识，客户端不得要求该字段"
      );
      assert.equal(session.connection.getHostId(), null, "未配置主机时不得凭 auth.ok 推断 hostId");

      const auth = framesOfType(session.sent, "admin.auth")[0];
      assert.equal(auth.type, "admin.auth");
      assert.deepEqual(Object.keys(auth.payload as Record<string, unknown>).sort(), [
        "accessToken",
        "clientVersion",
        "protocolVersion"
      ]);
    } finally {
      session.connection.dispose();
      await relay.stop();
    }
  });

  test("heartbeat: the Relay echoes the ping nonce verbatim", async () => {
    const relay = await startRelay();
    const session = openSession(relay);
    try {
      await goOnline(session, relay.adminToken);
      // Foreground proves liveness immediately instead of waiting for the 5s interval.
      session.connection.notifyForeground();

      await waitFor(
        () => (framesOfType(session.received, "pong").length > 0 ? true : null),
        5_000,
        "pong from the relay"
      );

      const ping = framesOfType(session.sent, "ping").at(-1);
      const pong = framesOfType(session.received, "pong").at(-1);
      assert.ok(ping && pong);
      const pingNonce = (ping.payload as { nonce?: string }).nonce;
      const pongPayload = pong.payload as { nonce?: string; serverTime?: string };
      assert.ok(pingNonce, "客户端心跳必须带 nonce");
      assert.equal(pongPayload.nonce, pingNonce, "pong 必须原样回声 nonce");
      assert.match(pongPayload.serverTime ?? "", /Z$/);

      assert.equal(session.connection.getSnapshot().heartbeatMissed, 0);
      assert.equal(session.connection.getSnapshot().status, "online");
    } finally {
      session.connection.dispose();
      await relay.stop();
    }
  });

  test("read RPC: responses correlate by requestId and hostId through the real Relay", async () => {
    const relay = await startRelay();
    const host: FakeRelayHost = await connectFakeHost({
      hostSocketUrl: relay.hostSocketUrl,
      hostToken: relay.hostToken,
      hostId: relay.hostId
    });
    const session = openSession(relay);
    try {
      assert.equal(host.authOk?.role, "host");
      assert.equal(host.authOk?.hostId, relay.hostId);

      await goOnline(session, relay.adminToken);
      assert.deepEqual(session.connection.setHostId(relay.hostId), {
        hostId: relay.hostId,
        source: "explicit"
      });

      const first = session.connection.reads.hostStatus();
      const second = session.connection.reads.hostStatus();
      const hostStatusRequests = await host.waitForRequests("host.status", 2, 5_000);
      assert.equal(hostStatusRequests.length, 2);
      await answerBaselineSnapshot(session, host);

      const wire = framesOfType(session.sent, "rpc.request").filter(
        (frame) => (frame.payload as { method?: string }).method === "host.status"
      );
      assert.equal(wire.length, 2);
      const firstWire = wire[0];
      assert.equal(firstWire.hostId, relay.hostId);
      assert.equal((firstWire.payload as { method?: string }).method, "host.status");
      assert.equal(typeof firstWire.expiresAt, "string");
      assert.equal(firstWire.id, hostStatusRequests[0].requestId);

      // Answer out of order: correlation must follow requestId, not arrival order.
      host.respondOk(hostStatusRequests[1].requestId, hostStatus(relay.hostId, "W2-second"));
      host.respondOk(hostStatusRequests[0].requestId, hostStatus(relay.hostId, "W2-first"));

      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(firstResult.ok ? firstResult.value.displayName : null, "W2-first");
      assert.equal(secondResult.ok ? secondResult.value.hostId : null, relay.hostId);
      assert.equal(secondResult.ok ? secondResult.value.displayName : null, "W2-second");
      assert.equal(session.connection.pendingCount(), 0);
      assert.equal(session.connection.getSnapshot().violations, 0);
      assert.equal(session.connection.getSnapshot().status, "online");
    } finally {
      session.connection.dispose();
      await host.close();
      await relay.stop();
    }
  });

  test("host_offline: an unreachable host surfaces the Relay's error code", async () => {
    const relay = await startRelay();
    const session = openSession(relay);
    try {
      await goOnline(session, relay.adminToken);
      session.connection.setHostId(relay.hostId);

      const result = await session.connection.reads.hostStatus();
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error.code, "host_offline");
      assert.equal(session.connection.pendingCount(), 0);
    } finally {
      session.connection.dispose();
      await relay.stop();
    }
  });

  test("invalid token: forbidden, no automatic retry, and no token in the logs", async () => {
    const relay = await startRelay();
    const session = openSession(relay);
    const wrongToken = randomOpaqueToken();
    try {
      assert.equal(session.connection.setToken(wrongToken).accepted, true);
      session.connection.connect("wrong credential");

      await waitFor(
        () => (session.connection.getSnapshot().status === "forbidden" ? true : null),
        10_000,
        "status forbidden"
      );

      const snapshot = session.connection.getSnapshot();
      assert.equal(snapshot.reasonCode, "unauthorized");
      assert.equal(snapshot.nextRetryInMs, null, "认证失败不得安排自动重连");
      assert.equal(session.socketCount(), 1);

      // Backoff base is 800ms: two attempts would have happened by now if retry were armed.
      await delay(1_600);
      assert.equal(session.connection.getSnapshot().status, "forbidden");
      assert.equal(session.socketCount(), 1, "认证失败后不得再自动重连");

      session.connection.connect("retry without a new credential");
      assert.equal(session.socketCount(), 1, "forbidden 状态下显式重连也不得建连");

      assert.ok(!snapshot.reasonMessage.includes(wrongToken), "状态文案不得回显令牌");
      for (const violation of session.violations) {
        assert.ok(!violation.detail.includes(wrongToken), "诊断信息不得回显令牌");
      }
      assert.ok(!relay.logs().includes(wrongToken), "Relay 日志不得出现令牌原文");
      assert.ok(!relay.logs().includes(relay.adminToken));
      assert.ok(!relay.logs().includes(relay.hostToken));
    } finally {
      session.connection.dispose();
      await relay.stop();
    }
  });

  test("a dropped connection fails pending reads with an unknown outcome at once", async () => {
    const relay = await startRelay();
    const host = await connectFakeHost({
      hostSocketUrl: relay.hostSocketUrl,
      hostToken: relay.hostToken,
      hostId: relay.hostId
    });
    const session = openSession(relay);
    try {
      await goOnline(session, relay.adminToken);
      session.connection.setHostId(relay.hostId);

      const pending = session.connection.reads.hostStatus();
      // Wait until the request provably reached the host: from here the outcome is unknown.
      await host.waitForRequests("host.status", 1, 5_000);
      await answerBaselineSnapshot(session, host);
      assert.equal(session.connection.pendingCount(), 1);

      await relay.kill();

      await waitFor(
        () => (session.connection.pendingCount() === 0 ? true : null),
        5_000,
        "pending cleared on drop"
      );
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error.unknownOutcome, true);
      assert.equal(result.ok === false && result.error.retryable, true);

      const status = session.connection.getSnapshot().status;
      assert.ok(
        status === "backoff" || status === "offline",
        `expected backoff/offline after a relay crash, got ${status}`
      );
    } finally {
      session.connection.dispose();
      await host.close();
      await relay.stop();
    }
  });

  test("sign-out clears the credential; the temporary Relay leaves nothing behind", async () => {
    const relay = await startRelay();
    const session = openSession(relay);
    const tempDir = relay.tempDir;
    try {
      await goOnline(session, relay.adminToken);
      assert.equal(session.connection.hasToken(), true);

      session.connection.signOut("operator signed out");
      assert.equal(session.connection.hasToken(), false);
      assert.equal(session.connection.getSnapshot().status, "signedOut");

      session.connection.connect("reconnect after sign-out");
      assert.equal(session.socketCount(), 1, "signOut 之后没有凭证不得再建连");
      assert.equal(session.connection.getSnapshot().status, "signedOut");

      await waitFor(() => (relay.isRunning() ? true : null), 1_000, "relay still running").catch(
        () => undefined
      );
      await relay.stop();

      assert.equal(relay.isRunning(), false, "临时 Relay 进程必须退出");
      assert.equal(existsSync(tempDir), false, "临时 SQLite 目录必须被清理");
      assert.ok(!relay.logs().includes(relay.adminToken), "Relay 日志不得出现 admin 令牌");
      assert.ok(!relay.logs().includes(relay.hostToken), "Relay 日志不得出现 host 令牌");
    } finally {
      session.connection.dispose();
      await relay.stop();
    }
  });
});

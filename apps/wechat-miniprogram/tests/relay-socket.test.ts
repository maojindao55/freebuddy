import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createRelaySocket,
  type RelaySocketHandlers,
  type RelaySocketOptions
} from "../miniprogram/services/relaySocket";
import type { InboundViolation } from "../miniprogram/protocol/frameRules";
import type { AuthOkFrame, ErrorFrame, RpcResponseFrame } from "../miniprogram/protocol/remote.generated";

import {
  ISOTIME,
  adminAuthOkFrame,
  challengeFrame,
  createManualScheduler,
  createSocketHub,
  createTestIdFactory,
  errorFrame,
  eventFrame,
  pingFrame,
  pongFrame,
  rpcResponseFrame,
  serverDrainingFrame,
  snapshotFrame,
  type ManualScheduler,
  type SocketHub
} from "./helpers/fakeTransport";

interface Harness {
  socket: ReturnType<typeof createRelaySocket>;
  hub: SocketHub;
  scheduler: ManualScheduler;
  violations: InboundViolation[];
  disconnectCount(): number;
  terminalErrors: ErrorFrame[];
  authOk: AuthOkFrame[];
  rpc: RpcResponseFrame[];
  setToken(next: string | null): void;
}

const TOKEN = "dev-operator-token";
const URL = "ws://127.0.0.1:8080/v1/ws/admin";

function harness(overrides: Partial<RelaySocketOptions> = {}): Harness {
  const hub = createSocketHub();
  const scheduler = createManualScheduler();
  const violations: InboundViolation[] = [];
  const disconnects = { count: 0 };
  const terminalErrors: ErrorFrame[] = [];
  const authOk: AuthOkFrame[] = [];
  const rpc: RpcResponseFrame[] = [];
  const randomValues = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  let token: string | null = TOKEN;

  const handlers: RelaySocketHandlers = {
    onViolation: (violation) => violations.push(violation),
    onDisconnected: () => {
      disconnects.count += 1;
    },
    onTerminalError: (frame) => terminalErrors.push(frame),
    onAuthOk: (frame) => authOk.push(frame),
    onRpcResponse: (frame) => rpc.push(frame)
  };

  const socket = createRelaySocket({
    adminSocketUrl: URL,
    clientVersion: "0.0.0",
    getAccessToken: () => token,
    createSocket: (url) => hub.createSocket(url),
    scheduler,
    isoNow: () => ISOTIME,
    nextId: createTestIdFactory(),
    random: () => randomValues.shift() ?? 0.5,
    handlers,
    heartbeatTimeoutMs: 4_000,
    ...overrides
  });

  return {
    socket,
    hub,
    scheduler,
    violations,
    disconnectCount: () => disconnects.count,
    terminalErrors,
    authOk,
    rpc,
    setToken(next) {
      token = next;
    }
  };
}

/** Drives `connecting → authenticating → online` the way the relay does. */
function goOnline(h: Harness, authOkOverrides: Record<string, unknown> = {}): void {
  h.socket.connect("test");
  h.hub.last().fireOpen();
  h.hub.deliver(adminAuthOkFrame(authOkOverrides));
}

describe("handshake", () => {
  test("connecting without a credential never opens a socket", () => {
    const h = harness();
    h.setToken(null);
    h.socket.connect("test");
    assert.equal(h.hub.tasks.length, 0);
    assert.equal(h.socket.getSnapshot().status, "signedOut");
    assert.match(h.socket.getSnapshot().reasonMessage, /缺少管理员凭证/);
  });

  test("the socket connects exactly once and authenticates with the real admin.auth frame", () => {
    const h = harness();
    h.socket.connect("test");
    h.socket.connect("again while connecting");
    assert.equal(h.hub.tasks.length, 1);
    assert.equal(h.socket.getSnapshot().status, "connecting");

    h.hub.last().fireOpen();
    assert.equal(h.socket.getSnapshot().status, "authenticating");

    const sent = JSON.parse(h.hub.last().sent[0]);
    assert.equal(sent.type, "admin.auth");
    assert.equal(sent.payload.protocolVersion, 1);
    assert.equal(sent.payload.accessToken, TOKEN);
    assert.deepEqual(Object.keys(sent.payload).sort(), ["accessToken", "clientVersion", "protocolVersion"]);

    h.hub.deliver(adminAuthOkFrame());
    const snapshot = h.socket.getSnapshot();
    assert.equal(snapshot.status, "online");
    assert.equal(snapshot.connectionId, "conn-1");
    assert.equal(snapshot.limits?.heartbeatIntervalMs, 10_000);
    assert.equal(h.authOk.length, 1);
  });

  test("a token never survives into connection state or diagnostics", () => {
    const h = harness();
    goOnline(h);
    assert.doesNotMatch(JSON.stringify(h.socket.getSnapshot()), new RegExp(TOKEN));
    h.hub.deliver(challengeFrame());
    assert.equal(h.violations.at(-1)?.code, "frame_direction");
    assert.doesNotMatch(JSON.stringify(h.violations), new RegExp(TOKEN));
  });

  test("auth.ok for a host role is refused and stops the transport", () => {
    const h = harness();
    goOnline(h, { role: "host", hostId: "host-1" });
    const snapshot = h.socket.getSnapshot();
    assert.equal(snapshot.status, "forbidden");
    assert.match(snapshot.reasonMessage, /不是 admin/);
    assert.equal(h.terminalErrors.length, 0);
    assert.equal(h.violations.at(-1)?.frameType, "auth.ok");
    assert.equal(h.hub.last().closedCode, 1000);
  });

  test("auth.ok bound to another host is refused", () => {
    const h = harness();
    h.socket.setExpectedHostId("host-1");
    goOnline(h, { hostId: "host-2" });
    assert.equal(h.socket.getSnapshot().status, "forbidden");
    assert.match(h.socket.getSnapshot().reasonMessage, /hostId 与已配置主机不一致/);
  });

  test("authentication uses its own timeout", () => {
    const h = harness({ authTimeoutMs: 1_000 });
    h.socket.connect("test");
    h.hub.last().fireOpen();
    h.scheduler.advance(1_000);
    assert.equal(h.socket.getSnapshot().status, "backoff");
    assert.match(h.socket.getSnapshot().reasonMessage, /认证超时/);
    assert.equal(h.scheduler.pendingCount(), 1, "exactly one reconnect timer");
  });
});

describe("heartbeat", () => {
  test("a matching pong proves liveness and keeps exactly one timer armed", () => {
    const h = harness();
    goOnline(h);
    assert.equal(h.scheduler.pendingCount(), 1);

    h.scheduler.advance(10_000);
    const ping = JSON.parse(h.hub.last().sent.at(-1) as string);
    assert.equal(ping.type, "ping");
    assert.ok(typeof ping.payload.nonce === "string");
    assert.equal(h.scheduler.pendingCount(), 2, "miss deadline + next tick");

    h.hub.deliver(pongFrame(ping.payload.nonce));
    assert.equal(h.scheduler.pendingCount(), 1);
    assert.equal(h.socket.getSnapshot().status, "online");
  });

  test("unsolicited or mismatched pongs do not keep a dead connection alive", () => {
    const h = harness();
    goOnline(h);
    h.scheduler.advance(10_000);

    h.hub.deliver(pongFrame("wrong-nonce"));
    h.hub.deliver(pongFrame());
    assert.equal(h.scheduler.pendingCount(), 2, "deadline not cleared");

    h.scheduler.advance(4_000);
    assert.equal(h.socket.getSnapshot().status, "backoff");
    assert.match(h.socket.getSnapshot().reasonMessage, /心跳超时/);
    assert.equal(h.socket.getSnapshot().heartbeatMissed, 1);
  });

  test("background suspends heartbeats and foreground resumes without stacking timers", () => {
    const h = harness();
    goOnline(h);

    h.socket.notifyBackground();
    assert.equal(h.scheduler.pendingCount(), 0);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      h.socket.notifyForeground();
      assert.equal(h.scheduler.pendingCount(), 2, "one probe deadline and one scheduled tick");
      h.socket.notifyBackground();
      assert.equal(h.scheduler.pendingCount(), 0);
    }
  });

  test("server pings are answered with a pong", () => {
    const h = harness();
    goOnline(h);
    h.hub.deliver(pingFrame("n1"));
    const sent = JSON.parse(h.hub.last().sent.at(-1) as string);
    assert.equal(sent.type, "pong");
    assert.equal(sent.payload.nonce, "n1");
  });
});

describe("reconnect", () => {
  test("attempts back off with jitter behind a single timer", () => {
    const h = harness();
    goOnline(h);
    h.hub.last().fireClose(1006, "gone");

    const first = h.socket.getSnapshot();
    assert.equal(first.status, "backoff");
    assert.equal(first.nextRetryInMs, 600, "800ms base with 0.75 jitter");
    assert.equal(h.scheduler.pendingCount(), 1);

    h.scheduler.advance(600);
    assert.equal(h.socket.getSnapshot().status, "connecting");
    assert.equal(h.hub.tasks.length, 2, "the stale socket is never reused");

    h.hub.last().fireClose(1006, "gone again");
    assert.equal(h.socket.getSnapshot().nextRetryInMs, 1_200);
    assert.equal(h.scheduler.pendingCount(), 1);
  });

  test("attempts are capped, then the socket rests in offline", () => {
    const h = harness({ maxAutoAttempts: 2 });
    goOnline(h);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      h.hub.last().fireClose(1006, "gone");
      h.scheduler.advance(60_000);
    }
    assert.equal(h.socket.getSnapshot().status, "offline");
    assert.match(h.socket.getSnapshot().reasonMessage, /自动重连次数已用尽/);
    assert.equal(h.scheduler.pendingCount(), 0);
  });

  test("a background app defers reconnecting until the foreground returns", () => {
    const h = harness();
    goOnline(h);
    h.socket.notifyBackground();
    h.hub.last().fireClose(1006, "gone");
    assert.equal(h.socket.getSnapshot().status, "offline");
    assert.equal(h.scheduler.pendingCount(), 0);

    h.socket.notifyForeground();
    assert.equal(h.socket.getSnapshot().status, "connecting");
  });

  test("server.draining schedules one reconnect after the announced delay", () => {
    const h = harness();
    goOnline(h);
    h.hub.deliver(serverDrainingFrame(1_500));
    assert.equal(h.socket.getSnapshot().status, "backoff");
    assert.equal(h.socket.getSnapshot().nextRetryInMs, 1_500);
    assert.equal(h.scheduler.pendingCount(), 1);

    h.scheduler.advance(1_500);
    assert.equal(h.socket.getSnapshot().status, "connecting");
    assert.equal(h.hub.tasks.length, 2);
  });

  test("network loss closes the transport; network recovery reconnects once", () => {
    const h = harness();
    goOnline(h);
    h.socket.notifyNetworkChange(false);
    assert.match(h.socket.getSnapshot().reasonMessage, /网络不可用/);

    h.socket.notifyNetworkChange(true);
    assert.equal(h.socket.getSnapshot().status, "connecting");
    h.socket.notifyNetworkChange(true);
    assert.equal(h.hub.tasks.length, 2, "duplicate network events do not open a second socket");
  });
});

describe("terminal errors", () => {
  test("unauthorized stops automatic retry and only a new attempt leaves forbidden", () => {
    const h = harness();
    h.socket.connect("test");
    h.hub.last().fireOpen();
    h.hub.deliver(errorFrame("unauthorized"));

    const snapshot = h.socket.getSnapshot();
    assert.equal(snapshot.status, "forbidden");
    assert.equal(snapshot.reasonCode, "unauthorized");
    assert.equal(h.terminalErrors.length, 1);
    assert.equal(h.scheduler.pendingCount(), 0, "no automatic reconnect after an auth failure");

    // A stale callback from the discarded socket must not resurrect anything.
    h.hub.last().fireClose(1006, "gone");
    assert.equal(h.socket.getSnapshot().status, "forbidden");
    assert.equal(h.socket.getSnapshot().reasonMessage.includes("forbidden") === false, true);
  });

  test("repeated forbidden events never schedule a retry storm", () => {
    const h = harness();
    h.socket.connect("test");
    h.hub.last().fireOpen();
    h.hub.deliver(errorFrame("forbidden"));
    h.socket.connect("with the same credential");
    assert.equal(h.socket.getSnapshot().status, "forbidden");
    assert.equal(h.scheduler.pendingCount(), 0);
    assert.equal(h.hub.tasks.length, 1);
  });

  test("unsupported_version rests in incompatible", () => {
    const h = harness();
    h.socket.connect("test");
    h.hub.last().fireOpen();
    h.hub.deliver(errorFrame("unsupported_version"));
    assert.equal(h.socket.getSnapshot().status, "incompatible");
    assert.equal(h.scheduler.pendingCount(), 0);
  });

  test("other error codes keep the current status and are surfaced once", () => {
    const h = harness();
    goOnline(h);
    h.hub.deliver(errorFrame("host_offline"));
    assert.equal(h.socket.getSnapshot().status, "online");
    assert.equal(h.socket.getSnapshot().reasonCode, "host_offline");
    assert.equal(h.scheduler.pendingCount(), 1, "heartbeat keeps running");
  });
});

describe("inbound hygiene", () => {
  test("frames from another host are counted and dropped, never delivered", () => {
    const h = harness();
    h.socket.setExpectedHostId("host-1");
    goOnline(h);

    h.hub.deliver(eventFrame("host-2", "host.status.changed", 1, {}));
    h.hub.deliver(snapshotFrame("host-2", 1));
    h.hub.deliver(rpcResponseFrame("host-2", "req1", {}));
    assert.equal(h.violations.filter((v) => v.code === "frame_identity").length, 3);
    assert.equal(h.rpc.length, 0);
    assert.equal(h.socket.getSnapshot().violations, 3);
  });

  test("an event for the configured host reaches the handler", () => {
    const h = harness();
    h.socket.setExpectedHostId("host-1");
    goOnline(h);
    h.hub.deliver(eventFrame("host-1", "host.status.changed", 1, {}));
    assert.equal(h.violations.length, 0);
  });

  test("nothing can be sent while the transport is down", () => {
    const h = harness();
    h.socket.setExpectedHostId("host-1");
    h.socket.connect("test");
    const before = h.socket.getSnapshot().droppedFrames;
    const accepted = h.socket.send({
      v: 1,
      id: "req1",
      type: "rpc.request",
      sentAt: ISOTIME,
      hostId: "host-1",
      payload: { method: "host.status", params: {} }
    });
    assert.equal(accepted, false);
    assert.equal(h.socket.getSnapshot().droppedFrames, before + 1);
  });

  test("close clears every connection-scoped value and reports the disconnect", () => {
    const h = harness();
    goOnline(h);
    h.socket.close("sign-out");
    const snapshot = h.socket.getSnapshot();
    assert.equal(snapshot.status, "signedOut");
    assert.equal(snapshot.connectionId, null);
    assert.equal(snapshot.limits, null);
    assert.equal(snapshot.nextRetryInMs, null);
    assert.equal(h.disconnectCount(), 1);
    assert.equal(h.scheduler.pendingCount(), 0);
  });
});

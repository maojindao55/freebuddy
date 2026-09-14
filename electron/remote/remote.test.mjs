import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import test from "node:test";

import {
  RemoteCredentialsUnavailableError,
  RelayClient,
  HostStatusPublisher,
  buildHostStatusChangedFrame,
  calculateReconnectDelay,
  signHostChallenge,
  validateRelayEndpoint
} from "../../dist-electron/remote/index.js";

class MemoryStorage {
  constructor(available = true) { this.available = available; }
  isEncryptionAvailable() { return this.available; }
  encryptString(value) { return Buffer.from(value); }
  decryptString(value) { return value.toString(); }
}

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit("close", 1000, Buffer.from("closed")); }
}

test("credentials fail closed and sign the protocol golden canonical payload", () => {
  const keys = JSON.parse(fs.readFileSync("protocol/remote/v1/fixtures/signing/keys.json", "utf8"));
  const signature = JSON.parse(fs.readFileSync("protocol/remote/v1/fixtures/signing/valid-signature.json", "utf8"));
  const canonical = JSON.parse(fs.readFileSync("protocol/remote/v1/fixtures/signing/canonical.json", "utf8"));
  const privateKeyPkcs8 = keys.privateKeyPkcs8DerBase64;
  const record = {
    hostId: canonical.hostId,
    keyId: "key_fixture_001",
    publicKey: keys.publicKeyRawBase64url,
    encryptedPrivateKey: Buffer.from(privateKeyPkcs8).toString("base64")
  };
  assert.throws(() => signHostChallenge(new MemoryStorage(false), record, canonical), RemoteCredentialsUnavailableError);
  const frame = signHostChallenge(new MemoryStorage(), record, canonical, Date.parse(canonical.issuedAt));
  assert.equal(frame.payload.signature, signature.signatureBase64url);
  assert.equal(frame.hostId, canonical.hostId);
});

test("relay client permits only explicit literal-loopback ws development endpoints", () => {
  assert.equal(validateRelayEndpoint("wss://relay.example/v1/ws/host").protocol, "wss:");
  assert.equal(validateRelayEndpoint("ws://127.0.0.1:8080/v1/ws/host", true).hostname, "127.0.0.1");
  assert.throws(() => validateRelayEndpoint("ws://localhost:8080/v1/ws/host", true));
  assert.throws(() => validateRelayEndpoint("ws://relay.example/v1/ws/host", true));
  assert.throws(() => validateRelayEndpoint("wss://relay.example/v1/ws/host", true));
  assert.throws(() => validateRelayEndpoint("wss://token@relay.example/v1/ws/host"));
});

test("development credentials fail closed before a remote wss socket can receive them", () => {
  let factoryCalls = 0;
  let factoryOptions;
  const client = new RelayClient({
    endpoint: "wss://relay.example/v1/ws/host",
    enabled: true,
    trustedHostId: "host_1",
    trustedHostId: "host_1",
    development: { enabled: true, hostToken: "dev-token-must-not-leave-host", hostId: "host_dev" },
    webSocketFactory: (_url, options) => {
      factoryCalls += 1;
      factoryOptions = options;
      return new FakeSocket();
    }
  });
  client.start();
  assert.equal(factoryCalls, 0);
  assert.equal(factoryOptions, undefined);
  assert.equal(client.getStatus().state, "auth_failed");
});

test("backoff uses bounded full-jitter intervals", () => {
  assert.equal(calculateReconnectDelay(1, () => 0), 500);
  assert.equal(calculateReconnectDelay(1, () => 1), 1000);
  assert.equal(calculateReconnectDelay(99, () => 0), 30000);
  assert.equal(calculateReconnectDelay(99, () => 1), 60000);
});

test("relay client transitions online, fails authentication without fast retry, and clears on stop", () => {
  const statuses = [];
  const sockets = [];
  const client = new RelayClient({
    endpoint: "ws://127.0.0.1:8080/v1/ws/host",
    enabled: true,
    development: { enabled: true, hostToken: "dev-token-not-logged", hostId: "host_dev" },
    onStatus: status => statuses.push(status.state),
    webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }
  });
  client.start();
  sockets[0].emit("open");
  sockets[0].emit("message", Buffer.from(JSON.stringify({ v: 1, type: "auth.ok", id: "msg_ok", sentAt: "2026-09-01T10:00:00.000Z", payload: { connectionId: "conn_1", role: "host", hostId: "host_dev", serverTime: "2026-09-01T10:00:00.000Z", limits: { maxFrameBytes: 262144, maxChunkBytes: 32768, maxConcurrentRpcs: 8, rpcReadTimeoutMs: 15000, rpcWriteTimeoutMs: 30000, heartbeatIntervalMs: 30000, challengeTtlMs: 60000 } } })));
  assert.equal(client.getStatus().state, "online");
  sockets[0].emit("message", Buffer.from(JSON.stringify({ v: 1, type: "error", id: "msg_error", sentAt: "2026-09-01T10:00:00.000Z", payload: { code: "unauthorized", message: "bad token", retryable: false } })));
  assert.equal(client.getStatus().state, "auth_failed");
  client.stop();
  assert.deepEqual(statuses.slice(-2), ["auth_failed", "stopped"]);
});

test("a production challenge is answered only through the credential callback", () => {
  const socket = new FakeSocket();
  const client = new RelayClient({
    endpoint: "wss://relay.example/v1/ws/host",
    enabled: true,
    trustedHostId: "host_1",
    webSocketFactory: () => socket,
    onChallenge: challenge => ({ v: 1, type: "host.auth", id: "msg_auth", hostId: "host_1", sentAt: challenge.issuedAt, payload: { hostId: "host_1", keyId: "key_1", publicKey: "a", signature: "b", clientVersion: "0.9.10", protocolVersion: 1 } })
  });
  client.start();
  socket.emit("open");
  socket.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "challenge", id: "msg_challenge", sentAt: "2026-09-01T10:00:00.000Z", payload: { connectionId: "conn_1", challenge: "a".repeat(43), issuedAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-09-01T10:01:00.000Z" } })));
  assert.equal(socket.sent[0].type, "host.auth");
  client.stop();
});

test("unexpected disconnect enters backoff and stop clears the retry path", () => {
  const statuses = [];
  const socket = new FakeSocket();
  const client = new RelayClient({
    endpoint: "ws://127.0.0.1:8080/v1/ws/host",
    enabled: true,
    development: { enabled: true, hostToken: "not-logged", hostId: "host_dev" },
    onStatus: status => statuses.push(status.state),
    webSocketFactory: () => socket,
    random: () => 0
  });
  client.start();
  socket.emit("close", 1006, Buffer.from("network"));
  assert.equal(client.getStatus().state, "backoff");
  client.stop();
  assert.equal(client.getStatus().state, "stopped");
  assert.deepEqual(statuses.slice(-2), ["backoff", "stopped"]);
});

test("outbound frames cannot be queued before authentication", () => {
  const socket = new FakeSocket();
  socket.readyState = 0;
  const client = new RelayClient({
    endpoint: "ws://127.0.0.1:8080/v1/ws/host",
    enabled: true,
    development: { enabled: true, hostToken: "not-logged", hostId: "host_dev" },
    webSocketFactory: () => socket
  });
  client.start();
  const frame = { v: 1, type: "ping", id: "msg_ping", sentAt: "2026-09-01T10:00:00.000Z", payload: { nonce: "n" } };
  assert.equal(client.send(frame), false);
  client.stop();
});

test("D3 publishes only a protocol-validated host.status.changed event", () => {
  const socket = new FakeSocket();
  const relay = new RelayClient({
    endpoint: "ws://127.0.0.1:8080/v1/ws/host",
    enabled: true,
    development: { enabled: true, hostToken: "not-logged", hostId: "host_dev" },
    webSocketFactory: () => socket
  });
  relay.start();
  socket.emit("open");
  socket.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "auth.ok", id: "msg_ok", sentAt: "2026-09-01T10:00:00.000Z", payload: { connectionId: "conn_1", role: "host", hostId: "host_dev", serverTime: "2026-09-01T10:00:00.000Z", limits: { maxFrameBytes: 262144, maxChunkBytes: 32768, maxConcurrentRpcs: 8, rpcReadTimeoutMs: 15000, rpcWriteTimeoutMs: 30000, heartbeatIntervalMs: 30000, challengeTtlMs: 60000 } } })));
  const publisher = new HostStatusPublisher(relay, () => Date.parse("2026-09-01T10:00:00.000Z"));
  assert.equal(publisher.publish({ hostId: "host_dev", online: true, appVersion: "0.9.10", protocolVersion: 1, remoteEnabled: true, activeRunCount: 0, pendingDecisionCount: 0, activeTerminalCount: 0 }), true);
  assert.equal(socket.sent[0].type, "event");
  assert.equal(socket.sent[0].payload.name, "host.status.changed");
  assert.deepEqual(Object.keys(socket.sent[0].payload.data).sort(), ["activeRunCount", "activeTerminalCount", "appVersion", "hostId", "online", "pendingDecisionCount", "protocolVersion", "remoteEnabled", "serverTime"]);
  assert.throws(() => buildHostStatusChangedFrame({ hostId: "host_dev", online: true, appVersion: "0.9.10", protocolVersion: 1, remoteEnabled: true, activeRunCount: 0, pendingDecisionCount: 0, activeTerminalCount: 0, cwd: "/tmp" }, 0));
  relay.stop();
});

test("relay client rejects malformed, unauthenticated, and identity-changing inbound frames", () => {
  const makeClient = () => {
    const socket = new FakeSocket();
    const client = new RelayClient({ endpoint: "ws://127.0.0.1:8080/v1/ws/host", enabled: true, development: { enabled: true, hostToken: "not-logged", hostId: "host_dev" }, webSocketFactory: () => socket });
    client.start(); socket.emit("open");
    return { client, socket };
  };
  for (const invalid of [null, [], { v: 1, type: "ping", id: "msg_1", sentAt: "2026-09-01T10:00:00.000Z", payload: null }, { v: 1, type: "unknown", id: "msg_1", sentAt: "2026-09-01T10:00:00.000Z", payload: {} }, { v: 2, type: "ping", id: "msg_1", sentAt: "2026-09-01T10:00:00.000Z", payload: {} }, { v: 1, type: "ping", id: "msg_1", sentAt: "2026-09-01T10:00:00.000Z", payload: {}, extra: true }]) {
    const { client, socket } = makeClient();
    socket.emit("message", Buffer.from(JSON.stringify(invalid)));
    assert.equal(client.getStatus().state, "auth_failed");
  }
  const { client, socket } = makeClient();
  socket.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "ping", id: "msg_ping", sentAt: "2026-09-01T10:00:00.000Z", payload: {} })));
  assert.equal(client.getStatus().state, "auth_failed", "traffic before auth must close");

  const { client: authenticated, socket: authenticatedSocket } = makeClient();
  authenticatedSocket.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "auth.ok", id: "msg_ok", sentAt: "2026-09-01T10:00:00.000Z", payload: { connectionId: "conn_1", role: "host", hostId: "host_other", serverTime: "2026-09-01T10:00:00.000Z", limits: { maxFrameBytes: 262144, maxChunkBytes: 32768, maxConcurrentRpcs: 8, rpcReadTimeoutMs: 15000, rpcWriteTimeoutMs: 30000, heartbeatIntervalMs: 30000, challengeTtlMs: 60000 } } })));
  assert.equal(authenticated.getStatus().state, "auth_failed", "auth.ok must bind the configured host ID");
});

test("relay authentication timeout clears the unauthenticated connection", async () => {
  const socket = new FakeSocket();
  const client = new RelayClient({ endpoint: "ws://127.0.0.1:8080/v1/ws/host", enabled: true, development: { enabled: true, hostToken: "not-logged", hostId: "host_dev" }, authTimeoutMs: 5, webSocketFactory: () => socket });
  client.start(); socket.emit("open");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(client.getStatus().state, "auth_failed");
  assert.equal(client.send({ v: 1, type: "ping", id: "msg_ping", sentAt: "2026-09-01T10:00:00.000Z", payload: {} }), false);
});

test("oversized and duplicate authentication frames fail closed after unified cleanup", () => {
  const authOk = { v: 1, type: "auth.ok", id: "msg_ok", sentAt: "2026-09-01T10:00:00.000Z", payload: { connectionId: "conn_1", role: "host", hostId: "host_dev", serverTime: "2026-09-01T10:00:00.000Z", limits: { maxFrameBytes: 262144, maxChunkBytes: 32768, maxConcurrentRpcs: 8, rpcReadTimeoutMs: 15000, rpcWriteTimeoutMs: 30000, heartbeatIntervalMs: 30000, challengeTtlMs: 60000 } } };
  const makeClient = () => {
    const socket = new FakeSocket();
    const client = new RelayClient({ endpoint: "ws://127.0.0.1:8080/v1/ws/host", enabled: true, development: { enabled: true, hostToken: "not-logged", hostId: "host_dev" }, webSocketFactory: () => socket });
    client.start(); socket.emit("open");
    return { client, socket };
  };
  const oversized = makeClient();
  oversized.socket.emit("message", Buffer.alloc(262145, 0x61));
  assert.equal(oversized.client.getStatus().state, "auth_failed");
  assert.equal(oversized.socket.readyState, 3);

  const duplicate = makeClient();
  duplicate.socket.emit("message", Buffer.from(JSON.stringify(authOk)));
  assert.equal(duplicate.client.getStatus().state, "online");
  duplicate.socket.emit("message", Buffer.from(JSON.stringify(authOk)));
  assert.equal(duplicate.client.getStatus().state, "auth_failed");
  assert.equal(duplicate.socket.readyState, 3);
});

test("host status publisher enforces v1 ID, text, count, timestamp, and allowlist bounds", () => {
  const valid = { hostId: "host_dev", online: true, appVersion: "0.9.10", protocolVersion: 1, remoteEnabled: true, activeRunCount: 0, pendingDecisionCount: 0, activeTerminalCount: 0 };
  assert.throws(() => buildHostStatusChangedFrame({ ...valid, hostId: "bad id" }, 0));
  assert.throws(() => buildHostStatusChangedFrame({ ...valid, displayName: "" }, 0));
  assert.throws(() => buildHostStatusChangedFrame({ ...valid, appVersion: "" }, 0));
  assert.throws(() => buildHostStatusChangedFrame({ ...valid, activeRunCount: 10_001 }, 0));
  assert.throws(() => buildHostStatusChangedFrame({ ...valid, activeTerminalCount: 1_001 }, 0));
  assert.throws(() => buildHostStatusChangedFrame({ ...valid, serverTime: "2026-09-01T10:00:00Z", token: "must-not-leak" }, 0));
  assert.throws(() => buildHostStatusChangedFrame({ ...valid, serverTime: "not-a-timestamp" }, 0));
});

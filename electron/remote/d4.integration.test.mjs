import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import WebSocket from "ws";
import Ajv2020 from "ajv/dist/2020.js";
import { WRITE_REMOTE_METHODS } from "@freebuddy/protocol/remote";

import { ReadOnlyRemoteService } from "../../dist-electron/remote/readOnlyService.js";
import { AdminDispatcher } from "../../dist-electron/remote/adminDispatcher.js";
import { EventRingBuffer } from "../../dist-electron/remote/eventRingBuffer.js";
import { SnapshotService } from "../../dist-electron/remote/snapshotService.js";
import { migrate, setDbForTest } from "../../dist-electron/cli/db.js";
import { createUser } from "../../dist-electron/cli/users.js";
import { createProject } from "../../dist-electron/cli/projects.js";
import { createConversation, appendMessage } from "../../dist-electron/cli/conversations.js";
import { broadcastEvent, subscribeEventBroadcaster } from "../../dist-electron/eventBus.js";

function loadV1Json(relativePath) {
  return JSON.parse(readFileSync(path.join(process.cwd(), "protocol/remote/v1", relativePath), "utf8"));
}
const schemaManifest = loadV1Json("schema-manifest.json");
const schemaValidator = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
for (const relativePath of schemaManifest.schemas) schemaValidator.addSchema(loadV1Json(relativePath));
const validateEnvelope = schemaValidator.compile({ $ref: schemaManifest.envelopeId });
const methodRegistry = loadV1Json("methods/registry.json");
const resultValidators = new Map(methodRegistry.methods
  .filter(entry => entry.kind === "read")
  .map(entry => {
    const schema = loadV1Json(entry.schema);
    return [entry.method, schemaValidator.compile({ $ref: `${schema.$id}#/$defs/${entry.method}.result` })];
  }));
function assertProtocolEnvelope(frame) {
  assert.equal(validateEnvelope(frame), true, JSON.stringify(validateEnvelope.errors));
}

async function port() { const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening"); const value = s.address().port; await new Promise(resolve => s.close(resolve)); return value; }
function waitFor(check, ms = 10_000) {
  return new Promise((resolve, reject) => {
    const finish = (error) => { clearTimeout(deadline); clearInterval(timer); error ? reject(error) : resolve(); };
    const deadline = setTimeout(() => finish(new Error("timed out waiting for Relay host status")), ms);
    const timer = setInterval(() => { if (check()) finish(); }, 20);
  });
}
function nextFrame(socket, ms = 10_000) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => { clearTimeout(timeout); resolve(JSON.parse(raw.toString())); };
    const timeout = setTimeout(() => { socket.off("message", onMessage); reject(new Error("timed out waiting for Relay frame")); }, ms);
    socket.once("message", onMessage);
  });
}
function expectNoFrame(socket, ms = 150) {
  return new Promise((resolve, reject) => {
    const onMessage = () => { clearTimeout(timeout); reject(new Error("unexpected Relay frame while resume cursor was current")); };
    const timeout = setTimeout(() => { socket.off("message", onMessage); resolve(); }, ms);
    socket.once("message", onMessage);
  });
}
function sendForFrame(socket, frame) { const pending = nextFrame(socket); socket.send(JSON.stringify(frame)); return pending; }
function request(socket, hostId, method, params) {
  return sendForFrame(socket, { v: 1, type: "rpc.request", id: `msg_${randomBytes(9).toString("base64url")}`, hostId, sentAt: new Date().toISOString(), payload: { method, params } });
}
function resume(socket, hostId, id, resumeFrom) {
  return sendForFrame(socket, { v: 1, type: "resume", id, hostId, sentAt: new Date().toISOString(), payload: { resumeFrom } });
}

async function seedRemainingReadDomains(database, temp, ownerId) {
  const logPath = path.join(temp, "task-d4.jsonl");
  await fs.writeFile(logPath, JSON.stringify({ ts: "2026-09-01T00:00:00.000Z", type: "output", content: "actual task log" }) + "\n");
  database.prepare(`INSERT INTO cli_tasks
    (id, agent_id, agent_name, adapter, status, prompt, prompt_summary, log_path, owner_id, created_at, updated_at)
    VALUES (?, 'agent_d4', 'Agent', 'codex', 'running', 'actual task', 'D4 task', ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run("task_d4", logPath, ownerId);
  database.prepare(`INSERT INTO workflow_runs
    (id, name, goal, status, max_loops, plan_json, kind, created_at, updated_at)
    VALUES ('workflow_d4', 'D4 workflow', 'verify reads', 'running', 1, '{}', 'workflow', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO workflow_teams
    (id, name, enabled, source, kind, roles_json, template_json, policy_json, delegation_meta_json, created_at, updated_at)
    VALUES ('delegation_d4', 'D4 delegation', 1, 'user', 'delegation', '[]', '{}', '{}', '{"entryRoleId":"lead"}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run();
}

function assertSuccessfulRead(frame, method) {
  assertProtocolEnvelope(frame);
  assert.equal(frame.type, "rpc.response");
  assert.equal(frame.payload.ok, true, `${method} unexpectedly failed`);
  const validateResult = resultValidators.get(method);
  assert.ok(validateResult, `missing read result schema for ${method}`);
  assert.equal(validateResult(frame.payload.result), true, `${method} result does not match its v1 schema: ${JSON.stringify(validateResult.errors)}`);
  return frame.payload.result;
}

test("D4 real store + Go Relay: reads, paging, events, resume and rejections work headlessly", { timeout: 60_000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "freebuddy-d4-"));
  const database = new Database(":memory:"); migrate(database); setDbForTest(database);
  const { user } = createUser({ username: "owner", password: "password123", isOwner: true });
  const project = createProject({ name: "D4 project", folders: [temp], primaryPath: temp });
  createConversation({ id: "conv_d4", title: "D4 conversation", agentId: "agent_d4", agentName: "Agent", adapter: "codex", projectId: project.id, ownerId: user.id });
  appendMessage({ id: "message_d4", conversationId: "conv_d4", role: "user", status: "complete", content: "hello from actual store" });
  await seedRemainingReadDomains(database, temp, user.id);
  const relayBinary = path.join(temp, "relay"); const listenPort = await port(); const hostId = "host_d4";
  const adminToken = randomBytes(32).toString("base64url"), hostToken = randomBytes(32).toString("base64url");
  const built = spawnSync("go", ["build", "-o", relayBinary, "./cmd/relay"], { cwd: "services/remote-relay", encoding: "utf8" }); assert.equal(built.status, 0, built.stderr || built.stdout);
  const relay = spawn(relayBinary, [], { env: { ...process.env, LISTEN_ADDR: `127.0.0.1:${listenPort}`, SQLITE_PATH: path.join(temp, "relay.sqlite"), DEV_AUTH_MODE: "true", DEV_AUTH_ADMIN_TOKEN: adminToken, DEV_AUTH_HOST_TOKEN: hostToken, DEV_AUTH_HOST_ID: hostId }, stdio: "ignore" });
  let service, admin, online = false, stage = "start";
  try {
    stage = "host online";
    service = new ReadOnlyRemoteService({ hostId, status: () => ({ hostId, online: true, appVersion: "test", protocolVersion: 1, remoteEnabled: true, activeRunCount: 0, pendingDecisionCount: 0, activeTerminalCount: 0 }) });
    service.enable({ endpoint: `ws://127.0.0.1:${listenPort}/v1/ws/host`, development: { enabled: true, hostToken, hostId }, onStatus: status => { online = status.state === "online"; } });
    await waitFor(() => online);
    stage = "admin auth";
    admin = new WebSocket(`ws://127.0.0.1:${listenPort}/v1/ws/admin`, { headers: { Authorization: `Bearer ${adminToken}` } }); await once(admin, "open"); await nextFrame(admin);
    stage = "snapshot";
    const rpcSnapshot = await request(admin, hostId, "sync.snapshot", { conversationLimit: 1 });
    const snapshot = assertSuccessfulRead(rpcSnapshot, "sync.snapshot");
    assert.equal(snapshot.conversations[0].conversationId, "conv_d4");
    assert.match(snapshot.host.serverTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    stage = "host status";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "host.status", {}), "host.status").hostId, hostId);
    stage = "project list";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "project.list", { limit: 1 }), "project.list").items[0].projectId, project.id);
    stage = "agent list";
    assert.ok(Array.isArray(assertSuccessfulRead(await request(admin, hostId, "agent.list", { projectId: project.id, limit: 1 }), "agent.list").items));
    stage = "conversation list";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "conversation.list", { limit: 1, projectId: project.id }), "conversation.list").items[0].conversationId, "conv_d4");
    stage = "conversation get";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "conversation.get", { conversationId: "conv_d4" }), "conversation.get").conversationId, "conv_d4");
    stage = "message list";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "message.list", { conversationId: "conv_d4", limit: 1 }), "message.list").items[0].messageId, "message_d4");
    stage = "task list";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "task.list", { limit: 1 }), "task.list").items[0].taskId, "task_d4");
    stage = "task read log";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "task.readLog", { taskId: "task_d4", limit: 1 }), "task.readLog").items[0].text, "actual task log");
    stage = "workflow list";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "workflow.list", { limit: 1 }), "workflow.list").items[0].workflowId, "workflow_d4");
    stage = "workflow get";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "workflow.get", { workflowId: "workflow_d4" }), "workflow.get").workflowId, "workflow_d4");
    stage = "delegation list";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "delegation.list", { limit: 1 }), "delegation.list").items[0].delegationId, "delegation_d4");
    stage = "delegation get";
    assert.equal(assertSuccessfulRead(await request(admin, hostId, "delegation.get", { delegationId: "delegation_d4" }), "delegation.get").delegationId, "delegation_d4");
    stage = "not found";
    const missing = await request(admin, hostId, "conversation.get", { conversationId: "missing" }); assertProtocolEnvelope(missing); assert.equal(missing.payload.error.code, "not_found");
    stage = "first event";
    const firstEvent = nextFrame(admin); broadcastEvent("conversations://changed", { conversationId: "conv_d4" }); const event = await firstEvent; assert.equal(event.type, "event"); assert.equal(event.seq, 0);
    // resumeFrom is the last event seen. At the current tail it yields no frame.
    stage = "tail resume";
    const currentCursor = expectNoFrame(admin);
    admin.send(JSON.stringify({ v: 1, type: "resume", id: "msg_resume", hostId, sentAt: new Date().toISOString(), payload: { resumeFrom: 0 } }));
    await currentCursor;
    const secondEvent = nextFrame(admin); broadcastEvent("conversations://changed", { conversationId: "conv_d4" }); assert.equal((await secondEvent).seq, 1);
    stage = "replay";
    assert.equal((await resume(admin, hostId, "msg_resume2", 0)).seq, 1);
    const fallbackSnapshot = await resume(admin, hostId, "msg_old", 999999);
    assert.equal(fallbackSnapshot.type, "snapshot");
    assertProtocolEnvelope(fallbackSnapshot);
    assert.match(fallbackSnapshot.payload.host.serverTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    stage = "webui coexistence";
    const webUiEvents = []; const detach = subscribeEventBroadcaster((channel) => webUiEvents.push(channel)); const thirdEvent = nextFrame(admin); broadcastEvent("conversations://changed", { conversationId: "conv_d4" }); await thirdEvent; detach(); assert.deepEqual(webUiEvents, ["conversations://changed"]);
  } catch (error) {
    console.error(`D4 integration failed at ${stage}: ${error instanceof Error ? error.message : "unknown error"}`);
    throw error;
  } finally {
    service?.disable();
    admin?.close();
    if (!relay.killed) relay.kill("SIGTERM");
    await Promise.race([once(relay, "exit"), new Promise(resolve => setTimeout(resolve, 5_000))]);
    database.close(); setDbForTest(null);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("D4 Host rejects writes, unknown methods, and invalid parameters before any domain action", async () => {
  const database = new Database(":memory:"); migrate(database); setDbForTest(database);
  let stage = "seed";
  try {
    const { user } = createUser({ username: "owner", password: "password123", isOwner: true });
    const project = createProject({ name: "D4 security project", folders: [os.tmpdir()], primaryPath: os.tmpdir() });
    createConversation({ id: "conv_d4_security", title: "D4 security", agentId: "agent_d4", agentName: "Agent", adapter: "codex", projectId: project.id, ownerId: user.id });
    const hostId = "host_d4_security";
    const snapshots = new SnapshotService(() => ({ hostId, online: true, appVersion: "test", protocolVersion: 1, remoteEnabled: true, activeRunCount: 0, pendingDecisionCount: 0, activeTerminalCount: 0 }), () => 0);
    const dispatcher = new AdminDispatcher(hostId, snapshots);
    const baseStatus = { hostId, online: true, appVersion: "test", protocolVersion: 1, remoteEnabled: true, activeRunCount: 0, pendingDecisionCount: 0, activeTerminalCount: 0 };
    for (const sourceTime of [undefined, null, "not-a-timestamp"]) {
      const regenerated = new SnapshotService(() => ({ ...baseStatus, serverTime: sourceTime }), () => 7, () => Date.parse("2026-09-01T10:00:00.000Z")).snapshot();
      assert.equal(regenerated.host.serverTime, "2026-09-01T10:00:00.000Z");
      assertProtocolEnvelope({ v: 1, type: "snapshot", id: "msg_snapshot_contract", hostId, sentAt: regenerated.host.serverTime, seq: regenerated.baseSeq, payload: regenerated });
    }
    const dispatch = async (method, params, extra = {}) => dispatcher.dispatch({ v: 1, type: "rpc.request", id: `msg_${randomBytes(9).toString("base64url")}`, hostId, sentAt: new Date().toISOString(), ...extra, payload: { method, params } });
    stage = "write rejection";
    for (const method of WRITE_REMOTE_METHODS) {
      const response = await dispatch(method, {}, { expiresAt: "2000-01-01T00:00:00.000Z", idempotencyKey: "idem_aaaaaaaaaaaaaaaaaaaaaaaa" });
      assertProtocolEnvelope(response);
      assert.equal(response.payload.error.code, "method_not_allowed", method);
    }
    stage = "unknown method rejection";
    assert.equal((await dispatch("unknown.method", {})).payload.error.code, "method_not_allowed");
    stage = "invalid parameter rejection";
    assert.equal((await dispatch("conversation.get", { conversationId: "conv_d4_security", userId: "forged" })).payload.error.code, "invalid_request");
  } catch (error) {
    console.error(`D4 Host rejection test failed at ${stage}: ${error instanceof Error ? error.message : "unknown error"}`);
    throw error;
  } finally { database.close(); setDbForTest(null); }
});

test("D4 ring buffer evicts by capacity, age, and cleans no subscriptions", () => {
  let now = 0; const ring = new EventRingBuffer("host_ring", 2, 10, () => now);
  ring.publish({ name: "conversation.updated", data: { conversationId: "a" } }); now = 1;
  ring.publish({ name: "conversation.updated", data: { conversationId: "b" } }); now = 2;
  ring.publish({ name: "conversation.updated", data: { conversationId: "c" } }); now = 3;
  ring.publish({ name: "conversation.updated", data: { conversationId: "d" } });
  assert.equal(ring.resume(0), null); assert.deepEqual(ring.resume(1).map(f => f.seq), [2, 3]);
  now = 20; assert.equal(ring.resume(2), null);
});

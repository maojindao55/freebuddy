import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";
import { childExited, createBoundedRedactedOutput, nextFrame, stopChild, waitFor, waitForHttpOk } from "./electron-harness-lifecycle.mjs";

async function freePort() { const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function command(child, value) { child.stdin.write(`${JSON.stringify(value)}\n`); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function resumeWhenHostOnline(admin, hostId, id) {
  let last;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const frame = nextFrame(admin);
    admin.send(JSON.stringify({ v: 1, type: "resume", id: `${id}_${attempt}`, hostId, sentAt: new Date().toISOString(), payload: { resumeFrom: 99_999 } }));
    last = await frame;
    if (last.type === "snapshot") return last;
    await pause(250);
  }
  throw new Error(`host did not become online for snapshot: ${JSON.stringify(last)}`);
}
const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const HARNESS_MESSAGE_LIMIT = 4 * 1024;

async function connectAdmin(port, token, relayOutput, label) {
  const admin = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/admin`, { headers: { Authorization: `Bearer ${token}` } });
  const auth = nextFrame(admin);
  try {
    const [, frame] = await Promise.all([once(admin, "open"), auth]);
    assert.equal(frame.type, "auth.ok", `${label} admin connection did not authenticate`);
  } catch (error) {
    admin.close();
    const message = error instanceof Error ? error.message : "admin WebSocket connection failed";
    throw new Error(`${label} admin connection failed: ${message}; relay output: ${relayOutput.read() || "(none)"}`);
  }
  return admin;
}

function createSecretOutputObserver(secrets) {
  const longestSecretLength = Math.max(...secrets.map(secret => secret.length));
  let suffix = "";
  let secretOutputSeen = false;
  return {
    observe(chunk) {
      const output = `${suffix}${chunk}`;
      secretOutputSeen ||= secrets.some(secret => output.includes(secret));
      suffix = output.slice(-(longestSecretLength - 1));
    },
    seen() { return secretOutputSeen; }
  };
}

function readHarnessMessage(line) {
  if (Buffer.byteLength(line) > HARNESS_MESSAGE_LIMIT) return undefined;
  try {
    const message = JSON.parse(line);
    if (!message || typeof message !== "object" || typeof message.type !== "string" || message.type.length > 64) return undefined;
    return { type: message.type, stage: typeof message.stage === "string" ? message.stage : undefined, visible: message.visible === true };
  } catch { return undefined; }
}

async function assertGuiRuntimeAvailable(environment) {
  const probe = spawn(electronBinary, ["electron/remote/electron-gui-probe.mjs"], { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const output = createBoundedRedactedOutput();
  probe.stdout.on("data", chunk => output.append(chunk));
  probe.stderr.on("data", chunk => output.append(chunk));
  try {
    try {
      await waitFor(() => output.read().includes('"type":"gui_ready"') || probe.exitCode !== null || probe.signalCode !== null, 10_000, "real Electron GUI probe");
    } catch (error) {
      throw new Error(`real Electron GUI runtime prerequisite unavailable (${error instanceof Error ? error.message : "probe failed"}): ${output.read() || "(no output)"}`);
    }
    assert.equal(output.read().includes('"type":"stage","stage":"module_loaded"'), true, `Electron entry module did not finish evaluating: ${output.read() || "(no output)"}`);
    assert.equal(output.read().includes('"type":"stage","stage":"ready"'), true, `Electron never reached app readiness after entry evaluation: ${output.read() || "(no output)"}`);
    assert.equal(output.read().includes('"type":"gui_ready"'), true, `real Electron GUI runtime prerequisite unavailable (exit=${probe.exitCode}, signal=${probe.signalCode ?? "none"}): ${output.read() || "(no output)"}`);
  } finally {
    await stopChild(probe);
  }
}

test("M3 real Electron safeStorage host serves reads while a BrowserWindow is hidden and resumes after admin reconnect", { timeout: 90_000 }, async () => {
  let temp; let relayBinary; let port;
  let relay; let electron; let admin;
  try {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "freebuddy-m3-electron-"));
    relayBinary = path.join(temp, "remote-relay");
    port = await freePort();
    const hostId = `host_${randomBytes(12).toString("base64url")}`; const adminToken = randomBytes(32).toString("base64url"); const hostToken = randomBytes(32).toString("base64url");
    const { ELECTRON_RUN_AS_NODE: _nodeMode, ...electronEnvironment } = process.env;
    assert.equal(typeof electronBinary, "string", "electron package did not return its GUI binary path");
    await assertGuiRuntimeAvailable(electronEnvironment);
    const build = spawnSync("go", ["build", "-o", relayBinary, "./cmd/relay"], { cwd: "services/remote-relay", encoding: "utf8" }); assert.equal(build.status, 0, build.stderr || build.stdout);
    relay = spawn(relayBinary, [], { env: { ...process.env, LISTEN_ADDR: `127.0.0.1:${port}`, SQLITE_PATH: path.join(temp, "relay.sqlite"), DEV_AUTH_MODE: "true", DEV_AUTH_ADMIN_TOKEN: adminToken, DEV_AUTH_HOST_TOKEN: hostToken, DEV_AUTH_HOST_ID: hostId, LOG_FORMAT: "json" }, stdio: ["ignore", "pipe", "pipe"] });
    const secrets = [adminToken, hostToken]; const secretOutput = createSecretOutputObserver(secrets);
    const messages = []; let remainder = ""; const electronStderr = createBoundedRedactedOutput(secrets); const relayOutput = createBoundedRedactedOutput(secrets);
    relay.stdout.on("data", chunk => { secretOutput.observe(chunk); relayOutput.append(chunk); }); relay.stderr.on("data", chunk => { secretOutput.observe(chunk); relayOutput.append(chunk); });
    await waitForHttpOk(`http://127.0.0.1:${port}/readyz`, relay).catch(error => {
      const message = error instanceof Error ? error.message : "Relay readiness failed";
      throw new Error(`${message}; relay output: ${relayOutput.read() || "(none)"}`);
    });
    electron = spawn(electronBinary, ["electron/remote/electron-hidden-window-harness.mjs"], { cwd: process.cwd(), env: { ...electronEnvironment, FB_REMOTE_READONLY_DEV: "1", FB_REMOTE_DEV_ENDPOINT: `ws://127.0.0.1:${port}/v1/ws/host`, FB_REMOTE_DEV_HOST_TOKEN: hostToken, FB_REMOTE_DEV_HOST_ID: hostId, FB_REMOTE_TEST_USER_DATA: path.join(temp, "userData") }, stdio: ["pipe", "pipe", "pipe"] });
    electron.stdout.on("data", chunk => { secretOutput.observe(chunk); remainder = `${remainder}${chunk}`.slice(-16 * 1024); const lines = remainder.split("\n"); remainder = lines.pop(); for (const line of lines) { const message = readHarnessMessage(line); if (message) { messages.push(message); if (messages.length > 128) messages.shift(); } } });
    electron.stderr.on("data", chunk => { secretOutput.observe(chunk); electronStderr.append(chunk); });
    await waitFor(() => messages.some(message => message.type === "ready" || message.type === "error" || message.type === "blocked_safe_storage") || electron.exitCode !== null)
      .catch(error => { throw new Error(`${error.message}; Electron stderr: ${electronStderr.read() || "(none)"}; relay output: ${relayOutput.read() || "(none)"}; stdout stages: ${JSON.stringify(messages.filter(message => message.type === "stage").map(message => message.stage))}`); });
    assert.equal(messages.some(message => message.type === "blocked_safe_storage"), false, `actual OS safeStorage was unavailable; Electron stderr: ${electronStderr.read()}`);
    assert.equal(messages.some(message => message.type === "error"), false, `Electron harness returned an error; Electron stderr: ${electronStderr.read()}`);
    assert.equal(secretOutput.seen(), false, "a child process wrote a test token to captured output");
    const stages = messages.filter(message => message.type === "stage").map(message => message.stage);
    assert.deepEqual(stages.slice(0, 3), ["module_loaded", "ready", "imports_start"], `Electron lifecycle stages did not distinguish entry and ready: ${electronStderr.read()}`);
    assert.equal(messages.some(message => message.type === "stage" && message.stage === "window_created"), true, `Electron did not create the real window: ${electronStderr.read()}`);
    const windowCreatedStage = stages.indexOf("window_created");
    const safeStorageStage = stages.indexOf("safe_storage_checking");
    assert.deepEqual(stages.slice(safeStorageStage, safeStorageStage + 4), ["safe_storage_checking", "safe_storage_available", "safe_storage_encrypted", "safe_storage_ready"], `Electron did not complete the actual OS safeStorage round trip: ${electronStderr.read()}`);
    const remoteStartingStage = stages.indexOf("remote_starting");
    assert.equal(windowCreatedStage < safeStorageStage && safeStorageStage + 4 <= remoteStartingStage, true, `Electron did not complete actual safeStorage after creating its window and before remote initialization: ${electronStderr.read()}`);
    assert.equal(remoteStartingStage >= 0, true, `Electron did not begin actual safeStorage-backed remote initialization: ${electronStderr.read()}`);
    assert.equal(messages.some(message => message.type === "stage" && message.stage === "remote_started"), true, `Electron did not start the headless remote service: ${electronStderr.read()}`);
    assert.equal(messages.find(message => message.type === "ready")?.visible, true, `Electron harness never became ready: ${electronStderr.read()}`);
    admin = await connectAdmin(port, adminToken, relayOutput, "initial");
    const visibleSnapshot = await resumeWhenHostOnline(admin, hostId, "msg_visible_snapshot"); assert.equal(visibleSnapshot.payload.conversations[0].conversationId, "conv_electron_hidden");
    command(electron, { type: "hide" }); await waitFor(() => messages.some(message => message.type === "hidden")); assert.equal(messages.find(message => message.type === "hidden").visible, false);
    const event = nextFrame(admin); command(electron, { type: "event" }); const hiddenEvent = await event; assert.equal(hiddenEvent.type, "event"); assert.equal(hiddenEvent.payload.name, "conversation.updated");
    admin.close(); await once(admin, "close"); command(electron, { type: "event" });
    admin = await connectAdmin(port, adminToken, relayOutput, "reconnect");
    const fallback = nextFrame(admin); admin.send(JSON.stringify({ v: 1, type: "resume", id: "msg_reconnect_fallback", hostId, sentAt: new Date().toISOString(), payload: { resumeFrom: 99_999 } })); assert.equal((await fallback).type, "snapshot");
  } finally {
    admin?.close();
    const stops = await Promise.allSettled([
      stopChild(electron, { stdinValue: { type: "stop" } }),
      stopChild(relay)
    ]);
    const failures = stops.filter(result => result.status === "rejected");
    if (failures.length > 0 || (electron && !childExited(electron)) || (relay && !childExited(relay))) {
      throw new AggregateError(failures.map(result => result.reason), "failed to stop an M3 test child; temporary directory was retained until both children exited");
    }
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
});

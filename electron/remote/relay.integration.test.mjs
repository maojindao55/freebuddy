import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";

import { HostStatusPublisher, RelayClient } from "../../dist-electron/remote/index.js";

async function randomLoopbackPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("timed out waiting for Relay POC")), timeoutMs);
    const timer = setInterval(() => {
      try {
        if (predicate()) { clearTimeout(deadline); clearInterval(timer); resolve(); }
      } catch (error) { clearTimeout(deadline); clearInterval(timer); reject(error); }
    }, 25);
  });
}

function nextFrame(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for Relay frame")), 10_000);
    socket.once("message", data => { clearTimeout(timeout); resolve(JSON.parse(data.toString())); });
  });
}

test("Electron RelayClient authenticates with a real local Go Relay and admin receives host status", { timeout: 60_000 }, async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "freebuddy-d3-relay-"));
  const relayBinary = path.join(tempDir, "remote-relay");
  const port = await randomLoopbackPort();
  const hostId = `host_${randomBytes(12).toString("base64url")}`;
  const adminToken = randomBytes(32).toString("base64url");
  const hostToken = randomBytes(32).toString("base64url");
  const build = spawnSync("go", ["build", "-o", relayBinary, "./cmd/relay"], { cwd: "services/remote-relay", encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const relay = spawn(relayBinary, [], {
    env: {
      ...process.env, LISTEN_ADDR: `127.0.0.1:${port}`, SQLITE_PATH: path.join(tempDir, "relay.sqlite"),
      DEV_AUTH_MODE: "true", DEV_AUTH_ADMIN_TOKEN: adminToken, DEV_AUTH_HOST_TOKEN: hostToken,
      DEV_AUTH_HOST_ID: hostId, LOG_FORMAT: "json", LOG_LEVEL: "info"
    }, stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  relay.stdout.on("data", chunk => { logs += chunk.toString(); });
  relay.stderr.on("data", chunk => { logs += chunk.toString(); });
  let client;
  let admin;
  try {
    await waitFor(() => logs.includes("starting FreeBuddy Remote Relay server"));
    const online = new Promise((resolve, reject) => {
      client = new RelayClient({ endpoint: `ws://127.0.0.1:${port}/v1/ws/host`, enabled: true, development: { enabled: true, hostToken, hostId }, onStatus: status => status.state === "online" && resolve() });
      client.start();
      setTimeout(() => reject(new Error("Electron RelayClient did not authenticate")), 10_000);
    });
    await online;
    admin = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/admin`, { headers: { Authorization: `Bearer ${adminToken}` } });
    await once(admin, "open");
    const auth = await nextFrame(admin);
    assert.equal(auth.type, "auth.ok");
    const publisher = new HostStatusPublisher(client);
    assert.equal(publisher.publish({ hostId, displayName: "D3 test host", online: true, appVersion: "0.9.10", protocolVersion: 1, remoteEnabled: true, activeRunCount: 0, pendingDecisionCount: 0, activeTerminalCount: 0 }), true);
    const event = await nextFrame(admin);
    assert.deepEqual(event.payload.name, "host.status.changed");
    assert.equal(event.payload.data.hostId, hostId);
    assert.equal(event.payload.data.online, true);
  } finally {
    client?.stop();
    admin?.close();
    relay.kill("SIGTERM");
    await Promise.race([once(relay, "exit"), new Promise(resolve => setTimeout(resolve, 5_000))]);
    assert.equal(logs.includes(adminToken), false, "Relay logs must not contain the generated admin token");
    assert.equal(logs.includes(hostToken), false, "Relay logs must not contain the generated host token");
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

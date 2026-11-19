import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-config-probe-"));
const userDataDir = path.join(tmpRoot, "user-data");
const workDirA = path.join(tmpRoot, "work-a");
const workDirB = path.join(tmpRoot, "work-b");
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(workDirA, { recursive: true });
fs.mkdirSync(workDirB, { recursive: true });

globalThis.__freebuddyElectronGetPath = () => userDataDir;

const { setDbForTest } = await import("../dist-electron/cli/db.js");
setDbForTest({
  prepare: () => ({
    run: () => ({ changes: 1 }),
    get: () => undefined,
    all: () => []
  }),
  transaction: (fn) => (...args) => fn(...args)
});

const { inspectSessionConfigOptions } = await import(
  "../dist-electron/cli/sessionConfigProbe.js"
);

function createFakeAcpAgentBinary(name, scriptBody) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const jsPath = path.join(dir, "agent.mjs");
  const binPath = path.join(dir, "agent.sh");
  fs.writeFileSync(jsPath, scriptBody, "utf8");
  fs.writeFileSync(
    binPath,
    `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`,
    { mode: 0o755 }
  );
  return binPath;
}

test.after(() => {
  setDbForTest(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("inspectSessionConfigOptions unpacks RPC error data details and preserves code and data", async () => {
  const binPath = createFakeAcpAgentBinary(
    "error-unpack",
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: {} }
    }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32603,
        message: "Internal error",
        data: { message: "Failed to initialize session services" }
      }
    }) + "\\n");
  }
});
`
  );

  let caught;
  try {
    await inspectSessionConfigOptions({
      agentId: "cursor-test",
      adapter: "cursor-agent-acp",
      binary: binPath,
      cwd: workDirA
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof Error);
  assert.match(caught.message, /Failed to initialize session services/);
  assert.match(caught.message, /原会话已保留/);
  assert.equal(caught.code, -32603);
  assert.deepEqual(caught.data, { message: "Failed to initialize session services" });
});

test("inspectSessionConfigOptions deduplicates concurrent identical probes and cleans up on settle", async () => {
  const countFile = path.join(tmpRoot, "spawn-count.txt");
  fs.writeFileSync(countFile, "0", "utf8");

  const binPath = createFakeAcpAgentBinary(
    "dedupe",
    `
import fs from "node:fs";
import readline from "node:readline";
const countFile = ${JSON.stringify(countFile)};
const count = Number(fs.readFileSync(countFile, "utf8")) + 1;
fs.writeFileSync(countFile, String(count), "utf8");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: {} }
    }) + "\\n");
  } else if (msg.method === "session/new") {
    setTimeout(() => {
      if (process.env.PROBE_MODE === "fail") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32603,
            message: "Internal error",
            data: { message: "Failed to initialize session services" }
          }
        }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            sessionId: "probe-session-1",
            configOptions: [
              {
                id: "model",
                category: "model",
                name: "Model",
                type: "select",
                currentValue: "claude-4-sonnet",
                options: [{ value: "claude-4-sonnet", name: "Claude 4 Sonnet" }]
              }
            ]
          }
        }) + "\\n");
      }
    }, 40);
  } else if (msg.method === "session/close") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  }
});
`
  );

  const okInput = {
    agentId: "cursor-dedupe",
    adapter: "cursor-agent-acp",
    binary: binPath,
    cwd: workDirA,
    env: { PROBE_MODE: "ok" }
  };

  const [res1, res2] = await Promise.all([
    inspectSessionConfigOptions(okInput),
    inspectSessionConfigOptions(okInput)
  ]);
  assert.equal(Number(fs.readFileSync(countFile, "utf8")), 1);
  assert.equal(res1[0]?.currentValue, "claude-4-sonnet");
  assert.equal(res2[0]?.currentValue, "claude-4-sonnet");

  // Concurrent failing probes also share one spawn, then cleanup allows a subsequent retry.
  const failInput = {
    agentId: "cursor-dedupe",
    adapter: "cursor-agent-acp",
    binary: binPath,
    cwd: workDirB,
    env: { PROBE_MODE: "fail" }
  };
  const settled = await Promise.allSettled([
    inspectSessionConfigOptions(failInput),
    inspectSessionConfigOptions(failInput)
  ]);
  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[1].status, "rejected");
  assert.match(settled[0].reason.message, /Failed to initialize session services/);
  assert.equal(Number(fs.readFileSync(countFile, "utf8")), 2);

  await assert.rejects(
    inspectSessionConfigOptions(failInput),
    /Failed to initialize session services/
  );
  assert.equal(Number(fs.readFileSync(countFile, "utf8")), 3);
});

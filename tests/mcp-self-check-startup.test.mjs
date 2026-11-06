import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let Database;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = undefined;
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = realSetTimeout(() => reject(new Error("Self-check did not settle")), 5000);
      })
    ]);
  } finally {
    realClearTimeout(timer);
  }
}

function running(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fixture(t, mode, { descendant = false } = {}) {
  if (!Database) {
    t.skip("Run with Electron's Node runner for the native database binding");
    return;
  }
  const database = await import("../dist-electron/cli/db.js");
  const api = await import("../dist-electron/cli/mcpServers.js");
  const db = new Database(":memory:");
  database.setDbForTest(db);
  database.migrate(db);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-mcp-startup-"));
  const ready = path.join(directory, "ready.json");
  const release = path.join(directory, "release");
  const toolsRequested = path.join(directory, "tools-requested");
  const script = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = ${descendant} ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : undefined;
let buffer = "", initialize, replied = false;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
setInterval(() => {
  if (!initialize || replied || !fs.existsSync(${JSON.stringify(release)})) return;
  replied = true;
  reply(initialize.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "slow-start", version: "1" } });
}, 10);
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.method === "initialize") {
      initialize = message;
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, descendant: child?.pid }));
      if (${JSON.stringify(mode)} === "initialize-error") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unsupported protocol " + process.env.API_KEY } }) + "\\n");
      }
    } else if (message.method === "tools/list") {
      fs.writeFileSync(${JSON.stringify(toolsRequested)}, "ready");
      if (${JSON.stringify(mode)} === "success") reply(message.id, { tools: [{ name: "ping" }] });
    }
  }
});
`;
  const server = api.createUserMcpServer({
    name: `startup-${mode}`,
    command: process.execPath,
    args: ["-e", script],
    env: [{ name: "API_KEY", value: "fixture-private-key", secret: true }]
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = api.selfCheckUserMcpServer(server.id);
  let settled = false;
  pending.then(() => { settled = true; });
  t.after(async () => {
    t.mock.timers.tick(150_000);
    await within(pending);
    database.setDbForTest(null);
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(ready), "Fixture must receive initialize");
  return {
    api, server, pending, release, toolsRequested,
    get settled() { return settled; },
    pids: JSON.parse(fs.readFileSync(ready, "utf8"))
  };
}

test("local self-check survives the old 15-second limit and completes after dependency startup", async (t) => {
  const context = await fixture(t, "success", { descendant: process.platform !== "win32" });
  if (!context) return;
  t.mock.timers.tick(16_000);
  await Promise.resolve();
  assert.equal(context.settled, false, "A first-run install must get more than 15 seconds");
  fs.writeFileSync(context.release, "start");
  const result = await within(context.pending);
  assert.equal(result.status, "ok", result.error);
  assert.deepEqual(result.tools, ["ping"]);
  assert.equal(context.api.getUserMcpServer(context.server.id).lastCheckCode, undefined);
  await waitFor(() => !running(context.pids.pid), "Successful probe process must exit");
  if (context.pids.descendant) {
    await waitFor(() => !running(context.pids.descendant), "Successful probe must clean up launcher descendants");
  }
});

test("unresponsive startup times out at two minutes, persists its phase and cleans up descendants", async (t) => {
  const context = await fixture(t, "startup-timeout", { descendant: process.platform !== "win32" });
  if (!context) return;
  t.mock.timers.tick(119_999);
  await Promise.resolve();
  assert.equal(context.settled, false);
  t.mock.timers.tick(1);
  const result = await within(context.pending);
  assert.equal(result.status, "error");
  assert.equal(result.code, "startup_timeout");
  assert.match(result.error, /dependency installation/);
  assert.equal(context.api.getUserMcpServer(context.server.id).lastCheckCode, "startup_timeout");
  await waitFor(() => !running(context.pids.pid), "Timed-out probe process must exit");
  if (context.pids.descendant) {
    await waitFor(() => !running(context.pids.descendant), "Timed-out probe must clean up launcher descendants");
  }
  const edited = context.api.updateUserMcpServer(context.server.id, { args: ["-e", "process.exit(0)"] });
  assert.equal(edited.lastCheckCode, undefined, "Editing the connection must clear the previous timeout");
});

test("tool discovery gets a fresh 15 seconds after a slow startup", async (t) => {
  const context = await fixture(t, "tools-timeout");
  if (!context) return;
  t.mock.timers.tick(119_000);
  fs.writeFileSync(context.release, "start");
  await waitFor(() => fs.existsSync(context.toolsRequested), "Fixture must receive tools/list");
  t.mock.timers.tick(14_999);
  await Promise.resolve();
  assert.equal(context.settled, false, "The startup deadline must be cleared after initialize");
  t.mock.timers.tick(1);
  const result = await within(context.pending);
  assert.equal(result.code, "tools_timeout");
  assert.equal(context.api.getUserMcpServer(context.server.id).lastCheckCode, "tools_timeout");
  await waitFor(() => !running(context.pids.pid), "Unresponsive tool discovery must stop the process");
});

test("initialization errors fail immediately and redact credentials", async (t) => {
  const context = await fixture(t, "initialize-error");
  if (!context) return;
  const result = await within(context.pending);
  assert.equal(result.code, "initialize_failed");
  assert.match(result.error, /unsupported protocol/);
  assert.equal(result.error.includes("fixture-private-key"), false);
  assert.equal(context.api.getUserMcpServer(context.server.id).lastCheckError.includes("fixture-private-key"), false);
});

test("MCP timeout messages are localized for current and previously stored results", async () => {
  const source = fs.readFileSync(new URL("../src/services/cli/mcpSelfCheckMessages.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } });
  const { mcpSelfCheckErrorMessage } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
  for (const language of ["zh-CN", "en"]) {
    const strings = JSON.parse(fs.readFileSync(new URL(`../src/locales/${language}.json`, import.meta.url), "utf8"));
    const t = (key) => key.split(".").reduce((value, segment) => value?.[segment], strings);
    for (const code of ["startup_timeout", "tools_timeout", "cwd_required"]) {
      const message = mcpSelfCheckErrorMessage({ code, error: "raw backend error" }, t);
      assert.equal(typeof message, "string");
      assert.notEqual(message, "raw backend error");
    }
    assert.equal(mcpSelfCheckErrorMessage({ error: "Self-check timed out" }, t), strings.mcpServers.error.checkTimeout);
    assert.equal(mcpSelfCheckErrorMessage({ error: "Server rejected the request" }, t), "Server rejected the request");
  }
});

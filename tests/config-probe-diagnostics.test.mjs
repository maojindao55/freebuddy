import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("probe failures identify the adapter and RPC phase, and console errors retain details", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-probe-log-"));
  const consoleMethods = ["log", "info", "warn", "error", "debug"];
  const originals = Object.fromEntries(consoleMethods.map(key => [key, console[key]]));
  const crashEvents = ["uncaughtException", "unhandledRejection"];
  const listeners = new Map(crashEvents.map(key => [key, new Set(process.listeners(key))]));
  globalThis.__freebuddyElectronGetPath = () => root;
  const { initDebugLog } = await import("../dist-electron/debugLog.js");
  const { setDbForTest } = await import("../dist-electron/cli/db.js");
  const { inspectSessionConfigOptions } = await import("../dist-electron/cli/sessionConfigProbe.js");
  // No real database, credentials, provider settings, or agent is used.
  setDbForTest({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }) });
  try {
    for (const key of consoleMethods) console[key] = () => {};
    initDebugLog();
    const failure = Object.assign(new Error("outer failure", { cause: new Error("inner failure") }), { code: "E_PROBE" });
    console.error({ nested: failure });
    console.error(new Error("Bearer abcdefghijklmnop"));

    const fixture = path.join(root, "fake-agent.mjs");
    fs.writeFileSync(fixture, `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } }) + '\\n');
        } else if (request.method === 'session/new') {
          process.stderr.write('catalog diagnostic\\n');
          setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
            error: { code: -32000, message: 'catalog unavailable' } }) + '\\n'), 20);
        }
      });
    `);
    await assert.rejects(inspectSessionConfigOptions({
      agentId: "cli-comate-acp",
      adapter: "comate-acp",
      binary: process.execPath,
      extraArgs: [fixture],
      cwd: root,
      env: { TEST_API_KEY: "do-not-log-env-values" }
    }), /catalog unavailable/);

    const logDir = path.join(root, "freebuddy", "logs");
    const contents = fs.readdirSync(logDir).filter(name => name.startsWith("main-"))
      .map(name => fs.readFileSync(path.join(logDir, name), "utf8")).join("");
    const entries = contents.trim().split("\n").map(line => JSON.parse(line));
    const nested = JSON.parse(entries.find(entry => entry.scope === "console").msg).nested;
    assert.equal(nested.name, "Error");
    assert.equal(nested.message, "outer failure");
    assert.match(nested.stack, /outer failure/);
    assert.equal(nested.code, "E_PROBE");
    assert.equal(nested.cause.message, "inner failure");
    assert.ok(!contents.includes("abcdefghijklmnop"), "newly retained error details must still redact secrets");
    const probe = entries.find(entry => entry.msg === "session config probe failed").data;
    assert.equal(probe.adapter, "comate-acp");
    assert.equal(probe.agentId, "cli-comate-acp");
    assert.equal(probe.phase, "session/new");
    assert.equal(probe.error.code, -32000);
    assert.equal(probe.error.message, "catalog unavailable");
    assert.match(probe.error.stack, /catalog unavailable/);
    assert.match(probe.stderr, /catalog diagnostic/);
    assert.ok(probe.durationMs >= 0);
    assert.ok(!contents.includes("do-not-log-env-values"));
  } finally {
    for (const key of consoleMethods) console[key] = originals[key];
    for (const event of crashEvents) {
      for (const listener of process.listeners(event)) {
        if (!listeners.get(event).has(listener)) process.removeListener(event, listener);
      }
    }
    setDbForTest(null);
    delete globalThis.__freebuddyElectronGetPath;
    // Windows keeps the probe's cwd locked until asynchronous process-tree
    // termination completes. Yield while retrying so its handles can close.
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

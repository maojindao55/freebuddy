import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { childExited, nextFrame, waitFor, waitForExit, withTemporaryDirectory } from "./electron-harness-lifecycle.mjs";

test("harness waitFor clears its polling interval after timeout", async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let cleared = 0;
  global.setInterval = (...args) => originalSetInterval(...args);
  global.clearInterval = handle => { cleared += 1; return originalClearInterval(handle); };
  try { await assert.rejects(waitFor(() => false, 10, "test timeout")); }
  finally { global.setInterval = originalSetInterval; global.clearInterval = originalClearInterval; }
  assert.equal(cleared, 1);
});

test("harness nextFrame removes its message listener after timeout", async () => {
  const socket = new EventEmitter();
  await assert.rejects(nextFrame(socket, 10));
  assert.equal(socket.listenerCount("message"), 0);
});

test("harness waitForExit removes its exit listener after timeout", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  assert.equal(await waitForExit(child, 10), false);
  assert.equal(child.listenerCount("exit"), 0);
});

test("harness child exit check requires an exit code or signal", () => {
  assert.equal(childExited({ exitCode: null, signalCode: null }), false);
  assert.equal(childExited({ exitCode: null, signalCode: "SIGTERM" }), true);
});

test("harness removes its temporary directory when setup fails", async () => {
  let directory;
  await assert.rejects(withTemporaryDirectory(fs, path, os, "freebuddy-harness-test-", async created => {
    directory = created;
    throw new Error("setup failed");
  }));
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("Electron GUI entries finish module evaluation before registering app readiness work", async () => {
  for (const entry of ["electron-gui-probe.mjs", "electron-hidden-window-harness.mjs"]) {
    const source = await readFile(new URL(`./${entry}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /^\s*await\s+app\.whenReady\(\)/m, entry);
    assert.match(source, /write\(\{ type: "stage", stage: "module_loaded" \}\);\s*app\.whenReady\(\)\.then\(async \(\) =>/, entry);
  }
});

test("hidden-window harness checkpoints each real safeStorage operation", async () => {
  const source = await readFile(new URL("./electron-hidden-window-harness.mjs", import.meta.url), "utf8");
  for (const stage of ["safe_storage_checking", "safe_storage_available", "safe_storage_encrypted", "safe_storage_ready"]) {
    assert.match(source, new RegExp(`stage: "${stage}"`));
  }
  assert.match(source, /safeStorage\.isEncryptionAvailable\(\)/);
  assert.match(source, /safeStorage\.encryptString\(/);
  assert.match(source, /safeStorage\.decryptString\(/);
});

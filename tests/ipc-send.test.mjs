import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

test("safe IPC send checks the main frame before sending", () => {
  const src = read("../electron/cli/ipcSend.ts");
  assert.match(src, /webContents\.isDestroyed\(\)/);
  assert.match(src, /webContents\.mainFrame/);
  assert.match(src, /frame\.isDestroyed\(\)/);
  assert.match(src, /frame\.send\(channel, payload\)/);
  assert.match(src, /catch\s*\{/);
});

test("long-running main-process streams use safe IPC send", () => {
  for (const path of [
    "../electron/cli/runtime.ts",
    "../electron/cli/workflowRuntime.ts",
    "../electron/cli/check.ts"
  ]) {
    const src = read(path);
    assert.match(src, /safeSendToWebContents/);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { antigravityUpdateBinary, antigravityUpgradeCommand } from "../dist-electron/cli/antigravityUpdate.js";

function fixture(t) {
  // Exercise spaces, PowerShell interpolation, single quotes and shell operators.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy agy $'& "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "updated");
  const windows = process.platform === "win32";
  const binary = path.join(root, windows ? "agy.cmd" : "agy");
  const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
  fs.writeFileSync(binary, windows
    ? `@echo off\r\nif not "%~1"=="update" exit /b 2\r\necho updated>"${marker}"\r\necho native-update-output\r\nexit /b %AGY_TEST_EXIT%\r\n`
    : `#!/bin/sh\n[ "$1" = update ] || exit 2\nprintf updated > ${quote(marker)}\necho native-update-output\nexit "\${AGY_TEST_EXIT:-0}"\n`, { mode: 0o755 });
  const run = (adapterCommand, exitCode = 0) => {
    const command = antigravityUpgradeCommand(adapterCommand, binary);
    return spawnSync(windows ? "powershell" : "/bin/sh", windows
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command], {
      encoding: "utf8", env: { ...process.env, AGY_TEST_EXIT: String(exitCode) }, timeout: 15_000
    });
  };
  return { root, binary, marker, run };
}

test("an up-to-date bridge still runs agy update and streams its output", t => {
  const { marker, run } = fixture(t);
  const result = run(undefined);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "updated");
  assert.match(result.stdout, /native-update-output/);
});

test("the native updater runs after a successful adapter install", t => {
  const { marker, run } = fixture(t);
  const result = run(process.platform === "win32" ? "cmd /c exit 0" : "true");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(marker));
});

test("a failed adapter install prevents the native update", t => {
  const { marker, run } = fixture(t);
  const result = run(process.platform === "win32" ? "cmd /c exit 7" : "(exit 7)");
  assert.equal(result.status, 7, result.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test("a failed native update cannot be reported as a successful upgrade", t => {
  const { run } = fixture(t);
  const result = run(process.platform === "win32" ? "cmd /c exit 0" : "true", 9);
  assert.equal(result.status, 9, result.stderr);
});

test("a missing native updater cannot reuse the adapter's successful exit code", t => {
  const { binary, run } = fixture(t);
  fs.unlinkSync(binary);
  const result = run(process.platform === "win32" ? "cmd /c exit 0" : "true");
  assert.notEqual(result.status, 0);
});

test("native update follows the bridge override and PATH selection", t => {
  const { root, binary } = fixture(t);
  assert.equal(antigravityUpdateBinary({ AGY_ACP_COMMAND: " /custom/agy " }), "/custom/agy");
  assert.equal(antigravityUpdateBinary({ PATH: root }), binary);
});

test("native update finds the official install location with a stale desktop PATH", t => {
  const { root, binary } = fixture(t);
  const windows = process.platform === "win32";
  const directory = windows ? path.join(root, "agy", "bin") : path.join(root, ".local", "bin");
  fs.mkdirSync(directory, { recursive: true });
  const installed = path.join(directory, path.basename(binary));
  fs.copyFileSync(binary, installed);
  fs.chmodSync(installed, 0o755);
  assert.equal(antigravityUpdateBinary({ PATH: "", LOCALAPPDATA: root }, process.platform, root), installed);
});

test("a fresh install plans the official destination before npm creates agy", () => {
  assert.equal(antigravityUpdateBinary({ PATH: "", LOCALAPPDATA: "C:\\fresh-agy" }, "win32"), "C:\\fresh-agy\\agy\\bin\\agy.exe");
  assert.equal(antigravityUpdateBinary({ PATH: "" }, "linux", "/fresh-agy"), "/fresh-agy/.local/bin/agy");
});

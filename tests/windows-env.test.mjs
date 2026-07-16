import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeWindowsPath,
  parseWindowsShellCommandOutput,
  parseWindowsWhereOutput,
  windowsInstallInvocation
} from "../dist-electron/cli/windowsEnv.js";

test("mergeWindowsPath prefers fresh entries and removes case-insensitive duplicates", () => {
  assert.equal(
    mergeWindowsPath(
      "C:\\Program Files\\nodejs;C:\\Users\\Ada\\AppData\\Roaming\\npm",
      "c:\\program files\\nodejs\\;C:\\Windows\\System32"
    ),
    "C:\\Program Files\\nodejs;C:\\Users\\Ada\\AppData\\Roaming\\npm;C:\\Windows\\System32"
  );
});

test("mergeWindowsPath ignores empty path entries", () => {
  assert.equal(mergeWindowsPath("; C:\\node ;;", undefined), "C:\\node");
});

test("mergeWindowsPath removes wrapping quotes from registry entries", () => {
  assert.equal(
    mergeWindowsPath('"D:\\software\\envs\\npm\\";C:\\Windows\\System32'),
    "D:\\software\\envs\\npm\\;C:\\Windows\\System32"
  );
});

test("where result prefers npm.cmd over a directory and POSIX npm shim", () => {
  const directory = "D:\\software\\envs\\npm\\";
  const posixShim = "D:\\software\\envs\\npm";
  const executable = "D:\\software\\envs\\npm.cmd";
  assert.equal(
    parseWindowsWhereOutput(
      `${directory}\r\n${posixShim}\r\n${executable}\r\n`,
      (candidate) => candidate === posixShim || candidate === executable
    ),
    executable
  );
});

test("Windows npm installs avoid quoted absolute paths and select the right host", () => {
  const command = "npm install -g @agentclientprotocol/claude-agent-acp";
  assert.deepEqual(
    windowsInstallInvocation(command, "D:\\software\\envs\\npm.ps1"),
    {
      command,
      requiresPowerShell: true
    }
  );
  assert.deepEqual(
    windowsInstallInvocation(command, "D:\\software\\envs\\npm.cmd"),
    {
      command,
      requiresPowerShell: false
    }
  );
});

test("PowerShell command resolution ignores profile output before its marker", () => {
  assert.equal(
    parseWindowsShellCommandOutput(
      "Conda environment activated\r\n__FREEBUDDY_COMMAND__C:\\tools\\npm.cmd"
    ),
    "C:\\tools\\npm.cmd"
  );
  assert.equal(parseWindowsShellCommandOutput("profile output only"), undefined);
});

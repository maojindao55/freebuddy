import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeWindowsPath,
  parseWindowsShellCommandOutput,
  parseWindowsWhereOutput,
  windowsCommandInvocation
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

test("where result skips a matching directory before npm.cmd", () => {
  const directory = "D:\\software\\envs\\npm\\";
  const executable = "D:\\software\\envs\\npm.cmd";
  assert.equal(
    parseWindowsWhereOutput(
      `${directory}\r\n${executable}\r\n`,
      (candidate) => candidate === executable
    ),
    executable
  );
});

test("PowerShell npm shims use the call operator and PowerShell host", () => {
  assert.deepEqual(windowsCommandInvocation("D:\\software\\envs\\npm.ps1"), {
    prefix: '& "D:\\software\\envs\\npm.ps1"',
    requiresPowerShell: true
  });
  assert.deepEqual(windowsCommandInvocation("D:\\software\\envs\\npm.cmd"), {
    prefix: '"D:\\software\\envs\\npm.cmd"',
    requiresPowerShell: false
  });
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

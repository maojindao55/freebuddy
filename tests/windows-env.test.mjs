import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeWindowsPath,
  parseWindowsShellCommandOutput
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

test("PowerShell command resolution ignores profile output before its marker", () => {
  assert.equal(
    parseWindowsShellCommandOutput(
      "Conda environment activated\r\n__FREEBUDDY_COMMAND__C:\\tools\\npm.cmd"
    ),
    "C:\\tools\\npm.cmd"
  );
  assert.equal(parseWindowsShellCommandOutput("profile output only"), undefined);
});

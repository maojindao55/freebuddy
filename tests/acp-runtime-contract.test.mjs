import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const acpRuntimeSource = fs.readFileSync(
  new URL("../electron/cli/acpRuntime.ts", import.meta.url),
  "utf8"
);

test("ACP runtime finalizes successful prompt turns without waiting for process exit", () => {
  const promptIndex = acpRuntimeSource.indexOf("await runPromptOnSession();");
  const closeIndex = acpRuntimeSource.indexOf(
    "buildSessionCloseRequest",
    promptIndex
  );
  const doneIndex = acpRuntimeSource.indexOf('finish("done", 0)', closeIndex);
  const stdinEndIndex = acpRuntimeSource.indexOf("child.stdin.end();", doneIndex);

  assert.notEqual(promptIndex, -1);
  assert.notEqual(closeIndex, -1);
  assert.notEqual(doneIndex, -1);
  assert.notEqual(stdinEndIndex, -1);
  assert.ok(promptIndex < closeIndex);
  assert.ok(closeIndex < doneIndex);
  assert.ok(doneIndex < stdinEndIndex);
});

test("ACP runtime still treats process close as a fallback finish signal", () => {
  assert.match(acpRuntimeSource, /child\.on\("close"/);
  assert.match(
    acpRuntimeSource,
    /finish\(exitCode === 0 \? "done" : "failed", exitCode\)/
  );
});

test("ACP terminal output uses the stable exitStatus response shape", () => {
  assert.match(acpRuntimeSource, /buildTerminalOutputResponse\(snap\)/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("business runtime uses surface repoPath as cwd and validates clean repos", () => {
  const runtime = read("../electron/cli/businessRequirementRuntime.ts");
  assert.match(runtime, /cwd: surfaceRun\.repoPath/);
  assert.match(runtime, /requireCleanRepoBeforeRun/);
  assert.match(runtime, /git status --porcelain/);
  assert.match(runtime, /verifyCommands/);
});

test("business requirement IPC exposes approve and start lifecycle", () => {
  const ipc = read("../electron/cli/businessWorkspaceIpc.ts");
  const preload = read("../electron/preload.ts");
  assert.match(ipc, /businessRequirements:createRun/);
  assert.match(ipc, /businessRequirements:startRun/);
  assert.match(ipc, /businessRequirements:getRun/);
  assert.match(preload, /createRun: \(input: unknown\) =>/);
  assert.match(preload, /startRun: \(runId: string\) =>/);
});

test("business commit gate creates branches and commits only after approval", () => {
  const gate = read("../electron/cli/businessCommitGate.ts");
  const ipc = read("../electron/cli/businessWorkspaceIpc.ts");
  assert.match(gate, /export async function previewBusinessCommitGate/);
  assert.match(gate, /git diff --name-only/);
  assert.match(gate, /git checkout -b/);
  assert.match(gate, /git add/);
  assert.match(gate, /git commit -m/);
  assert.match(ipc, /businessRequirements:previewCommitGate/);
  assert.match(ipc, /businessRequirements:approveCommitGate/);
});

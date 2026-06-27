import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("business runtime uses surface repoPath as cwd, orders by dependency, and fails on verify failure", () => {
  const runtime = read("../electron/cli/businessRequirementRuntime.ts");
  assert.match(runtime, /cwd: surfaceRun\.repoPath/);
  assert.match(runtime, /requireCleanRepoBeforeRun/);
  assert.match(runtime, /verifyCommands/);
  assert.match(runtime, /surfaceDependencyOrder/);
  assert.match(runtime, /anyVerifyFailed/);
  assert.match(runtime, /status: anyVerifyFailed \? "failed" : "done"/);
  assert.match(runtime, /STRICT SCOPE/);
  assert.match(runtime, /allowedPaths/);
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

test("createRun handler re-reads + re-derives server-side and ignores renderer-submitted plans", () => {
  const ipc = read("../electron/cli/businessWorkspaceIpc.ts");
  const handlerMatch = ipc.match(
    /"businessRequirements:createRun"[\s\S]*?\n  \);/
  );
  assert.ok(handlerMatch, "createRun handler not found");
  const handler = handlerMatch[0];
  // Must re-read the persisted workspace and re-derive the plan server-side.
  assert.match(handler, /getBusinessWorkspace\(input\.workspaceId\)/);
  assert.match(handler, /validateBusinessWorkspace/);
  assert.match(handler, /previewBusinessAssignment\(workspace,/);
  // Must NOT trust renderer-submitted snapshot/plan/contract.
  assert.doesNotMatch(handler, /input\.workspaceSnapshot/);
  assert.doesNotMatch(handler, /input\.assignmentPlan/);
  assert.doesNotMatch(handler, /input\.contractDraft/);
});

test("business commit gate delegates git operations to the parametric businessGit module", () => {
  const gate = read("../electron/cli/businessCommitGate.ts");
  const git = read("../electron/cli/businessGit.ts");
  const ipc = read("../electron/cli/businessWorkspaceIpc.ts");
  assert.match(gate, /export async function previewBusinessCommitGate/);
  // The gate must NOT spawn a shell itself; all git calls go through businessGit.gitExec (execFile).
  assert.doesNotMatch(gate, /shell:\s*true/);
  assert.match(gate, /from "\.\/businessGit\.js"/);
  assert.match(gate, /filterFilesByAllowedPaths/);
  // businessGit uses execFile with arg arrays for git ops (no shell). Note:
  // runVerifyCommand intentionally uses shell:true for user-authored commands.
  assert.match(git, /execFile/);
  assert.match(git, /"--untracked-files=all"/);
  assert.match(ipc, /businessRequirements:previewCommitGate/);
  assert.match(ipc, /businessRequirements:approveCommitGate/);
});


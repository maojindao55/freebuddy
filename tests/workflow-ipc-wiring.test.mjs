import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const METHODS = [
  "validate",
  "previewReviewLoop",
  "coordinatorPrompt",
  "createRun",
  "start",
  "pause",
  "resume",
  "stop",
  "retryStep",
  "approveGate",
  "requestGateChanges",
  "getRun",
  "getSteps",
  "listRuns"
];

test("workflow IPC handlers are registered", () => {
  const ipc = read("../electron/cli/workflowIpc.ts");
  for (const m of METHODS) {
    assert.match(ipc, new RegExp(`workflow:${m}`));
  }
  const registrar = read("../electron/cli/ipc.ts");
  assert.match(registrar, /registerWorkflowIpc\(\)/);
});

test("workflow IPC registration recovers interrupted running workflows", () => {
  const ipc = read("../electron/cli/workflowIpc.ts");
  const workflows = read("../electron/cli/workflows.ts");
  assert.match(ipc, /recoverInterruptedWorkflowRuns/);
  assert.match(ipc, /recoverInterruptedWorkflowRuns\(\)/);
  assert.match(workflows, /WHERE status = 'running'/);
  assert.match(workflows, /status = 'blocked'/);
  assert.match(workflows, /Interrupted by app restart/);
});

test("workflow approveGate returns the runtime approval result", () => {
  const ipc = read("../electron/cli/workflowIpc.ts");
  assert.match(ipc, /workflow:approveGate/);
  assert.match(ipc, /ensureRuntime\(event\)\.approveGate\(args\.runId, args\.phaseId\)/);
  assert.doesNotMatch(ipc, /approveGate\(args\.runId, args\.phaseId\);\s*return true/s);
});

test("preload exposes the workflow client object", () => {
  const preload = read("../electron/preload.ts");
  assert.match(preload, /const workflow = \{/);
  for (const m of METHODS) {
    assert.match(preload, new RegExp(`${m}\\s*:`));
  }
  assert.match(preload, /\bworkflow,\s*\n\s*workflowTeams,\s*\n\s*skills,\s*\n\s*settings/);
});

test("renderer types declare the FreebuddyWorkflow interface", () => {
  const types = read("../src/types/freebuddy.d.ts");
  assert.match(types, /interface FreebuddyWorkflow \{/);
  assert.match(types, /workflow:\s*FreebuddyWorkflow/);
  for (const m of METHODS) {
    assert.match(types, new RegExp(`${m}\\(`));
  }
});

test("builtin members module exports the ACP agents", () => {
  const members = read("../electron/cli/cliMemberBuiltins.ts");
  assert.match(members, /cli-codex-acp/);
  assert.match(members, /cli-claude-agent-acp/);
  assert.match(members, /cli-opencode-acp/);
  assert.match(members, /cli-cursor-agent-acp/);
  assert.match(members, /cli-kimi-acp/);
  assert.match(members, /cli-qoder-acp/);
  assert.match(members, /cli-codebuddy-acp/);
  assert.match(members, /cli-grok-acp/);
});

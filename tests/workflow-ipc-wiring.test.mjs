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

test("preload exposes the workflow client object", () => {
  const preload = read("../electron/preload.ts");
  assert.match(preload, /const workflow = \{/);
  for (const m of METHODS) {
    assert.match(preload, new RegExp(`${m}\\s*:`));
  }
  assert.match(preload, /\bworkflow,\s*\n\s*workflowTeams,\s*\n\s*settings/);
});

test("renderer types declare the FreebuddyWorkflow interface", () => {
  const types = read("../src/types/freebuddy.d.ts");
  assert.match(types, /interface FreebuddyWorkflow \{/);
  assert.match(types, /workflow:\s*FreebuddyWorkflow/);
  for (const m of METHODS) {
    assert.match(types, new RegExp(`${m}\\(`));
  }
});

test("builtin members module exports the four ACP agents", () => {
  const members = read("../electron/cli/members.ts");
  assert.match(members, /cli-codex-acp/);
  assert.match(members, /cli-claude-agent-acp/);
  assert.match(members, /cli-opencode-acp/);
  assert.match(members, /cli-cursor-agent-acp/);
});

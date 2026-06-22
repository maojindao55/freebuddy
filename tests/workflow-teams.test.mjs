import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const TEAM_METHODS = ["list", "get", "create", "update", "delete", "seedBuiltins"];

test("workflow team IPC handlers are registered", () => {
  const ipc = read("../electron/cli/workflowIpc.ts");
  for (const m of TEAM_METHODS) {
    assert.match(ipc, new RegExp(`workflowTeams:${m}`));
  }
  assert.match(ipc, /workflow:previewTeamRun/);
  assert.match(ipc, /workflow:createTeamRun/);
});

test("preload exposes the workflowTeams client object", () => {
  const preload = read("../electron/preload.ts");
  assert.match(preload, /const workflowTeams = \{/);
  for (const m of TEAM_METHODS) {
    assert.match(preload, new RegExp(`${m}\\s*:`));
  }
  assert.match(preload, /workflowTeams,/);
});

test("renderer types declare the FreebuddyWorkflowTeams interface", () => {
  const types = read("../src/types/freebuddy.d.ts");
  assert.match(types, /interface FreebuddyWorkflowTeams \{/);
  assert.match(types, /workflowTeams:\s*FreebuddyWorkflowTeams/);
});

test("expandTeamToPlan produces a workflow plan for the quick team", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { expandTeamToPlan } = await import(
    "../dist-electron/cli/workflowTeamAdapter.js"
  );
  const teams = builtinWorkflowTeams();
  const quick = teams.find((t) => t.id === "team-quick-implement");
  assert.ok(quick);
  const agents = quick.roles.map((r) => ({
    id: r.agentId,
    name: r.agentId,
    adapter: "stub-acp",
    enabled: true
  }));
  const result = expandTeamToPlan(quick, { goal: "fix bug" }, agents);
  assert.equal(result.ok, true);
  assert.ok(result.preview);
  assert.equal(result.preview.teamId, "team-quick-implement");
  assert.equal(result.preview.plan.goal, "fix bug");
  assert.ok(result.preview.plan.phases.length >= 3);
  assert.ok(result.preview.writeNodeCount >= 1);
});

test("readonly team rejects expansion when policy disallows writes", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { expandTeamToPlan } = await import(
    "../dist-electron/cli/workflowTeamAdapter.js"
  );
  const teams = builtinWorkflowTeams();
  const readonly = teams.find((t) => t.id === "team-readonly-analysis");
  assert.ok(readonly);
  const agents = readonly.roles.map((r) => ({
    id: r.agentId,
    name: r.agentId,
    adapter: "stub-acp",
    enabled: true
  }));
  const result = expandTeamToPlan(readonly, { goal: "audit" }, agents);
  assert.equal(result.ok, true);
  assert.equal(result.preview.writeNodeCount, 0);
  for (const phase of result.preview.plan.phases) {
    for (const step of phase.steps) {
      assert.notEqual(step.mode, "write");
    }
  }
});

test("validateWorkflowTeam rejects unknown agent on required role", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { validateWorkflowTeam } = await import(
    "../dist-electron/cli/workflowTeamValidate.js"
  );
  const teams = builtinWorkflowTeams();
  const quick = teams.find((t) => t.id === "team-quick-implement");
  const result = validateWorkflowTeam(quick, []);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown agent")));
});

test("team i18n keys exist in both locales", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  for (const key of [
    "teamExecution",
    "selectTeam",
    "teamList",
    "teamRoles",
    "teamPolicy",
    "newTeam",
    "allowWrites",
    "requireApprovalBeforeWrite"
  ]) {
    assert.ok(en.workflow?.[key], `missing en workflow.${key}`);
    assert.ok(zh.workflow?.[key], `missing zh-CN workflow.${key}`);
  }
});

test("Settings modal mounts the WorkflowTeamsTab", () => {
  const src = read("../src/components/Settings/SettingsModal.tsx");
  assert.match(src, /<WorkflowTeamsTab/);
  assert.match(src, /import \{ WorkflowTeamsTab \}/);
});

test("new task page exposes a team selector and send button for team mode", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.doesNotMatch(src, /<WorkflowTeamPreviewCard/);
  assert.match(src, /workflow\.selectTeam/);
  assert.match(src, /workflow\.teamExecution/);
  assert.match(src, /onSubmit/);
});

test("ChatView onCreateAndSend starts team directly without preview", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /if \(teamMode\)/);
  assert.match(src, /createAndStartTeam\(\{\s*teamId: team\.id/);
});

test("conversation_messages schema carries agent and workflow columns", () => {
  const db = read("../electron/cli/db.ts");
  for (const col of [
    "agent_id",
    "agent_name",
    "adapter",
    "role_label",
    "workflow_run_id",
    "workflow_step_row_id"
  ]) {
    assert.match(db, new RegExp(col));
  }
});

test("workflow runtime appends per-step messages and broadcasts", () => {
  const rt = read("../electron/cli/workflowRuntime.ts");
  assert.match(rt, /appendMessage\(\{/);
  assert.match(rt, /roleLabel/);
  assert.match(rt, /broadcastMessageEvent/);
  assert.match(rt, /workflow:\/\/message\//);
});

test("preload exposes workflow.onStepMessage bridge", () => {
  const preload = read("../electron/preload.ts");
  assert.match(preload, /onStepMessage/);
  assert.match(preload, /workflow:\/\/message\//);
});

test("MessageBubble renders per-message agent header and system bubble", () => {
  const src = read("../src/components/CLI/MessageBubble.tsx");
  assert.match(src, /role === "system"/);
  assert.match(src, /roleLabel/);
  assert.match(src, /msg-system/);
});

test("conversationStore subscribes to workflow message events", () => {
  const src = read("../src/store/conversationStore.ts");
  assert.match(src, /ensureWorkflowMessageSubscription/);
  assert.match(src, /onStepMessage/);
});

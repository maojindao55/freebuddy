import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const TEAM_METHODS = ["list", "get", "create", "update", "delete", "seedBuiltins"];
const WORKFLOW_METHODS = ["listActiveRuns"];

test("workflow team IPC handlers are registered", () => {
  const ipc = read("../electron/cli/workflowIpc.ts");
  for (const m of TEAM_METHODS) {
    assert.match(ipc, new RegExp(`workflowTeams:${m}`));
  }
  assert.match(ipc, /workflow:previewTeamRun/);
  assert.match(ipc, /workflow:createTeamRun/);
  for (const m of WORKFLOW_METHODS) {
    assert.match(ipc, new RegExp(`workflow:${m}`));
  }
});

test("workflow team IPC uses cloned cli members", () => {
  const ipc = read("../electron/cli/workflowIpc.ts");
  const members = read("../electron/cli/members.ts");
  const runtime = read("../electron/cli/workflowRuntime.ts");
  assert.match(ipc, /import \{ listCliMembers \}/);
  assert.match(ipc, /listCliMembers\(\)\.find/);
  assert.match(ipc, /return listCliMembers\(\)\.map/);
  assert.match(members, /filter\(\(override\) => override\.baseAdapter\)/);
  assert.match(members, /id: `cli-\$\{override\.id\}`/);
  assert.match(runtime, /env\?: Record<string, string>/);
  assert.match(runtime, /env: resolved\.env/);
});

test("preload exposes the workflowTeams client object", () => {
  const preload = read("../electron/preload.ts");
  assert.match(preload, /const workflowTeams = \{/);
  for (const m of TEAM_METHODS) {
    assert.match(preload, new RegExp(`${m}\\s*:`));
  }
  assert.match(preload, /workflowTeams,/);
  for (const m of WORKFLOW_METHODS) {
    assert.match(preload, new RegExp(`${m}\\s*:`));
  }
});

test("renderer types declare the FreebuddyWorkflowTeams interface", () => {
  const types = read("../src/types/freebuddy.d.ts");
  assert.match(types, /interface FreebuddyWorkflowTeams \{/);
  assert.match(types, /workflowTeams:\s*FreebuddyWorkflowTeams/);
  assert.match(types, /listActiveRuns\(\): Promise<WorkflowRunRow\[]>/);
});

test("expandTeamToPlan produces a configurable plan for the official delivery example", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { expandTeamToPlan } = await import(
    "../dist-electron/cli/workflowTeamAdapter.js"
  );
  const teams = builtinWorkflowTeams();
  const delivery = teams.find((t) => t.id === "team-delivery-example");
  assert.ok(delivery);
  const agents = delivery.roles.map((r) => ({
    id: r.agentId,
    name: r.agentId,
    adapter: "stub-acp",
    enabled: true
  }));
  const result = expandTeamToPlan(delivery, { goal: "fix bug" }, agents);
  assert.equal(result.ok, true);
  assert.ok(result.preview);
  assert.equal(result.preview.teamId, "team-delivery-example");
  assert.equal(result.preview.plan.goal, "fix bug");
  assert.equal(result.preview.plan.template, "implement-review-loop");
  assert.deepEqual(
    result.preview.plan.phases.map((phase) => phase.id),
    ["plan", "implement", "review", "verify", "summarize", "loop_or_finish"]
  );
  assert.equal(result.preview.plan.phases[0].gate.type, "manual_approval");
  assert.equal(result.preview.plan.phases[1].gate.type, "all_done");
  assert.equal(result.preview.writeNodeCount, 1);
  assert.equal(result.preview.approvalNodeCount, 1);
});

test("team role models become per-step ACP config overrides", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { expandTeamToPlan } = await import(
    "../dist-electron/cli/workflowTeamAdapter.js"
  );
  const delivery = structuredClone(
    builtinWorkflowTeams().find((team) => team.id === "team-delivery-example")
  );
  assert.ok(delivery);
  delivery.roles.find((role) => role.id === "role-planner").model = "planner-model";
  const implementerRole = delivery.roles.find(
    (role) => role.id === "role-implementer"
  );
  implementerRole.model = "writer-model";
  implementerRole.modelOptionId = "writer-model-option";
  const agents = delivery.roles.map((role) => ({
    id: role.agentId,
    name: role.agentId,
    adapter: "stub-acp",
    enabled: true
  }));

  const result = expandTeamToPlan(delivery, { goal: "fix bug" }, agents);
  assert.equal(result.ok, true);
  assert.deepEqual(result.preview.plan.phases[0].steps[0].configOptionOverrides, {
    model: "planner-model"
  });
  assert.equal(result.preview.plan.phases[0].steps[0].model, "planner-model");
  assert.deepEqual(result.preview.plan.phases[1].steps[0].configOptionOverrides, {
    "writer-model-option": "writer-model"
  });
  assert.equal(result.preview.plan.phases[1].steps[0].model, "writer-model");
  assert.equal(result.preview.plan.phases[2].steps[0].configOptionOverrides, undefined);
});

test("builtin workflow teams include the default teams", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const teams = builtinWorkflowTeams();
  assert.deepEqual(
    teams.map((t) => t.id),
    [
      "team-delivery-example",
      "team-root-cause-analysis",
      "team-research-report"
    ]
  );
});

test("root cause team expands to a read-only evidence workflow", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { expandTeamToPlan } = await import(
    "../dist-electron/cli/workflowTeamAdapter.js"
  );
  const teams = builtinWorkflowTeams();
  const rootCause = teams.find((t) => t.id === "team-root-cause-analysis");
  assert.ok(rootCause);
  rootCause.roles[0].model = "evidence-model";
  const agents = rootCause.roles.map((r) => ({
    id: r.agentId,
    name: r.agentId,
    adapter: "stub-acp",
    enabled: true
  }));
  const result = expandTeamToPlan(
    rootCause,
    { goal: "find why image preview failed" },
    agents
  );
  assert.equal(result.ok, true);
  assert.equal(result.preview.teamId, "team-root-cause-analysis");
  assert.equal(result.preview.writeNodeCount, 0);
  assert.deepEqual(
    result.preview.plan.phases.map((phase) => phase.id),
    ["collect-evidence", "challenge-hypothesis", "verify-root-cause", "summarize-findings"]
  );
  const [collect, challenge, verify, summarize] = result.preview.plan.phases;
  assert.deepEqual(collect.steps[0].configOptionOverrides, {
    model: "evidence-model"
  });
  assert.match(collect.steps[0].prompt, /Collect concrete evidence/);
  assert.match(challenge.steps[0].prompt, /challenge the proposed root cause/i);
  assert.match(verify.steps[0].prompt, /verify the root cause/i);
  assert.match(summarize.steps[0].prompt, /timeline/i);
  for (const phase of result.preview.plan.phases) {
    for (const step of phase.steps) {
      assert.notEqual(step.mode, "write");
    }
  }
});

test("research report team expands to a read-only plan", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { expandTeamToPlan } = await import(
    "../dist-electron/cli/workflowTeamAdapter.js"
  );
  const teams = builtinWorkflowTeams();
  const report = teams.find((t) => t.id === "team-research-report");
  assert.ok(report);
  const agents = report.roles.map((r) => ({
    id: r.agentId,
    name: r.agentId,
    adapter: "stub-acp",
    enabled: true
  }));
  const result = expandTeamToPlan(report, { goal: "analyze tomorrow World Cup matches and scores" }, agents);
  assert.equal(result.ok, true);
  assert.equal(result.preview.teamId, "team-research-report");
  assert.equal(result.preview.writeNodeCount, 0);
  assert.equal(result.preview.plan.phases.length, 3);
  const [research, analysis, reportPhase] = result.preview.plan.phases;
  assert.equal(research.steps[0].consumes, undefined);
  assert.deepEqual(analysis.steps[0].consumes, [research.steps[0].id]);
  assert.deepEqual(reportPhase.steps[0].consumes, [analysis.steps[0].id]);
  assert.match(research.steps[0].prompt, /Do not make final judgments or forecasts/);
  assert.match(analysis.steps[0].prompt, /Do not repeat the raw facts/);
  assert.match(analysis.steps[0].prompt, /Use the upstream research context as the primary source/);
  assert.match(reportPhase.steps[0].prompt, /Do not restart broad research/);
  for (const phase of result.preview.plan.phases) {
    for (const step of phase.steps) {
      assert.notEqual(step.mode, "write");
    }
  }
});

test("seeding removes retired builtin workflow teams", () => {
  const src = read("../electron/cli/workflowTeams.ts");
  assert.match(src, /removedBuiltinWorkflowTeamIds/);
  assert.match(src, /team-code-review/);
  assert.match(src, /team-readonly-analysis/);
  assert.match(src, /team-quick-implement/);
  assert.match(src, /team-implement-review-loop/);
  assert.match(src, /DELETE FROM workflow_teams WHERE id = \? AND source = 'builtin'/);
});

test("seeding preserves customized builtin team role agents and models", () => {
  const src = read("../electron/cli/workflowTeams.ts");
  assert.match(src, /function mergeBuiltinRoles/);
  assert.match(src, /savedRole\?\.agentId \?\? role\.agentId/);
  assert.match(src, /savedRole\?\.model \? \{ model: savedRole\.model \} : \{\}/);
  assert.match(src, /modelOptionId: savedRole\.modelOptionId/);
  assert.match(src, /roles:\s*mergeBuiltinRoles\(saved, team\)/);
  assert.match(src, /enabled:\s*saved\.enabled/);
});

test("validateWorkflowTeam rejects unknown agent on required role", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { validateWorkflowTeam } = await import(
    "../dist-electron/cli/workflowTeamValidate.js"
  );
  const teams = builtinWorkflowTeams();
  const delivery = teams.find((t) => t.id === "team-delivery-example");
  const result = validateWorkflowTeam(delivery, []);
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
    "requireApprovalBeforeWrite",
    "newTeamComingSoon",
    "currentModel",
    "defaultModel"
  ]) {
    assert.ok(en.workflow?.[key], `missing en workflow.${key}`);
    assert.ok(zh.workflow?.[key], `missing zh-CN workflow.${key}`);
  }
  for (const key of ["planner", "researcher", "reviewer", "implementer", "verifier", "summarizer", "custom"]) {
    assert.ok(en.workflow.roleKinds?.[key], `missing en workflow.roleKinds.${key}`);
    assert.ok(zh.workflow.roleKinds?.[key], `missing zh-CN workflow.roleKinds.${key}`);
  }
  for (const key of ["research", "review", "write", "verify", "summarize", "approval"]) {
    assert.ok(en.workflow.nodeModes?.[key], `missing en workflow.nodeModes.${key}`);
    assert.ok(zh.workflow.nodeModes?.[key], `missing zh-CN workflow.nodeModes.${key}`);
  }
  const builtinKeys = {
    "team-delivery-example": {
      roles: ["role-planner", "role-implementer", "role-reviewer", "role-verifier", "role-summarizer"],
      nodes: ["plan", "implement", "review", "verify", "summarize"]
    },
    "team-root-cause-analysis": {
      roles: ["role-investigator", "role-skeptic", "role-verifier", "role-summarizer"],
      nodes: ["collect-evidence", "challenge-hypothesis", "verify-root-cause", "summarize-findings"]
    },
    "team-research-report": {
      roles: ["role-researcher", "role-analyst", "role-reporter"],
      nodes: ["research", "analysis", "report"]
    }
  };
  for (const [teamId, keys] of Object.entries(builtinKeys)) {
    for (const roleId of keys.roles) {
      assert.ok(en.workflow.builtinTeams?.[teamId]?.roles?.[roleId], `missing en workflow.builtinTeams.${teamId}.roles.${roleId}`);
      assert.ok(zh.workflow.builtinTeams?.[teamId]?.roles?.[roleId], `missing zh-CN workflow.builtinTeams.${teamId}.roles.${roleId}`);
    }
    for (const nodeId of keys.nodes) {
      assert.ok(en.workflow.builtinTeams?.[teamId]?.nodes?.[nodeId], `missing en workflow.builtinTeams.${teamId}.nodes.${nodeId}`);
      assert.ok(zh.workflow.builtinTeams?.[teamId]?.nodes?.[nodeId], `missing zh-CN workflow.builtinTeams.${teamId}.nodes.${nodeId}`);
    }
  }
});

test("workflow team settings editor localizes builtin role and node labels", () => {
  const src = read("../src/components/Settings/WorkflowTeamEditor.tsx");
  assert.match(src, /workflowTeamRoleLabel\(draft, role, t\)/);
  assert.match(src, /workflow\.roleDescriptions\.\$\{role\.kind\}/);
  assert.match(src, /workflowTeamNodeTitle\(draft, n, t\)/);
  assert.match(src, /workflowTeamNodeMode\(n\.mode, t\)/);
  assert.doesNotMatch(src, /<strong>\{role\.label\}<\/strong>/);
  assert.doesNotMatch(src, /\{n\.mode\}<\/span>/);
});

test("new team button opens the workflow team editor", () => {
  const src = read("../src/components/Settings/WorkflowTeamList.tsx");
  assert.match(src, /onClick=\{onNew\}/);
  assert.doesNotMatch(src, /window\.alert/);
});

test("workflow team editor keeps node config for custom teams only", () => {
  const src = read("../src/components/Settings/WorkflowTeamEditor.tsx");
  assert.match(src, /!\s*isBuiltin\s*&&\s*\(/);
  assert.match(src, /<div className="workflow-node-config">/);
  assert.match(src, /disabled=\{def\.required\}/);
  assert.doesNotMatch(src, /workflow-node-config \$\{isBuiltin \? "readonly" : ""\}/);
  assert.doesNotMatch(src, /aria-disabled=\{isBuiltin\}/);
  assert.doesNotMatch(src, /disabled=\{isBuiltin \|\| def\.required\}/);
  assert.doesNotMatch(src, /setDeliveryNodeEnabled\("approval"/);
});

test("builtin team editor allows changing role agents", () => {
  const src = read("../src/components/Settings/WorkflowTeamEditor.tsx");
  const roleSelectIndex = src.indexOf("<select");
  assert.ok(roleSelectIndex > 0, "missing role agent select");
  const roleSelectBlock = src.slice(roleSelectIndex, src.indexOf("</select>", roleSelectIndex));
  assert.match(roleSelectBlock, /value=\{role\.agentId\}/);
  assert.match(roleSelectBlock, /onChange=\{\(e\) => setRoleAgent\(role\.id, e\.target\.value\)\}/);
  assert.doesNotMatch(roleSelectBlock, /disabled=\{isBuiltin\}/);
  const saveButtonBlock = src.slice(
    src.indexOf('className="primary"'),
    src.indexOf("{t(\"common.save\")}", src.indexOf('className="primary"'))
  );
  assert.doesNotMatch(saveButtonBlock, /disabled=\{isBuiltin\}/);
});

test("workflow team editor loads cached models and saves a model per role", () => {
  const src = read("../src/components/Settings/WorkflowTeamEditor.tsx");
  assert.match(src, /getCachedSessionConfigOptions\(input\)/);
  assert.match(src, /inspectSessionConfigOptions\(input\)/);
  assert.match(src, /value=\{role\.model \?\? ""\}/);
  assert.match(src, /setRoleModel\(\s*role\.id,\s*e\.target\.value,/);
  assert.match(src, /model: undefined, modelOptionId: undefined/);
});

test("workflow runtime forwards step model overrides to cliRun", () => {
  const src = read("../electron/cli/workflowRuntime.ts");
  assert.match(src, /configOptionOverrides: planStep\?\.configOptionOverrides/);
  assert.match(src, /configOptionOverrides: args\.configOptionOverrides/);
});

test("main workspace mounts WorkflowTeamsTab outside Settings", () => {
  const app = read("../src/App.tsx");
  const settings = read("../src/components/Settings/SettingsModal.tsx");
  assert.match(app, /workspaceView === "workflowTeams"/);
  assert.match(app, /<WorkflowTeamsTab/);
  assert.doesNotMatch(settings, /<WorkflowTeamsTab/);
});

test("ChatView uses a non-writing summary role for team follow-up conversations", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /function teamConversationMember/);
  assert.match(src, /role\.kind === "summarizer"/);
  assert.match(src, /!role\.canWrite/);
  assert.doesNotMatch(src, /team\.roles\[0\]\?\.agentId/);
  assert.match(src, /const teamMember = teamConversationMember\(team, members\)/);
  assert.match(src, /teams\.find\(\(tt\) => tt\.id === pendingTeamPreview\.teamId\)/);
  assert.match(src, /member: teamMember/);
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

test("ChatView team onCreateAndSend persists user message attachments", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(
    src,
    /if \(\(!prompt && attachmentsToSend\.length === 0\) \|\| !selectedTeamId\) return;/
  );
  assert.match(src, /attachments: attachmentsToSend/);
  assert.match(src, /savedUser\.attachments/);
  assert.match(src, /goal: composeMessageWithAttachments\(prompt, attachmentsToSend\)/);
});

test("configurable delivery team expands to the unified loop runtime plan", async () => {
  const { expandTeamToPlan } = await import(
    "../dist-electron/cli/workflowTeamAdapter.js"
  );
  const team = {
    id: "team-user-delivery",
    name: "Custom Delivery",
    enabled: true,
    source: "user",
    roles: [
      { id: "role-planner", label: "Planner", kind: "planner", agentId: "planner", required: true, canWrite: false },
      { id: "role-implementer", label: "Implementer", kind: "implementer", agentId: "implementer", required: true, canWrite: true },
      { id: "role-verifier", label: "Verifier", kind: "verifier", agentId: "verifier", required: true, canWrite: false },
      { id: "role-summarizer", label: "Summarizer", kind: "summarizer", agentId: "summarizer", required: true, canWrite: false }
    ],
    template: {
      id: "tpl-configurable-delivery",
      name: "Configurable delivery",
      version: 1,
      nodes: [
        {
          id: "plan",
          title: "Plan",
          mode: "research",
          contract: "plan",
          roleId: "role-planner",
          promptTemplate: "Plan {{goal}}",
          gates: [
            {
              id: "approve-plan",
              type: "manual_approval",
              placement: "after",
              label: "Approve plan",
              blocks: "implement"
            }
          ]
        },
        { id: "implement", title: "Implement", mode: "write", contract: "implement", roleId: "role-implementer", promptTemplate: "Implement {{goal}}" },
        { id: "verify", title: "Verify", mode: "verify", contract: "verify", roleId: "role-verifier", promptTemplate: "Verify {{goal}}" },
        { id: "summarize", title: "Summarize", mode: "summarize", contract: "summarize", roleId: "role-summarizer", promptTemplate: "Summarize {{goal}}" }
      ],
      edges: [],
      startNodeIds: ["plan"],
      finalNodeIds: ["summarize"]
    },
    policy: {
      allowWrites: true,
      requireApprovalBeforeWrite: true,
      requireApprovalAfterReview: false,
      maxParallelReadSteps: 1,
      maxParallelWriteSteps: 1,
      maxLoops: 2,
      stopOnVerifyFailure: false
    },
    createdAt: "",
    updatedAt: ""
  };
  const agents = ["planner", "implementer", "verifier", "summarizer"].map((id) => ({
    id,
    name: id,
    adapter: "stub-acp",
    enabled: true
  }));
  const result = expandTeamToPlan(team, { goal: "fix bug" }, agents);
  assert.equal(result.ok, true);
  assert.equal(result.preview.plan.template, "implement-review-loop");
  assert.deepEqual(
    result.preview.plan.phases.map((phase) => phase.id),
    ["plan", "implement", "verify", "summarize", "loop_or_finish"]
  );
  assert.equal(result.preview.plan.phases[0].gate.type, "manual_approval");
  assert.equal(result.preview.plan.phases[1].gate.type, "all_done");
  assert.equal(result.preview.approvalNodeCount, 1);
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

test("workflow runtime passes conversation attachments to executor", () => {
  const rt = read("../electron/cli/workflowRuntime.ts");
  assert.match(rt, /promptAttachmentsFromConversation/);
  assert.match(rt, /promptAttachments:\s*promptAttachmentsFromConversation\(run\.conversationId\)/);
  assert.match(rt, /listMessages\(conversationId\)/);
  assert.match(rt, /promptAttachments:\s*args\.promptAttachments/);
});

test("team runs persist team metadata for later audit", () => {
  const ipc = read("../electron/cli/workflowIpc.ts");
  const workflows = read("../electron/cli/workflows.ts");
  const electronTypes = read("../electron/cli/workflowTypes.ts");
  const rendererTypes = read("../src/services/workflows/types.ts");
  assert.match(ipc, /teamId:\s*team\.id/);
  assert.match(ipc, /teamSnapshotJson:\s*JSON\.stringify\(team\)/);
  assert.match(ipc, /planVersion:\s*team\.template\.version/);
  assert.match(workflows, /team_id/);
  assert.match(workflows, /teamSnapshotJson/);
  assert.match(electronTypes, /teamId\?: string/);
  assert.match(rendererTypes, /teamId\?: string/);
});

test("workflow step queries are stable when created_at timestamps tie", () => {
  const workflows = read("../electron/cli/workflows.ts");
  assert.match(workflows, /ORDER BY created_at ASC,\s*rowid ASC/s);
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

test("conversationStore refreshes stale running workflow messages on reactivation", () => {
  const src = read("../src/store/conversationStore.ts");
  assert.match(src, /function hasActiveWorkflowMessages/);
  assert.match(src, /message\.workflowRunId && message\.workflowStepRowId/);
  assert.match(src, /message\.status === "running"/);
  assert.match(src, /hasActiveWorkflowMessages\(cachedMessages\)/);
});

test("conversationStore uses a team follow-up context and dedicated session scope", () => {
  const src = read("../src/store/conversationStore.ts");
  assert.match(src, /function buildWorkflowFollowupContext/);
  assert.match(src, /workflow-followup:\$\{run\.id\}:\$\{member\.id\}/);
  assert.match(src, /workflowFollowupContextForRun\(workflowRun\)/);
  assert.match(src, /User follow-up:/);
  assert.match(src, /if \(!workflowRun\) \{/);
  assert.match(src, /latestSessionIdFromMessages/);
});

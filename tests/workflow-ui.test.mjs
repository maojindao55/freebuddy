import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("WorkflowPlanCard renders preview stats and run/cancel actions", () => {
  const src = read("../src/components/Workflows/WorkflowPlanCard.tsx");
  assert.match(src, /workflow-plan-stats/);
  assert.match(src, /workflow-plan-phases/);
  assert.match(src, /workflow-plan-gates/);
  assert.match(src, /workflow-plan-risk/);
  assert.match(src, /gate\.type/);
  assert.match(src, /gate\.reason/);
  assert.match(src, /createAndStart/);
  assert.match(src, /clearPending/);
});

test("WorkflowRunPanel renders running actions and pause/resume/stop", () => {
  const src = read("../src/components/Workflows/WorkflowRunPanel.tsx");
  assert.match(src, /workflow-run-actions/);
  assert.match(src, /workflow\.pause/);
  assert.match(src, /workflow\.resume/);
  assert.match(src, /workflow\.stop/);
  assert.match(src, /setInterval/);
});

test("WorkflowRunPanel shows a progress bar and inline step details", () => {
  const src = read("../src/components/Workflows/WorkflowRunPanel.tsx");
  assert.match(src, /workflow-progress-bar/);
  assert.match(src, /workflow-progress-fill/);
  assert.match(src, /WorkflowPhaseList/);
  // approve gate button merged into the run-actions row
  assert.match(src, /workflow\.approveGate/);
  // separate details-card removed
  assert.doesNotMatch(src, /workflow-step-details-card/);
});

test("WorkflowPhaseList renders inline step details for the selected step", () => {
  const src = read("../src/components/Workflows/WorkflowPhaseList.tsx");
  assert.match(src, /WorkflowStepDetails/);
  assert.match(src, /selectedStepId/);
});

test("WorkflowStepDetails renders failed-state retry", () => {
  const src = read("../src/components/Workflows/WorkflowStepDetails.tsx");
  assert.match(src, /step\.status === "failed"/);
  assert.match(src, /workflow-retry-button/);
});

test("ReviewLoopSummary renders final status text", () => {
  const src = read("../src/components/Workflows/ReviewLoopSummary.tsx");
  assert.match(src, /workflow-summary-card/);
  assert.match(src, /workflow\.status\./);
  assert.match(src, /run\.summary/);
});

test("WorkspacePanel mounts the WorkflowRunPanel", () => {
  const src = read("../src/components/CLI/WorkspacePanel.tsx");
  assert.match(src, /import \{ WorkflowRunPanel \}/);
  assert.match(src, /<WorkflowRunPanel/);
});

test("WorkflowStepRow shows the agent avatar inline", () => {
  const src = read("../src/components/Workflows/WorkflowStepRow.tsx");
  assert.match(src, /AgentAvatar/);
  assert.match(src, /workflow-step-agent-avatar/);
});

test("ChatView wires the team-mode trigger and plan preview", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /useWorkflowStore/);
  assert.match(src, /previewTeam/);
  assert.match(src, /teamMode/);
});

test("new-task page exposes mode tabs and team submit", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /taskMode=\{taskMode\}/);
  assert.match(src, /onTaskMode=\{/);
  assert.match(src, /onSubmit=\{\(\) => void onCreateAndSend\(\)\}/);
  assert.match(src, /new-task-mode-tabs/);
});

test("workflow i18n keys exist in both locales", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  for (const key of ["mode", "normalMode", "run", "cancel", "summary", "progress", "gates", "risk"]) {
    assert.ok(en.workflow?.[key], `missing en workflow.${key}`);
    assert.ok(zh.workflow?.[key], `missing zh-CN workflow.${key}`);
  }
  assert.ok(en.workflow.status?.running);
  assert.ok(zh.workflow.status?.running);
  assert.ok(en.workflow.stepStatus?.failed);
  assert.ok(zh.workflow.stepStatus?.failed);
});

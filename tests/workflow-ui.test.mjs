import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("WorkflowPlanCard renders preview stats and run/cancel actions", () => {
  const src = read("../src/components/Workflows/WorkflowPlanCard.tsx");
  assert.match(src, /workflow-plan-stats/);
  assert.match(src, /workflow-plan-phases/);
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

test("ChatView wires the workflow-mode trigger and plan preview", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /useWorkflowStore/);
  assert.match(src, /previewReviewLoop/);
  assert.match(src, /workflowMode/);
  assert.match(src, /<WorkflowPlanCard/);
});

test("workflow i18n keys exist in both locales", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  for (const key of ["mode", "run", "cancel", "summary", "progress"]) {
    assert.ok(en.workflow?.[key], `missing en workflow.${key}`);
    assert.ok(zh.workflow?.[key], `missing zh-CN workflow.${key}`);
  }
  assert.ok(en.workflow.status?.running);
  assert.ok(zh.workflow.status?.running);
  assert.ok(en.workflow.stepStatus?.failed);
  assert.ok(zh.workflow.stepStatus?.failed);
});

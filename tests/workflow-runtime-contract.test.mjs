import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const runtimeSource = fs.readFileSync(
  new URL("../electron/cli/workflowRuntime.ts", import.meta.url),
  "utf8"
);

test("runtime passes reviewer step status into review_required gate evaluation", () => {
  assert.match(runtimeSource, /reviewerStepStatus/);
  assert.match(runtimeSource, /reviewerStepId/);
});

test("runtime treats non-manual paused gates as blocked rather than manual approval", () => {
  assert.match(runtimeSource, /gateConfig\?\.type === "manual_approval"/);
  assert.match(runtimeSource, /status: "blocked"/);
});

test("runtime blocks write steps before write approval at execute boundary", () => {
  assert.match(runtimeSource, /hasWriteApproval/);
  assert.match(runtimeSource, /step\.mode === "write"/);
  assert.match(runtimeSource, /status: "blocked"/);
});

test("retry clears stale metadata with explicit null patches", () => {
  assert.match(runtimeSource, /summary: null/);
  assert.match(runtimeSource, /resultJson: null/);
  assert.match(runtimeSource, /cliTaskId: null/);
  assert.match(runtimeSource, /startedAt: null/);
  assert.match(runtimeSource, /endedAt: null/);
});

test("stop marks running workflow steps failed so they can be retried", () => {
  assert.match(runtimeSource, /markRunningWorkflowStepsStopped/);
  assert.match(runtimeSource, /step\.status !== "running"/);
  assert.match(runtimeSource, /summary: step\.summary \?\? "Stopped by user\."/);
});

test("retry and resume share the same workflow step reset path", () => {
  assert.match(runtimeSource, /function resetWorkflowStepForRetry/);
  assert.match(runtimeSource, /resetWorkflowStepForRetry\(stepRowId\)/);
});

test("review loop replay clears prior manual approvals before rerunning write steps", () => {
  assert.match(runtimeSource, /approvedPhases\.clear\(\)/);
  assert.match(runtimeSource, /resetWorkflowStepsForLoop\(runId, REVIEW_LOOP_PHASES\)/);
});

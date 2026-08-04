import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const runtimeSource = fs.readFileSync(
  new URL("../electron/cli/workflowRuntime.ts", import.meta.url),
  "utf8"
);
const preloadSource = fs.readFileSync(
  new URL("../electron/preload.ts", import.meta.url),
  "utf8"
);
const conversationStoreSource = fs.readFileSync(
  new URL("../src/store/conversationStore.ts", import.meta.url),
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

test("workflow forwards ACP control events to the owning conversation", () => {
  assert.match(runtimeSource, /broadcastWorkflowEvent/);
  assert.match(runtimeSource, /e\.type === "permission"/);
  assert.match(runtimeSource, /e\.type === "authentication"/);
  assert.match(runtimeSource, /workflow:\/\/event\//);
  assert.match(preloadSource, /onStepEvent\(/);
  assert.match(conversationStoreSource, /workflowEventUnsubscribes = new Map/);
  assert.match(conversationStoreSource, /onRunFinished/);
  assert.match(conversationStoreSource, /removeWorkflowEventSubscription/);
});

test("runtime pauses before entering a manual-gated write phase", () => {
  assert.match(runtimeSource, /function phaseRequiresEntryApproval/);
  assert.match(runtimeSource, /phase\.steps\.some\(\(step\) => step\.mode === "write"\)/);
  assert.match(runtimeSource, /phaseRequiresEntryApproval\(phase\)/);
  assert.match(runtimeSource, /status: "paused"/);
});

test("runtime control paths are limited to the run's conversation owner", () => {
  const createStart = runtimeSource.indexOf("  createPendingRun(input: {");
  const createBody = runtimeSource.slice(
    createStart,
    runtimeSource.indexOf("private seedSteps", createStart)
  );
  assert.match(
    createBody,
    /requireOwnedConversation\(input\.conversationId\)/,
    "a run cannot be attached to another user's conversation"
  );

  assert.match(
    runtimeSource,
    /private callerControlsRun\(runId: string\): boolean \{\s*\n\s*return getWorkflowRun\(runId\) !== undefined;/,
    "the control gate reuses the caller-scoped run lookup"
  );
  for (const method of ["approveGate", "pause", "resume", "stop"]) {
    const start = runtimeSource.indexOf(`  ${method}(runId`);
    assert.notEqual(start, -1, `${method} is defined`);
    assert.match(
      runtimeSource.slice(start, start + 220),
      /callerControlsRun\(runId\)/,
      `${method} checks that the caller controls the run`
    );
  }

  const retryStart = runtimeSource.indexOf("async retryStep(runId");
  assert.match(
    runtimeSource.slice(retryStart, retryStart + 400),
    /getWorkflowSteps\(runId\)\.some\(\(step\) => step\.id === stepRowId\)/,
    "retry rejects a step row from another run"
  );
});

test("runtime reports whether manual gate approval reached an active run", () => {
  assert.match(runtimeSource, /approveGate\(runId: string, phaseId: string\): boolean/);
  assert.match(runtimeSource, /if \(!run\) return false/);
  assert.match(runtimeSource, /run\.approvedPhases\.add\(phaseId\)/);
  assert.match(runtimeSource, /return true/);
});

test("runtime can replay a gated planning phase with user feedback", () => {
  assert.match(runtimeSource, /requestGateChanges/);
  assert.match(runtimeSource, /User requested changes before approval/);
  assert.match(runtimeSource, /Continue from the existing planning context/);
  assert.match(runtimeSource, /void this\.start\(runId\)/);
});

test("runtime resumes gated plan revisions with the existing tool session", () => {
  assert.match(runtimeSource, /Boolean\(step\.toolSessionId\)/);
  assert.match(runtimeSource, /step\.prompt\.includes\("User requested changes before approval:"\)/);
  const requestChangesStart = runtimeSource.indexOf("async requestGateChanges");
  const pauseStart = runtimeSource.indexOf("\n  pause(runId", requestChangesStart);
  assert.notEqual(requestChangesStart, -1);
  assert.notEqual(pauseStart, -1);
  const requestChangesSource = runtimeSource.slice(requestChangesStart, pauseStart);
  assert.doesNotMatch(requestChangesSource, /toolSessionId: null/);
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

test("implement-review replay preserves approved plan gates across review failures", () => {
  const loopStart = runtimeSource.indexOf('if (checkpoint.action === "loop")');
  const loopEnd = runtimeSource.indexOf('if (checkpoint.action === "partial")', loopStart);
  assert.notEqual(loopStart, -1);
  assert.notEqual(loopEnd, -1);
  const implementReviewLoopBranch = runtimeSource.slice(loopStart, loopEnd);
  assert.doesNotMatch(implementReviewLoopBranch, /approvedPhases\.clear\(\)/);
  assert.match(implementReviewLoopBranch, /resetWorkflowStepsForLoop\(runId, IMPLEMENT_REVIEW_LOOP_PHASES\)/);
});

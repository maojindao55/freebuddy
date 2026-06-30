import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadPlanning() {
  const source = fs.readFileSync(
    new URL("../src/services/workflows/planning.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}

const reviewGate = { type: "manual_approval", reason: "approve findings" };
const allDone = { type: "all_done" };

function phases(reviewGateType) {
  return [
    { id: "baseline", title: "Baseline", parallelism: 1, steps: [{ id: "b", title: "b", agentId: "a", mode: "research", prompt: "p" }], gate: allDone },
    { id: "review", title: "Review", parallelism: 1, steps: [{ id: "r", title: "r", agentId: "a", mode: "review", prompt: "p" }], gate: reviewGateType },
    { id: "implement", title: "Implement", parallelism: 1, steps: [{ id: "i", title: "i", agentId: "a", mode: "write", prompt: "p" }], gate: allDone }
  ];
}

test("returns the manual-gate phase when its steps are done and the next phase is pending", async () => {
  const { pendingManualGatePhaseId } = await loadPlanning();
  const result = pendingManualGatePhaseId(phases(reviewGate), [
    { stepId: "b", status: "done" },
    { stepId: "r", status: "done" },
    { stepId: "i", status: "pending" }
  ]);
  assert.equal(result, "review");
});

test("write approval helper ignores completed non-write manual gates", async () => {
  const { pendingWriteApprovalPhaseId } = await loadPlanning();
  const result = pendingWriteApprovalPhaseId(phases(reviewGate), [
    { stepId: "b", status: "done" },
    { stepId: "r", status: "done" },
    { stepId: "i", status: "pending" }
  ]);
  assert.equal(result, undefined);
});

test("returns undefined when no manual gate is pending (all_done gates)", async () => {
  const { pendingManualGatePhaseId } = await loadPlanning();
  const result = pendingManualGatePhaseId(phases(allDone), [
    { stepId: "b", status: "done" },
    { stepId: "r", status: "done" },
    { stepId: "i", status: "pending" }
  ]);
  assert.equal(result, undefined);
});

test("returns undefined when the first step is still pending (nothing gated yet)", async () => {
  const { pendingManualGatePhaseId } = await loadPlanning();
  const result = pendingManualGatePhaseId(phases(reviewGate), [
    { stepId: "b", status: "pending" }
  ]);
  assert.equal(result, undefined);
});

test("returns the earlier manual-gate phase when later steps have not started", async () => {
  const { pendingManualGatePhaseId } = await loadPlanning();
  const result = pendingManualGatePhaseId(phases(reviewGate), [
    { stepId: "b", status: "done" },
    { stepId: "r", status: "done" }
  ]);
  assert.equal(result, "review");
});

test("returns a manual-gated write phase before its write step starts", async () => {
  const { pendingManualGatePhaseId, pendingWriteApprovalPhaseId } = await loadPlanning();
  const planPhases = phases(allDone);
  planPhases[2].gate = reviewGate;
  const result = pendingManualGatePhaseId(planPhases, [
    { stepId: "b", status: "done" },
    { stepId: "r", status: "done" },
    { stepId: "i", status: "pending" }
  ]);
  assert.equal(result, "implement");
  const writeApproval = pendingWriteApprovalPhaseId(planPhases, [
    { stepId: "b", status: "done" },
    { stepId: "r", status: "done" },
    { stepId: "i", status: "pending" }
  ]);
  assert.equal(writeApproval, "implement");
});

test("does not return a manual-gated write phase after the write step starts", async () => {
  const { pendingManualGatePhaseId } = await loadPlanning();
  const planPhases = phases(allDone);
  planPhases[2].gate = reviewGate;
  const result = pendingManualGatePhaseId(planPhases, [
    { stepId: "b", status: "done" },
    { stepId: "r", status: "done" },
    { stepId: "i", status: "running" }
  ]);
  assert.equal(result, undefined);
});

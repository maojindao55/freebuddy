import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../dist-electron/cli/workflowScheduler.js");
const {
  selectRunnableSteps,
  phaseGateSatisfied,
  decideReviewLoop,
  deriveStepSummary,
  extractVisibleStepOutput,
  verifierHasUnresolved
} = mod;

function plan(parallelism, stepSpec) {
  return {
    name: "p",
    goal: "g",
    phases: [
      {
        id: "ph",
        title: "Phase",
        parallelism,
        steps: stepSpec.map((s) => ({
          id: s.id,
          title: s.id,
          agentId: "a",
          mode: s.mode || "research",
          prompt: "p",
          dependsOn: s.dependsOn
        }))
      }
    ]
  };
}

test("starts only unblocked steps (no prior state)", () => {
  const p = plan(1, [{ id: "a" }, { id: "b" }]);
  const next = selectRunnableSteps(p, [], { writeBusy: false });
  assert.deepEqual(next, [{ phaseId: "ph", stepId: "a" }]);
});

test("respects phase parallelism", () => {
  const p = plan(2, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  const next = selectRunnableSteps(p, [], { writeBusy: false });
  assert.deepEqual(next, [{ phaseId: "ph", stepId: "a" }, { phaseId: "ph", stepId: "b" }]);
});

test("never runs two write steps at once", () => {
  const p = plan(3, [{ id: "a", mode: "write" }, { id: "b", mode: "write" }, { id: "c" }]);
  const next = selectRunnableSteps(p, [], {
    writeBusy: false,
    writeApproved: true
  });
  assert.deepEqual(next, [{ phaseId: "ph", stepId: "a" }]);
});

test("writeBusy blocks starting a write step but allows research", () => {
  const p = plan(2, [{ id: "a", mode: "research" }, { id: "b", mode: "write" }]);
  const next = selectRunnableSteps(p, [], { writeBusy: true });
  assert.deepEqual(next, [{ phaseId: "ph", stepId: "a" }]);
});

test("write steps do not start before explicit write approval", () => {
  const p = plan(1, [{ id: "w", mode: "write" }]);
  const next = selectRunnableSteps(p, [], {
    writeBusy: false,
    writeApproved: false
  });
  assert.deepEqual(next, []);
});

test("write steps start after explicit write approval", () => {
  const p = plan(1, [{ id: "w", mode: "write" }]);
  const next = selectRunnableSteps(p, [], {
    writeBusy: false,
    writeApproved: true
  });
  assert.deepEqual(next, [{ phaseId: "ph", stepId: "w" }]);
});

test("dependencies block steps until satisfied", () => {
  const p = plan(3, [{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
  let next = selectRunnableSteps(p, [], { writeBusy: false });
  assert.deepEqual(next, [{ phaseId: "ph", stepId: "a" }]);
  // a done -> b runnable, phase not yet fully done
  next = selectRunnableSteps(p, [{ stepId: "a", status: "done" }], { writeBusy: false });
  assert.deepEqual(next, [{ phaseId: "ph", stepId: "b" }]);
});

test("moves to next phase only when current phase is terminal", () => {
  const twoPhasePlan = {
    name: "p", goal: "g",
    phases: [
      { id: "p1", title: "1", parallelism: 1, steps: [{ id: "a", title: "a", agentId: "x", mode: "research", prompt: "p" }] },
      { id: "p2", title: "2", parallelism: 1, steps: [{ id: "b", title: "b", agentId: "x", mode: "research", prompt: "p" }] }
    ]
  };
  let next = selectRunnableSteps(twoPhasePlan, [], { writeBusy: false });
  assert.deepEqual(next, [{ phaseId: "p1", stepId: "a" }]);
  next = selectRunnableSteps(twoPhasePlan, [{ stepId: "a", status: "done" }], { writeBusy: false });
  assert.deepEqual(next, [{ phaseId: "p2", stepId: "b" }]);
});

test("manual gate pauses execution when not approved", () => {
  const r1 = phaseGateSatisfied(
    { type: "manual_approval", reason: "confirm" },
    { approvedPhases: new Set(), phaseId: "p1" }
  );
  assert.equal(r1.pause, true);
  assert.equal(r1.pass, false);
  const r2 = phaseGateSatisfied(
    { type: "manual_approval", reason: "confirm" },
    { approvedPhases: new Set(["p1"]), phaseId: "p1" }
  );
  assert.equal(r2.pause, false);
  assert.equal(r2.pass, true);
});

test("all_done gate always passes", () => {
  const r = phaseGateSatisfied({ type: "all_done" }, { approvedPhases: new Set(), phaseId: "p1" });
  assert.equal(r.pass, true);
});

test("review_required gate passes when reviewer step is done", () => {
  const r = phaseGateSatisfied(
    { type: "review_required", reviewerStepId: "rev" },
    { approvedPhases: new Set(), phaseId: "p1", reviewerStepStatus: "done" }
  );
  assert.equal(r.pass, true);
  assert.equal(r.pause, false);
});

test("review_required gate pauses when reviewer step is not done", () => {
  const r = phaseGateSatisfied(
    { type: "review_required", reviewerStepId: "rev" },
    { approvedPhases: new Set(), phaseId: "p1", reviewerStepStatus: "running" }
  );
  assert.equal(r.pass, false);
  assert.equal(r.pause, true);
});

test("decideReviewLoop finishes when no unresolved issues", () => {
  assert.equal(decideReviewLoop("done", false, 0, 3), "finish");
});

test("decideReviewLoop loops while under maxLoops", () => {
  assert.equal(decideReviewLoop("done", true, 0, 3), "loop");
  assert.equal(decideReviewLoop("done", true, 2, 3), "partial");
});

test("decideReviewLoop returns partial when verifier did not finish", () => {
  assert.equal(decideReviewLoop("failed", true, 0, 3), "partial");
});

test("deriveStepSummary concatenates assistant text chunks", () => {
  const s = deriveStepSummary([
    { kind: "text", content: "first" },
    { kind: "tool-call" },
    { kind: "text", content: "  final answer here  " }
  ]);
  assert.equal(s, "first\nfinal answer here");
});

test("deriveStepSummary falls back to tool count", () => {
  const s = deriveStepSummary([{ kind: "tool-call" }, { kind: "tool-result" }]);
  assert.equal(s, "Completed 2 tool actions.");
});

test("deriveStepSummary ignores hidden thinking and tool payloads", () => {
  const s = deriveStepSummary([
    { kind: "thinking", content: "I need to search first." },
    { kind: "tool-call", input: { query: "private search payload" } },
    { kind: "text", content: "## Evidence\n- One confirmed match tomorrow." }
  ]);
  assert.equal(s, "## Evidence\n- One confirmed match tomorrow.");
});

test("extractVisibleStepOutput keeps full assistant output for downstream context", () => {
  const visible = extractVisibleStepOutput([
    { kind: "thinking", content: "I should search." },
    { kind: "tool-call", input: { query: "noise" } },
    { kind: "text", content: "A".repeat(450) },
    { kind: "text", content: "\nFinal evidence bullet." }
  ]);
  assert.equal(visible.includes("I should search"), false);
  assert.equal(visible.includes("query"), false);
  assert.equal(visible.length, 473);
  assert.match(visible, /Final evidence bullet\.$/);
});

test("verifierHasUnresolved parses the UNRESOLVED marker", () => {
  assert.equal(verifierHasUnresolved("UNRESOLVED: 2"), true);
  assert.equal(verifierHasUnresolved("UNRESOLVED: 0"), false);
  assert.equal(verifierHasUnresolved(undefined), false);
});

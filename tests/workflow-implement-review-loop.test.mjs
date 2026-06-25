import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const scheduler = await import("../dist-electron/cli/workflowScheduler.js");
const {
  decideImplementReviewLoop,
  reviewerHasFail,
  augmentPromptWithConsumedSummaries
} = scheduler;

const { buildImplementReviewLoopPlan } = await import(
  "../dist-electron/cli/workflowTemplates.js"
);

const agents = {
  implementer: {
    id: "cli-claude-agent-acp",
    name: "ClaudeCode",
    adapter: "claude-agent-acp",
    enabled: true
  },
  reviewer: {
    id: "cli-codex-acp",
    name: "Codex",
    adapter: "codex-acp",
    enabled: true
  }
};

test("buildImplementReviewLoopPlan produces implement → review → loop_or_finish", () => {
  const p = buildImplementReviewLoopPlan({
    goal: "add retry",
    implementer: agents.implementer,
    reviewer: agents.reviewer
  });
  assert.equal(p.template, "implement-review-loop");
  assert.equal(p.maxLoops, 5);
  assert.deepEqual(
    p.phases.map((ph) => ph.id),
    ["implement", "review", "loop_or_finish"]
  );
  const impl = p.phases.find((ph) => ph.id === "implement");
  const review = p.phases.find((ph) => ph.id === "review");
  assert.equal(impl.steps[0].agentId, agents.implementer.id);
  assert.equal(impl.steps[0].mode, "write");
  assert.equal(review.steps[0].agentId, agents.reviewer.id);
  assert.equal(review.steps[0].mode, "review");
  assert.match(review.steps[0].prompt, /REVIEW_STATUS: PASS/);
  assert.match(review.steps[0].prompt, /REVIEW_STATUS: FAIL/);
});

test("reviewerHasFail detects FAIL marker", () => {
  assert.equal(reviewerHasFail("Looks good\nREVIEW_STATUS: PASS"), false);
  assert.equal(reviewerHasFail("Issues found\nREVIEW_STATUS: FAIL"), true);
  assert.equal(reviewerHasFail(undefined), false);
});

test("decideImplementReviewLoop finishes on PASS", () => {
  assert.equal(
    decideImplementReviewLoop("done", "REVIEW_STATUS: PASS", 0, 5),
    "finish"
  );
});

test("decideImplementReviewLoop loops on FAIL while under maxLoops", () => {
  assert.equal(
    decideImplementReviewLoop("done", "REVIEW_STATUS: FAIL", 0, 5),
    "loop"
  );
  assert.equal(
    decideImplementReviewLoop("done", "REVIEW_STATUS: FAIL", 4, 5),
    "partial"
  );
});

test("decideImplementReviewLoop returns partial when reviewer failed", () => {
  assert.equal(
    decideImplementReviewLoop("failed", "REVIEW_STATUS: FAIL", 0, 5),
    "partial"
  );
});

test("augmentPromptWithConsumedSummaries appends upstream summaries", () => {
  const out = augmentPromptWithConsumedSummaries(
    "Implement the change.",
    ["review-changes"],
    new Map([
      [
        "review-changes",
        { stepId: "review-changes", title: "Review", summary: "Fix error handling" }
      ]
    ])
  );
  assert.match(out, /Implement the change/);
  assert.match(out, /Fix error handling/);
});

test("expandTeamToPlan uses implement-review-loop template for loop team", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { expandTeamToPlan } = await import(
    "../dist-electron/cli/workflowTeamAdapter.js"
  );
  const team = builtinWorkflowTeams().find(
    (t) => t.id === "team-implement-review-loop"
  );
  assert.ok(team);
  const agentRefs = team.roles.map((r) => ({
    id: r.agentId,
    name: r.agentId,
    adapter: "stub-acp",
    enabled: true
  }));
  const result = expandTeamToPlan(team, { goal: "fix auth" }, agentRefs);
  assert.equal(result.ok, true);
  assert.equal(result.preview.plan.template, "implement-review-loop");
  assert.equal(result.preview.plan.phases.length, 3);
});

test("runtime handles implement-review-loop template", () => {
  const src = fs.readFileSync(
    new URL("../electron/cli/workflowRuntime.ts", import.meta.url),
    "utf8"
  );
  assert.match(src, /implement-review-loop/);
  assert.match(src, /decideImplementReviewLoop/);
  assert.match(src, /IMPLEMENT_REVIEW_LOOP_PHASES/);
});

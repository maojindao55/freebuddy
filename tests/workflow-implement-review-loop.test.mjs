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

test("buildImplementReviewLoopPlan enforces at least two cycles", () => {
  const p = buildImplementReviewLoopPlan({
    goal: "x",
    implementer: agents.implementer,
    reviewer: agents.reviewer,
    maxLoops: 1
  });
  assert.equal(p.maxLoops, 2);
});

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

test("deriveStepSummary preserves REVIEW_STATUS FAIL when body is truncated", async () => {
  const { deriveStepSummary } = scheduler;
  const long = `${"issue ".repeat(120)}REVIEW_STATUS: FAIL`;
  const summary = deriveStepSummary([{ kind: "text", content: long }]);
  assert.match(summary, /REVIEW_STATUS:\s*FAIL/i);
  assert.equal(decideImplementReviewLoop("done", summary, 0, 5), "loop");
});

test("deriveStepSummary scans all text chunks for review status", async () => {
  const { deriveStepSummary } = scheduler;
  const summary = deriveStepSummary([
    { kind: "text", content: "Long findings paragraph. " },
    { kind: "tool-call" },
    { kind: "text", content: "REVIEW_STATUS: FAIL" }
  ]);
  assert.match(summary, /REVIEW_STATUS:\s*FAIL/i);
  assert.equal(decideImplementReviewLoop("done", summary, 0, 5), "loop");
});

test("resolveReviewDecisionText prefers full resultJson over truncated summary", async () => {
  const { resolveReviewDecisionText } = scheduler;
  const text = resolveReviewDecisionText("truncated…", JSON.stringify({
    items: [{ kind: "text", content: `${"x".repeat(600)}\nREVIEW_STATUS: FAIL` }]
  }));
  assert.match(text ?? "", /REVIEW_STATUS:\s*FAIL/i);
  assert.equal(decideImplementReviewLoop("done", text, 0, 5), "loop");
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
    decideImplementReviewLoop("failed", "REVIEW_STATUS: FAIL", 0, 5),
    "loop"
  );
  assert.equal(
    decideImplementReviewLoop("done", "REVIEW_STATUS: FAIL", 4, 5),
    "partial"
  );
});

test("decideImplementReviewLoop requires maxLoops >= 2 for a retry", () => {
  assert.equal(
    decideImplementReviewLoop("done", "REVIEW_STATUS: FAIL", 0, 1),
    "partial"
  );
  assert.equal(
    decideImplementReviewLoop("done", "REVIEW_STATUS: FAIL", 0, 2),
    "loop"
  );
});

test("extractReviewStatus reads markers from fragmented append chunks", async () => {
  const { collectDecisionTextFromItems, extractReviewStatus } = scheduler;
  const text = collectDecisionTextFromItems([
    { kind: "text", content: "RE", append: true, messageId: "m1", role: "assistant" },
    { kind: "text", content: "VIEW_STATUS: ", append: true, messageId: "m1", role: "assistant" },
    { kind: "text", content: "FAIL", append: true, messageId: "m1", role: "assistant" }
  ]);
  assert.equal(extractReviewStatus(text), "FAIL");
  assert.equal(decideImplementReviewLoop("done", text, 0, 5), "loop");
});

test("extractReviewStatus supports alternate markers for tool-heavy agents", async () => {
  const { extractReviewStatus } = scheduler;
  assert.equal(extractReviewStatus("done <<<REVIEW_FAIL>>>"), "FAIL");
  assert.equal(extractReviewStatus("ok [[REVIEW:PASS]]"), "PASS");
});

test("collectDecisionTextFromItems reads content-block and tool-call output", async () => {
  const { collectDecisionTextFromItems, extractReviewStatus } = scheduler;
  const text = collectDecisionTextFromItems([
    {
      kind: "tool-call",
      id: "t1",
      tool: "review",
      output: "Issues found",
      toolOutputs: [
        {
          kind: "content-block",
          blockType: "resource",
          text: "REVIEW_STATUS: FAIL"
        }
      ]
    }
  ]);
  assert.equal(extractReviewStatus(text), "FAIL");
});

test("decideImplementReviewLoop returns partial when reviewer failed without status", () => {
  assert.equal(
    decideImplementReviewLoop("failed", "Tool error", 0, 5),
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
  assert.match(src, /isImplementReviewLoopPlan/);
  assert.match(src, /decideImplementReviewLoop/);
  assert.match(src, /IMPLEMENT_REVIEW_LOOP_PHASES/);
});

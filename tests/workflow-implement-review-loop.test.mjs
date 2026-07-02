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

test("build review plan can verify and summarize after review passes", () => {
  const verifier = {
    id: "cli-opencode-acp",
    name: "OpenCode",
    adapter: "opencode-acp",
    enabled: true
  };
  const summarizer = {
    id: "cli-codex-acp",
    name: "Codex",
    adapter: "codex-acp",
    enabled: true
  };
  const p = buildImplementReviewLoopPlan({
    goal: "add retry",
    implementer: agents.implementer,
    reviewer: agents.reviewer,
    verifier,
    summarizer
  });
  assert.deepEqual(
    p.phases.map((ph) => ph.id),
    ["implement", "review", "verify", "summarize", "loop_or_finish"]
  );
  const verify = p.phases.find((ph) => ph.id === "verify");
  const summarize = p.phases.find((ph) => ph.id === "summarize");
  assert.equal(verify.steps[0].agentId, verifier.id);
  assert.equal(verify.steps[0].mode, "verify");
  assert.deepEqual(verify.steps[0].consumes, ["review-changes"]);
  assert.match(verify.steps[0].prompt, /UNRESOLVED: <count>/);
  assert.equal(summarize.steps[0].agentId, summarizer.id);
  assert.equal(summarize.steps[0].mode, "summarize");
  assert.deepEqual(summarize.steps[0].consumes, ["verify-changes"]);
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

test("augmentPromptWithConsumedSummaries prefers visible output over compact summary", () => {
  const out = augmentPromptWithConsumedSummaries(
    "Analyze the research.",
    ["research-step"],
    new Map([
      [
        "research-step",
        {
          stepId: "research-step",
          title: "Research",
          summary: "I need to search first.",
          output: `${"confirmed fact ".repeat(80)}final evidence`
        }
      ]
    ])
  );
  assert.match(out, /confirmed fact/);
  assert.match(out, /final evidence/);
  assert.doesNotMatch(out, /I need to search first/);
});

test("runtime exposes continueImplementReview for max-loop FAIL follow-up", () => {
  const src = fs.readFileSync(
    new URL("../electron/cli/workflowRuntime.ts", import.meta.url),
    "utf8"
  );
  assert.match(src, /continueImplementReview/);
  assert.match(src, /maxLoops: nextMaxLoops/);
  assert.match(src, /resetWorkflowStepsForLoop\(runId, IMPLEMENT_REVIEW_LOOP_PHASES\)/);
});

test("official delivery example uses configurable nodes with review loop runtime", async () => {
  const { builtinWorkflowTeams } = await import(
    "../dist-electron/cli/workflowTeamBuiltins.js"
  );
  const { expandTeamToPlan } = await import(
    "../dist-electron/cli/workflowTeamAdapter.js"
  );
  const team = builtinWorkflowTeams().find(
    (t) => t.id === "team-delivery-example"
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
  assert.deepEqual(
    result.preview.plan.phases.map((phase) => phase.id),
    ["plan", "implement", "review", "verify", "summarize", "loop_or_finish"]
  );
  assert.equal(result.preview.plan.phases[0].gate.type, "manual_approval");
  assert.equal(result.preview.plan.phases[1].gate.type, "all_done");
  assert.deepEqual(
    result.preview.routeSummary.map((route) => route.nodeId),
    ["plan", "implement", "review", "verify", "summarize"]
  );
});

test("runtime loops build review when verification has unresolved issues", () => {
  const src = fs.readFileSync(
    new URL("../electron/cli/workflowRuntime.ts", import.meta.url),
    "utf8"
  );
  assert.match(src, /evaluateImplementReviewCheckpoint/);
  assert.match(src, /stepId === VERIFY_CHANGES_STEP_ID/);
  assert.match(src, /verifierHasUnresolved\(verifier\?\.summary\)/);
  assert.match(src, /verification feedback from the previous round/);
});

test("runtime resumes gated plan revisions and implementer review-loop sessions", () => {
  const src = fs.readFileSync(
    new URL("../electron/cli/workflowRuntime.ts", import.meta.url),
    "utf8"
  );
  assert.match(src, /function shouldResumeWorkflowStep/);
  assert.match(src, /Boolean\(step\.toolSessionId\)/);
  assert.match(src, /step\.prompt\.includes\("User requested changes before approval:"\)/);
  assert.match(src, /step\.stepId === IMPLEMENT_REVIEW_STEP_ID/);
  assert.match(src, /const resumeToolSession = shouldResumeWorkflowStep\(plan, step\)/);
  assert.match(src, /toolSessionScope: args\.toolSessionScope/);
  assert.match(src, /toolSessionId: args\.toolSessionId/);
  assert.match(src, /resumeToolSession: args\.resumeToolSession/);
});

test("workflow steps persist reusable tool session ids separately from task ids", () => {
  const db = fs.readFileSync(
    new URL("../electron/cli/db.ts", import.meta.url),
    "utf8"
  );
  const workflows = fs.readFileSync(
    new URL("../electron/cli/workflows.ts", import.meta.url),
    "utf8"
  );
  const electronTypes = fs.readFileSync(
    new URL("../electron/cli/workflowTypes.ts", import.meta.url),
    "utf8"
  );
  const rendererTypes = fs.readFileSync(
    new URL("../src/services/workflows/types.ts", import.meta.url),
    "utf8"
  );
  assert.match(db, /tool_session_id TEXT/);
  assert.match(db, /ALTER TABLE workflow_steps ADD COLUMN tool_session_id TEXT/);
  assert.match(workflows, /toolSessionId: r\.tool_session_id/);
  assert.match(workflows, /tool_session_id = \?/);
  assert.match(electronTypes, /toolSessionId\?: string/);
  assert.match(rendererTypes, /toolSessionId\?: string/);
});

test("findResumePhaseIndex skips finished phases", async () => {
  const { findResumePhaseIndex } = await import(
    "../dist-electron/cli/workflowScheduler.js"
  );
  const plan = {
    name: "p",
    goal: "g",
    phases: [
      {
        id: "implement",
        title: "Implement",
        parallelism: 1,
        steps: [{ id: "implement-changes", title: "i", agentId: "a", mode: "write", prompt: "p" }]
      },
      {
        id: "review",
        title: "Review",
        parallelism: 1,
        steps: [{ id: "review-changes", title: "r", agentId: "a", mode: "review", prompt: "p" }]
      }
    ]
  };
  const idx = findResumePhaseIndex(plan, [
    { stepId: "implement-changes", phaseId: "implement", status: "done" },
    { stepId: "review-changes", phaseId: "review", status: "failed" }
  ]);
  assert.equal(idx, 1);
});

test("resumableStepRowIds returns failed, blocked, and stale running steps in phase", async () => {
  const { resumableStepRowIds } = await import(
    "../dist-electron/cli/workflowScheduler.js"
  );
  const ids = resumableStepRowIds("review", [
    { id: "row-1", phaseId: "implement", status: "done" },
    { id: "row-2", phaseId: "review", status: "failed" },
    { id: "row-3", phaseId: "review", status: "blocked" },
    { id: "row-4", phaseId: "review", status: "running" }
  ]);
  assert.deepEqual(ids, ["row-2", "row-3", "row-4"]);
});

test("runtime prepares blocked runs before resume", () => {
  const src = fs.readFileSync(
    new URL("../electron/cli/workflowRuntime.ts", import.meta.url),
    "utf8"
  );
  assert.match(src, /prepareInactiveRunForResume/);
  assert.match(src, /findResumePhaseIndex/);
});

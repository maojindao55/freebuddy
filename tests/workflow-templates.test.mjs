import test from "node:test";
import assert from "node:assert/strict";

const { buildReviewLoopPlan, reviewLoopCoordinatorPrompt } = await import(
  "../dist-electron/cli/workflowTemplates.js"
);

const agents = {
  reviewer: { id: "cli-codex-acp", name: "Codex", adapter: "codex-acp", enabled: true },
  implementer: { id: "cli-claude-agent-acp", name: "ClaudeCode", adapter: "claude-agent-acp", enabled: true },
  verifier: { id: "cli-opencode-acp", name: "OpenCode", adapter: "opencode-acp", enabled: true }
};

test("buildReviewLoopPlan produces the five default phases", () => {
  const p = buildReviewLoopPlan({
    goal: "fix bug",
    reviewer: agents.reviewer,
    implementer: agents.implementer,
    verifier: agents.verifier
  });
  assert.equal(p.phases.length, 5);
  assert.deepEqual(
    p.phases.map((ph) => ph.id),
    ["baseline", "review", "implement", "verify", "loop_or_finish"]
  );
  assert.equal(p.template, "review-loop");
  assert.equal(p.maxLoops, 3);
});

test("review phase carries the manual approval gate", () => {
  const p = buildReviewLoopPlan({
    goal: "x",
    reviewer: agents.reviewer,
    implementer: agents.implementer,
    verifier: agents.verifier
  });
  const review = p.phases.find((ph) => ph.id === "review");
  assert.equal(review.gate.type, "manual_approval");
});

test("implement phase contains exactly one write step", () => {
  const p = buildReviewLoopPlan({
    goal: "x",
    reviewer: agents.reviewer,
    implementer: agents.implementer,
    verifier: agents.verifier
  });
  const impl = p.phases.find((ph) => ph.id === "implement");
  const writes = impl.steps.filter((s) => s.mode === "write");
  assert.equal(writes.length, 1);
});

test("coordinator prompt includes the agent list and goal", () => {
  const prompt = reviewLoopCoordinatorPrompt({
    goal: "ship it",
    agents: Object.values(agents),
    targetPaths: ["src/a.ts"]
  });
  assert.match(prompt, /ship it/);
  assert.match(prompt, /cli-codex-acp \(Codex, codex-acp\)/);
  assert.match(prompt, /src\/a.ts/);
  assert.match(prompt, /Return ONLY the JSON object/);
});

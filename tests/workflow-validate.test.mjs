import test from "node:test";
import assert from "node:assert/strict";

const { validateWorkflowPlan } = await import(
  "../dist-electron/cli/workflowValidate.js"
);

const agents = [
  { id: "cli-codex-acp", name: "Codex", adapter: "codex-acp", enabled: true },
  { id: "cli-claude-agent-acp", name: "ClaudeCode", adapter: "claude-agent-acp", enabled: true },
  { id: "cli-disabled", name: "Off", adapter: "codex-acp", enabled: false }
];

function basePlan(overrides = {}) {
  return {
    name: "Review Loop",
    goal: "Fix the bug",
    phases: [
      {
        id: "p1",
        title: "Phase 1",
        parallelism: 1,
        steps: [
          {
            id: "s1",
            title: "Research",
            agentId: "cli-codex-acp",
            mode: "research",
            prompt: "Look around"
          }
        ],
        gate: { type: "all_done" }
      }
    ],
    ...overrides
  };
}

test("accepts a valid plan", () => {
  const r = validateWorkflowPlan(basePlan(), agents);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("rejects empty plan", () => {
  const r = validateWorkflowPlan(null, agents);
  assert.equal(r.ok, false);
});

test("rejects unknown or disabled agents", () => {
  const plan = basePlan({
    phases: [
      {
        id: "p1",
        title: "x",
        parallelism: 1,
        steps: [
          { id: "s1", title: "x", agentId: "ghost", mode: "research", prompt: "p" },
          { id: "s2", title: "x", agentId: "cli-disabled", mode: "research", prompt: "p" }
        ]
      }
    ]
  });
  const r = validateWorkflowPlan(plan, agents);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /ghost/);
  assert.match(r.errors.join(";"), /cli-disabled/);
});

test("rejects duplicate ids", () => {
  const plan = basePlan({
    phases: [
      { id: "dup", title: "x", parallelism: 1, steps: [{ id: "s1", title: "x", agentId: "cli-codex-acp", mode: "research", prompt: "p" }] },
      { id: "dup", title: "x", parallelism: 1, steps: [{ id: "s1", title: "x", agentId: "cli-codex-acp", mode: "research", prompt: "p" }] }
    ]
  });
  const r = validateWorkflowPlan(plan, agents);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /duplicate phase id "dup"/);
  assert.match(r.errors.join(";"), /duplicate step id "s1"/);
});

test("rejects bad dependencies (unknown + later)", () => {
  const plan = basePlan({
    phases: [
      {
        id: "p1", title: "x", parallelism: 1,
        steps: [
          { id: "a", title: "x", agentId: "cli-codex-acp", mode: "research", prompt: "p", dependsOn: ["b", "ghost"] },
          { id: "b", title: "x", agentId: "cli-codex-acp", mode: "research", prompt: "p" }
        ]
      }
    ]
  });
  const r = validateWorkflowPlan(plan, agents);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /unknown step "ghost"/);
  assert.match(r.errors.join(";"), /depends on later step "b"/);
});

test("rejects empty prompts", () => {
  const plan = basePlan({
    phases: [{ id: "p1", title: "x", parallelism: 1, steps: [{ id: "s1", title: "x", agentId: "cli-codex-acp", mode: "research", prompt: "   " }] }]
  });
  assert.equal(validateWorkflowPlan(plan, agents).ok, false);
});

test("rejects parallelism out of range", () => {
  const plan = basePlan({
    phases: [{ id: "p1", title: "x", parallelism: 5, steps: [{ id: "s1", title: "x", agentId: "cli-codex-acp", mode: "research", prompt: "p" }] }]
  });
  assert.equal(validateWorkflowPlan(plan, agents).ok, false);
});

test("rejects parallel write steps in a phase", () => {
  const plan = basePlan({
    phases: [
      {
        id: "p1", title: "x", parallelism: 2,
        steps: [
          { id: "w1", title: "x", agentId: "cli-codex-acp", mode: "write", prompt: "p" },
          { id: "w2", title: "x", agentId: "cli-claude-agent-acp", mode: "write", prompt: "p" }
        ]
      }
    ]
  });
  const r = validateWorkflowPlan(plan, agents);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /more than one write step/);
});

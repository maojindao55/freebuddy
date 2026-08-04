import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

async function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const dbModule = await import("../dist-electron/cli/db.js");
  dbModule.migrate(db);
  dbModule.setDbForTest(db);
  const workflows = await import("../dist-electron/cli/workflows.js");
  const { saveToolSession } = await import("../dist-electron/cli/store.js");
  const { WorkflowRuntime } = await import("../dist-electron/cli/workflowRuntime.js");
  return { db, dbModule, workflows, saveToolSession, WorkflowRuntime };
}

function plan() {
  return {
    name: "Compression reliability",
    goal: "preserve a bounded implementation handoff",
    template: "implement-review-loop",
    phases: [
      {
        id: "implement",
        title: "Implement",
        parallelism: 1,
        steps: [
          {
            id: "implement-changes",
            title: "Implement changes",
            agentId: "implementer",
            mode: "write",
            prompt: "Make the requested change.",
            skillIds: ["selected-skill"]
          }
        ]
      }
    ]
  };
}

function makeRuntime({ WorkflowRuntime, saveToolSession }, summaryRun, timeoutMs) {
  const calls = [];
  const cancelled = [];
  const executor = {
    async run(args) {
      calls.push(args);
      if (args.approvalMode === "deny") return summaryRun(args);
      saveToolSession(
        args.agentId,
        args.toolSessionScope,
        args.adapter,
        "upstream-tool-session"
      );
      args.onEvent({
        type: "items",
        items: [{ kind: "text", content: `changed files\n${"detail ".repeat(2_000)}` }]
      });
      args.onEvent({ type: "done", exitCode: 0 });
    },
    cancel(sessionId) {
      cancelled.push(sessionId);
      return true;
    }
  };
  return {
    runtime: new WorkflowRuntime({
      executor,
      contextSummaryTimeoutMs: timeoutMs,
      resolveAgent: (id) =>
        id === "implementer"
          ? {
              adapter: "codex-acp",
              agentName: "Implementer",
              skillIds: ["agent-default"]
            }
          : undefined
    }),
    calls,
    cancelled
  };
}

async function runImplementation(ctx, summaryRun, timeoutMs) {
  const { runtime, calls, cancelled } = makeRuntime(ctx, summaryRun, timeoutMs);
  const created = runtime.createPendingRun({
    plan: plan(),
    agents: [
      {
        id: "implementer",
        name: "Implementer",
        adapter: "codex-acp",
        enabled: true
      }
    ]
  });
  assert.equal(created.ok, true);
  await runtime.start(created.run.id);
  return { runtime, runId: created.run.id, calls, cancelled };
}

test("WorkflowRuntime persists a same-session summary and rolls implementation over", async (t) => {
  if (!bindingAvailable) return t.skip("better-sqlite3 native binding unavailable");
  const ctx = await setup();
  t.after(() => {
    ctx.dbModule.setDbForTest(null);
    ctx.db.close();
  });

  const result = await runImplementation(ctx, async (args) => {
    assert.equal(args.toolSessionId, "upstream-tool-session");
    assert.equal(args.resumeToolSession, true);
    assert.equal(args.approvalMode, "deny");
    assert.deepEqual(args.skillIds, ["selected-skill"]);
    args.onEvent({
      type: "items",
      items: [
        {
          kind: "text",
          content: "WORKFLOW_CONTEXT_SUMMARY\nSTEP_OUTCOME\nImplemented safely.\nWORKFLOW_STATUS\nDone"
        }
      ]
    });
    args.onEvent({ type: "done", exitCode: 0 });
  });

  const step = result.runtime.getSteps(result.runId)[0];
  const stored = JSON.parse(step.resultJson);
  assert.equal(step.status, "done");
  assert.equal(step.toolSessionId, undefined);
  assert.match(stored.contextSummary, /WORKFLOW_CONTEXT_SUMMARY/);
  assert.ok(stored.items[0].content.length > 12_000, "raw output remains stored");
  assert.equal(result.calls.filter((call) => call.approvalMode === "deny").length, 1);

  result.runtime.prepareImplementReviewLoopReplay(result.runId, plan(), "review feedback");
  const replay = result.runtime.getSteps(result.runId)[0];
  assert.equal(replay.toolSessionId, undefined);
  assert.match(replay.prompt, /Previous implementation handoff:/);
  assert.match(replay.prompt, /Implemented safely\./);
});

test("WorkflowRuntime times out compression, cancels it, and persists a fallback handoff", async (t) => {
  if (!bindingAvailable) return t.skip("better-sqlite3 native binding unavailable");
  const ctx = await setup();
  t.after(() => {
    ctx.dbModule.setDbForTest(null);
    ctx.db.close();
  });

  const result = await runImplementation(
    ctx,
    async () => new Promise(() => {}),
    1
  );
  const step = result.runtime.getSteps(result.runId)[0];
  const stored = JSON.parse(step.resultJson);
  assert.equal(step.status, "done");
  assert.equal(step.toolSessionId, undefined);
  assert.match(stored.contextSummary, /WORKFLOW_CONTEXT_SUMMARY/);
  assert.match(stored.contextSummary, /Same-session compression was unavailable/);
  assert.ok(stored.items[0].content.length > 12_000, "raw output remains stored");
  assert.equal(result.cancelled.length, 1);

  result.runtime.prepareImplementReviewLoopReplay(result.runId, plan(), "review feedback");
  const replay = result.runtime.getSteps(result.runId)[0];
  assert.match(replay.prompt, /Previous implementation handoff:/);
  assert.match(replay.prompt, /Same-session compression was unavailable/);
});

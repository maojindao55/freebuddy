import test from "node:test";
import assert from "node:assert/strict";

const { WorkflowRuntime, createMemoryWorkflowRepository } = await import(
  "../packages/workflow-runtime/dist/index.js"
);

function fakePorts(repository) {
  const events = [];
  return {
    repository,
    events: { publish: (channel, payload) => events.push({ channel, payload }) },
    telemetry: { track() {} },
    language: { getLanguage: () => "en", applyPreference: (prompt) => prompt },
    conversations: {
      listMessages: () => [],
      appendMessage: () => undefined,
      requireOwned: () => true
    },
    resolveAgent: (id) =>
      id
        ? { adapter: "codex-acp", agentName: id, skillIds: [] }
        : undefined,
    executor: {
      async run(args) {
        args.onEvent({
          type: "items",
          items: [{ kind: "text", role: "assistant", content: "ok" }]
        });
        args.onEvent({ type: "done", exitCode: 0 });
      }
    },
    eventsLog: events
  };
}

test("in-memory workflow runtime creates and completes a single-step plan", async () => {
  const repository = createMemoryWorkflowRepository();
  const ports = fakePorts(repository);
  const runtime = new WorkflowRuntime(ports);
  const agents = [
    { id: "cli-codex-acp", name: "Codex", adapter: "codex-acp", enabled: true }
  ];
  const created = runtime.createPendingRun({
    plan: {
      name: "One",
      goal: "Ship",
      phases: [
        {
          id: "p1",
          title: "Do",
          parallelism: 1,
          steps: [
            {
              id: "s1",
              title: "Work",
              agentId: "cli-codex-acp",
              mode: "research",
              prompt: "Do the work"
            }
          ]
        }
      ]
    },
    agents
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await runtime.start(created.run.id);
  const run = repository.getRun(created.run.id);
  assert.ok(run);
  assert.notEqual(run.status, "pending_approval");
});

test("in-memory workflow runtime marks a silent successful step failed", async () => {
  const repository = createMemoryWorkflowRepository();
  const ports = fakePorts(repository);
  ports.executor = {
    async run(args) {
      args.onEvent({ type: "done", exitCode: 0 });
    }
  };
  const runtime = new WorkflowRuntime(ports);
  const created = runtime.createPendingRun({
    plan: {
      name: "Silent",
      goal: "Ship",
      phases: [
        {
          id: "p1",
          title: "Do",
          parallelism: 1,
          steps: [
            {
              id: "s1",
              title: "Work",
              agentId: "cli-dsh-acp",
              mode: "research",
              prompt: "Do the work"
            }
          ]
        }
      ]
    },
    agents: [
      { id: "cli-dsh-acp", name: "DSH", adapter: "dsh-acp", enabled: true }
    ]
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  await runtime.start(created.run.id);

  const step = repository.getSteps(created.run.id)[0];
  assert.equal(step.status, "failed");
  assert.match(JSON.parse(step.resultJson).error, /returned no output/i);
  assert.equal(repository.getRun(created.run.id)?.status, "failed");
});

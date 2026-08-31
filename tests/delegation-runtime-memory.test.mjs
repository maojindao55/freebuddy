import test from "node:test";
import assert from "node:assert/strict";
import {
  DelegationOrchestrator,
  DelegationRuntime,
  createMemoryDelegationRepository
} from "../packages/delegation-runtime/dist/index.js";

const roster = [
  { id: "r-impl", label: "实现", agentId: "agent-a", capability: "写", canWrite: true },
  { id: "r-rev", label: "评审", agentId: "agent-b", capability: "审", canWrite: false }
];
const policy = {
  allowWrites: true,
  requireApprovalBeforeDelegateWrite: true,
  maxDepth: 3,
  delegateTimeoutMs: 600000,
  maxConcurrentDelegates: 1,
  stopOnDelegateFailure: false
};

function fakeExecutor(onRequest) {
  return {
    async run(request, onEvent) {
      onRequest?.(request);
      onEvent({
        type: "items",
        items: [{ kind: "text", role: "assistant", content: "finished" }]
      });
      onEvent({ type: "done", exitCode: 0 });
    },
    kill() {}
  };
}

test("in-memory delegation runtime completes a nested-capable entry turn", async () => {
  const repository = createMemoryDelegationRepository();
  let request;
  const instructedRoster = roster.map((role) =>
    role.id === "r-impl" ? { ...role, instructions: "Implement and verify directly." } : role
  );
  const runtime = new DelegationRuntime({
    repository,
    executor: fakeExecutor((value) => { request = value; }),
    events: { publish() {} },
    approval: { async request() { return true; } },
    clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
    ids: { id: () => "id" },
    skills: { resolve: () => [] },
    resolveAgent: (id) => ({ adapter: "claude", agentName: id }),
    getTeam: () => ({
      id: "t",
      name: "t",
      enabled: true,
      source: "user",
      kind: "delegation",
      sharedInstructions: "Every role must produce verifiable output.",
      entryRoleId: "r-impl",
      roster: instructedRoster,
      policy,
      createdAt: "",
      updatedAt: ""
    })
  });
  const runId = await runtime.start({
    goal: "ship it",
    teamId: "t",
    teamSnapshot: {
      roster: instructedRoster,
      sharedInstructions: "Every role must produce verifiable output.",
      policy,
      entryRoleId: "r-impl"
    },
    runtimeVersion: "1.0.0",
    runtimeApiVersion: "1.0.0"
  });
  const run = repository.getRun(runId);
  assert.ok(run);
  assert.equal(run.runtimeVersion, "1.0.0");
  assert.equal(run.status, "completed");
  assert.match(request.prompt, /Every role must produce verifiable output/);
  assert.match(request.prompt, /Implement and verify directly/);
});

test("in-memory runtime rejects a clean exit with no assistant output or artifact", async () => {
  const repository = createMemoryDelegationRepository();
  const runtime = new DelegationRuntime({
    repository,
    executor: {
      async run(_request, onEvent) {
        onEvent({
          type: "items",
          items: [{ kind: "tool-call", tool: "list_teammates", status: "completed" }]
        });
        onEvent({ type: "done", exitCode: 0 });
      },
      kill() {}
    },
    events: { publish() {} },
    approval: { async request() { return true; } },
    clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
    ids: { id: () => "id" },
    skills: { resolve: () => [] },
    resolveAgent: (id) => ({ adapter: "claude", agentName: id }),
    getTeam: () => undefined
  });
  const runId = await runtime.start({
    goal: "ship it",
    teamId: "t",
    teamSnapshot: { roster, policy, entryRoleId: "r-impl" }
  });
  assert.equal(repository.getRun(runId)?.status, "failed");
  assert.match(
    repository.listEvents(runId).find((event) => event.depth === 0)?.resultSummary ?? "",
    /without assistant text/i
  );
});

test("in-memory delegation runtime marks a silent successful turn failed", async () => {
  const repository = createMemoryDelegationRepository();
  const runtime = new DelegationRuntime({
    repository,
    executor: {
      async run(_request, onEvent) {
        onEvent({ type: "done", exitCode: 0 });
      },
      kill() {}
    },
    events: { publish() {} },
    approval: { async request() { return true; } },
    clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
    ids: { id: () => "id" },
    skills: { resolve: () => [] },
    resolveAgent: (id) => ({ adapter: "dsh-acp", agentName: id }),
    getTeam: () => ({
      id: "t",
      name: "t",
      enabled: true,
      source: "user",
      kind: "delegation",
      entryRoleId: "r-impl",
      roster,
      policy,
      createdAt: "",
      updatedAt: ""
    })
  });

  const runId = await runtime.start({
    goal: "ship it",
    teamId: "t",
    teamSnapshot: { roster, policy, entryRoleId: "r-impl" }
  });

  assert.equal(repository.getRun(runId)?.status, "failed");
  const root = repository.listEvents(runId).find((event) => event.depth === 0);
  assert.equal(root?.status, "failed");
  assert.match(root?.resultSummary ?? "", /returned no output/i);
});

test("team policy is a hard read-only ceiling for writable entry roles", async () => {
  const repository = createMemoryDelegationRepository();
  let request;
  const readOnlyPolicy = { ...policy, allowWrites: false };
  const runtime = new DelegationRuntime({
    repository,
    executor: fakeExecutor((value) => { request = value; }),
    events: { publish() {} },
    approval: { async request() { return true; } },
    clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
    ids: { id: () => "id" },
    skills: { resolve: () => [] },
    resolveAgent: (id) => ({ adapter: "claude", agentName: id }),
    getTeam: () => undefined
  });

  const runId = await runtime.start({
    goal: "inspect only",
    teamId: "t",
    teamSnapshot: {
      roster,
      policy: readOnlyPolicy,
      entryRoleId: "r-impl"
    }
  });

  assert.equal(request.workspaceAccess, "read-only");
  assert.equal(
    repository.listEvents(runId).find((event) => event.depth === 0)?.canWrite,
    false
  );
});

test("a child that fails before the parent turn ends triggers a wake instead of completing root", async () => {
  const repository = createMemoryDelegationRepository();
  const run = repository.createRun({
    goal: "g",
    status: "running",
    teamId: "t",
    teamSnapshotJson: "{}"
  });
  const rootId = repository.insertEvent({
    runId: run.id,
    parentEventId: null,
    agentId: "agent-a",
    agentName: "A",
    roleLabel: "实现",
    taskText: "g",
    depth: 0,
    canWrite: false,
    status: "running"
  });
  let calls = 0;
  let orchestrator;
  orchestrator = new DelegationOrchestrator({
    runId: run.id,
    roster,
    policy,
    entryRoleId: "r-impl",
    repository,
    async spawnTurn({ prompt }) {
      calls += 1;
      if (calls === 1) {
        const childId = repository.insertEvent({
          runId: run.id,
          parentEventId: rootId,
          agentId: "agent-b",
          agentName: "B",
          roleLabel: "评审",
          taskText: "review",
          depth: 1,
          canWrite: false,
          status: "running"
        });
        orchestrator.noteChildEnqueued({
          childEventId: childId,
          parentEventId: rootId,
          depth: 1
        });
        orchestrator.noteChildStarted(childId);
        repository.updateEvent(childId, {
          status: "failed",
          resultSummary: "delegate crashed"
        });
        orchestrator.onEventSettled(childId);
        return {
          summary: "(no assistant response or artifact)",
          error: null,
          hasOutput: false
        };
      }
      assert.match(prompt, /delegate crashed/);
      return {
        summary: "(no assistant response or artifact)",
        error: null,
        hasOutput: false
      };
    }
  });
  orchestrator.bindEntry(rootId);

  const result = await orchestrator.runNodeLoop({
    nodeId: rootId,
    depth: 0,
    selfAgentId: "r-impl",
    selfLabel: "实现",
    initialPrompt: "go"
  });

  assert.equal(calls, 2, "the terminal child result must be integrated in a wake turn");
  assert.match(result.error ?? "", /without assistant text/i);
  assert.equal(repository.getRun(run.id)?.status, "failed");
  assert.equal(repository.getEvent(rootId)?.status, "failed");
});

test("crash recovery marks active events failed via repository transitions", () => {
  const repository = createMemoryDelegationRepository();
  const run = repository.createRun({
    goal: "g",
    status: "running",
    teamId: "t",
    teamSnapshotJson: "{}"
  });
  const eventId = repository.insertEvent({
    runId: run.id,
    parentEventId: null,
    agentId: "a",
    agentName: "a",
    roleLabel: "a",
    taskText: "t",
    depth: 0,
    canWrite: false,
    status: "running"
  });
  assert.equal(repository.transitionEvent(eventId, "failed", "Interrupted by app restart."), true);
  assert.equal(repository.getEvent(eventId)?.status, "failed");
  assert.equal(repository.setStatus(run.id, "failed"), true);
});

test("memory delegation ids are UUIDs and unique across fresh repositories", () => {
  const first = createMemoryDelegationRepository();
  const second = createMemoryDelegationRepository();
  const runA = first.createRun({ goal: "a", status: "running", teamId: "t", teamSnapshotJson: "{}" });
  const runB = second.createRun({ goal: "b", status: "running", teamId: "t", teamSnapshotJson: "{}" });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(runA.id, uuid);
  assert.match(runB.id, uuid);
  assert.notEqual(runA.id, runB.id);
  const eventA = first.insertEvent({
    runId: runA.id,
    parentEventId: null,
    agentId: "a",
    agentName: "a",
    roleLabel: "a",
    taskText: "t",
    depth: 0,
    canWrite: false,
    status: "running"
  });
  const eventB = second.insertEvent({
    runId: runB.id,
    parentEventId: null,
    agentId: "b",
    agentName: "b",
    roleLabel: "b",
    taskText: "t",
    depth: 0,
    canWrite: false,
    status: "running"
  });
  assert.match(eventA, uuid);
  assert.match(eventB, uuid);
  assert.notEqual(eventA, eventB);
});

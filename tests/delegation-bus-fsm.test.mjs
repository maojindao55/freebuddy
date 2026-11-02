import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

test("FSM: TurnEnded with active child parks; ChildSettled wakes; no children completes", async () => {
  const {
    createInitialBusState,
    ensureChildNode,
    markChildTurning,
    reduce
  } = await import("../dist-electron/cli/delegation/bus/stateMachine.js");

  let state = createInitialBusState({ runId: "r1", entryNodeId: "root" });
  state = ensureChildNode(state, { id: "c1", parentId: "root", depth: 1 });
  state = markChildTurning(state, "c1");

  ({ state } = reduce(state, { type: "TurnStarted", nodeId: "root" }));
  assert.equal(state.nodes.root.status, "turning");

  let effects;
  ({ state, effects } = reduce(state, {
    type: "TurnEnded",
    nodeId: "root",
    summary: "waiting"
  }));
  assert.equal(state.nodes.root.status, "parked");
  assert.equal(state.runStatus, "running");
  assert.equal(effects.some((e) => e.type === "MarkRunCompleted"), false);

  ({ state, effects } = reduce(state, {
    type: "ChildSettled",
    parentId: "root",
    childId: "c1",
    childStatus: "done",
    resultSummary: "LGTM",
    taskText: "审",
    roleLabel: "评审",
    verdict: "needs_changes",
    verdictSummary: "toast"
  }));
  assert.equal(state.nodes.root.status, "turning");
  const wake = effects.find((e) => e.type === "SpawnWake");
  assert.ok(wake);
  assert.equal(wake.verdict, "needs_changes");
  assert.equal(wake.verdictSummary, "toast");

  ({ state, effects } = reduce(state, { type: "TurnStarted", nodeId: "root" }));
  ({ state, effects } = reduce(state, {
    type: "TurnEnded",
    nodeId: "root",
    summary: "done"
  }));
  assert.equal(state.nodes.root.status, "done");
  assert.equal(state.runStatus, "completed");
  assert.ok(effects.some((e) => e.type === "MarkRunCompleted"));
});

test("FSM: UserFollowUp reopens completed run", async () => {
  const { createInitialBusState, reduce } = await import(
    "../dist-electron/cli/delegation/bus/stateMachine.js"
  );
  let state = createInitialBusState({ runId: "r1", entryNodeId: "root" });
  ({ state } = reduce(state, { type: "TurnStarted", nodeId: "root" }));
  ({ state } = reduce(state, {
    type: "TurnEnded",
    nodeId: "root",
    summary: "first"
  }));
  assert.equal(state.runStatus, "completed");

  let effects;
  ({ state, effects } = reduce(state, {
    type: "UserFollowUp",
    prompt: "委派评审"
  }));
  assert.equal(state.runStatus, "running");
  assert.equal(state.nodes.root.status, "turning");
  assert.ok(effects.some((e) => e.type === "SpawnFollowUp"));
});

test("FSM: stopped run stays cancelled on child settlement until an explicit follow-up", async () => {
  const { createInitialBusState, ensureChildNode, reduce } = await import(
    "../packages/delegation-core/dist/index.js"
  );
  let state = createInitialBusState({ runId: "r1", entryNodeId: "root" });
  state = ensureChildNode(state, { id: "child", parentId: "root", depth: 1 });
  ({ state } = reduce(state, { type: "RunKilled" }));
  let effects;
  ({ state, effects } = reduce(state, {
    type: "ChildSettled",
    parentId: "root",
    childId: "child",
    childStatus: "done",
    resultSummary: "late result",
    taskText: "review",
    roleLabel: "reviewer"
  }));
  assert.equal(state.runStatus, "killed");
  assert.equal(state.nodes.root.status, "cancelled");
  assert.equal(effects.length, 0);

  ({ state, effects } = reduce(state, { type: "UserFollowUp", prompt: "continue" }));
  assert.equal(state.runStatus, "running");
  assert.equal(state.nodes.root.status, "turning");
  assert.deepEqual(effects, [{ type: "SpawnFollowUp", prompt: "continue" }]);
});

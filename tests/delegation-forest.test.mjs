import test from "node:test";
import assert from "node:assert/strict";

function event(overrides) {
  return {
    id: "evt",
    parentEventId: null,
    depth: 0,
    ...overrides
  };
}

async function load() {
  return import("../packages/delegation-core/dist/index.js");
}

function ids(nodes) {
  return nodes.map((node) => node.event.id);
}

test("empty input yields an empty forest", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([]);
  assert.deepEqual(forest.roots, []);
  assert.equal(forest.byId.size, 0);
  assert.deepEqual(forest.warnings, []);
});

test("a chain derives depth from parent links, not from declared depth", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "a", parentEventId: null, depth: 0 }),
    event({ id: "b", parentEventId: "a", depth: 1 }),
    event({ id: "c", parentEventId: "b", depth: 2 })
  ]);

  assert.deepEqual(ids(forest.roots), ["a"]);
  const a = forest.byId.get("a");
  const b = forest.byId.get("b");
  const c = forest.byId.get("c");
  assert.deepEqual(ids(a.children), ["b"]);
  assert.deepEqual(ids(b.children), ["c"]);
  assert.deepEqual([a.depth, b.depth, c.depth], [0, 1, 2]);
  assert.equal(a.descendantCount, 2);
  assert.equal(b.descendantCount, 1);
  assert.equal(c.descendantCount, 0);
});

test("a run can hold several roots (pause cancels, resume inserts a new depth-0 event)", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "first", parentEventId: null, depth: 0 }),
    event({ id: "child", parentEventId: "first", depth: 1 }),
    event({ id: "second", parentEventId: null, depth: 0 })
  ]);

  assert.deepEqual(ids(forest.roots), ["first", "second"]);
  assert.deepEqual(ids(forest.byId.get("first").children), ["child"]);
  assert.deepEqual(ids(forest.byId.get("second").children), []);
});

test("an unknown parent is promoted to a root and reported", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "a", parentEventId: null, depth: 0 }),
    event({ id: "ghost-child", parentEventId: "missing", depth: 1 })
  ]);

  assert.deepEqual(ids(forest.roots), ["a", "ghost-child"]);
  const orphan = forest.byId.get("ghost-child");
  assert.equal(orphan.orphaned, true);
  assert.equal(orphan.depth, 0);
  assert.deepEqual(
    forest.warnings.filter((w) => w.kind === "orphan-parent"),
    [{ kind: "orphan-parent", eventId: "ghost-child", parentEventId: "missing" }]
  );
});

test("a self-referencing parent is repaired instead of hanging", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "self", parentEventId: "self", depth: 0 })
  ]);

  assert.deepEqual(ids(forest.roots), ["self"]);
  assert.equal(forest.byId.get("self").repaired, true);
  assert.equal(forest.byId.get("self").depth, 0);
  assert.equal(
    forest.warnings.filter((w) => w.kind === "cycle").length,
    1
  );
});

test("a two-node cycle is broken and the rest of the forest survives", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "a", parentEventId: "b", depth: 0 }),
    event({ id: "b", parentEventId: "a", depth: 1 }),
    event({ id: "unrelated", parentEventId: null, depth: 0 })
  ]);

  assert.deepEqual(ids(forest.roots), ["a", "unrelated"]);
  assert.equal(forest.byId.get("a").repaired, true);
  assert.deepEqual(ids(forest.byId.get("a").children), ["b"]);
  assert.equal(forest.byId.get("b").depth, 1);
  assert.deepEqual(
    forest.warnings.filter((w) => w.kind === "cycle"),
    [{ kind: "cycle", eventId: "a", parentEventId: "b" }]
  );
});

test("a declared depth that contradicts the parent chain is reported", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "a", parentEventId: null, depth: 0 }),
    event({ id: "b", parentEventId: "a", depth: 5 })
  ]);

  assert.equal(forest.byId.get("b").depth, 1);
  assert.deepEqual(
    forest.warnings.filter((w) => w.kind === "depth-mismatch"),
    [{ kind: "depth-mismatch", eventId: "b", declaredDepth: 5, computedDepth: 1 }]
  );
});

test("re-delegation adds a sibling under the same caller, preserving input order", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "root", parentEventId: null, depth: 0 }),
    event({ id: "review-1", parentEventId: "root", depth: 1 }),
    event({ id: "impl", parentEventId: "root", depth: 1 }),
    event({ id: "review-2", parentEventId: "root", depth: 1 })
  ]);

  assert.deepEqual(ids(forest.byId.get("root").children), [
    "review-1",
    "impl",
    "review-2"
  ]);
  assert.equal(forest.byId.get("root").descendantCount, 3);
});

test("the same role may appear under several parents", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "root", parentEventId: null, depth: 0 }),
    event({ id: "left", parentEventId: "root", depth: 1 }),
    event({ id: "right", parentEventId: "root", depth: 1 }),
    event({ id: "shared-left", parentEventId: "left", depth: 2 }),
    event({ id: "shared-right", parentEventId: "right", depth: 2 })
  ]);

  assert.equal(forest.byId.get("left").children.length, 1);
  assert.equal(forest.byId.get("right").children.length, 1);
  assert.deepEqual(ids(forest.byId.get("left").children), ["shared-left"]);
  assert.deepEqual(ids(forest.byId.get("right").children), ["shared-right"]);
});

test("a duplicate id keeps the first occurrence and warns", async () => {
  const { buildDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "a", parentEventId: null, depth: 0 }),
    event({ id: "a", parentEventId: null, depth: 0 })
  ]);

  assert.equal(forest.byId.size, 1);
  assert.equal(forest.roots.length, 1);
  assert.deepEqual(
    forest.warnings.filter((w) => w.kind === "duplicate-id"),
    [{ kind: "duplicate-id", eventId: "a" }]
  );
});

test("flattening is pre-order and reports sibling position", async () => {
  const { buildDelegationForest, flattenDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "a", parentEventId: null, depth: 0 }),
    event({ id: "b", parentEventId: "a", depth: 1 }),
    event({ id: "c", parentEventId: "a", depth: 1 }),
    event({ id: "d", parentEventId: "b", depth: 2 }),
    event({ id: "e", parentEventId: null, depth: 0 })
  ]);

  const flat = flattenDelegationForest(forest);
  assert.deepEqual(
    flat.map((row) => row.node.event.id),
    ["a", "b", "d", "c", "e"]
  );
  assert.deepEqual(
    flat.map((row) => row.depth),
    [0, 1, 2, 1, 0]
  );

  const b = flat.find((row) => row.node.event.id === "b");
  assert.deepEqual(
    { posInSet: b.posInSet, setSize: b.setSize, isLastChild: b.isLastChild },
    { posInSet: 1, setSize: 2, isLastChild: false }
  );
  const c = flat.find((row) => row.node.event.id === "c");
  assert.deepEqual(
    { posInSet: c.posInSet, setSize: c.setSize, isLastChild: c.isLastChild },
    { posInSet: 2, setSize: 2, isLastChild: true }
  );

  const roots = flat.filter((row) => row.depth === 0);
  assert.deepEqual(
    roots.map((row) => row.isLastChild),
    [false, true]
  );
});

test("collapse hides descendants but keeps the collapsed node itself", async () => {
  const { buildDelegationForest, flattenDelegationForest } = await load();
  const forest = buildDelegationForest([
    event({ id: "a", parentEventId: null, depth: 0 }),
    event({ id: "b", parentEventId: "a", depth: 1 }),
    event({ id: "c", parentEventId: "b", depth: 2 }),
    event({ id: "d", parentEventId: null, depth: 0 })
  ]);

  const flat = flattenDelegationForest(forest, {
    isExpanded: (node) => node.event.id !== "b"
  });
  assert.deepEqual(
    flat.map((row) => row.node.event.id),
    ["a", "b", "d"]
  );
  assert.equal(forest.byId.get("b").descendantCount, 1);
});

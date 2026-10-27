import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

let moduleId = 0;
async function loadSource(path) {
  const source = ts.transpileModule(
    fs.readFileSync(new URL(path, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }
  ).outputText.replaceAll('"zustand"', JSON.stringify(import.meta.resolve("zustand")));
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// ${moduleId++}`).toString("base64")}`);
}

const loadGrouping = () => loadSource("../src/components/CLI/conversationProjectGrouping.ts");
const loadStore = () => loadSource("../src/store/projectSortStore.ts");

function mockStorage(t, initial, failWrites = false) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map(initial === undefined ? [] : [["freebuddy.projects.sort.v1", initial]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => {
        if (failWrites) throw new Error("Storage is unavailable");
        data.set(key, value);
      }
    }
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  });
}

const group = (key, latestAt, items = [{}]) => ({ key, label: key, latestAt, items });
const keys = groups => groups.map(item => item.key);

test("default project sorting preserves activity order and pin priority", async () => {
  const { sortProjectGroups } = await loadGrouping();
  const groups = [group("old", 1), group("empty", 100, []), group("new", 5), group("pin-a", 0), group("pin-b", 3)];
  assert.deepEqual(keys(sortProjectGroups(groups, ["pin-b", "pin-a"])), ["pin-b", "pin-a", "new", "old", "empty"]);
  assert.deepEqual(keys(groups), ["old", "empty", "new", "pin-a", "pin-b"]);
});

test("fixed projects stay put when activity, names, or empty status change; conversations remain recent first", async () => {
  const { groupConversationsByProjects, sortProjectGroups, unreadConversationView } = await loadGrouping();
  const projects = ["a", "b", "c"].map(id => ({ id, name: id, folders: [], primaryPath: "/tmp" }));
  const conv = (id, projectId, at) => ({ id, projectId, lastMessageAt: `2026-10-27T00:00:0${at}.000Z` });
  const conversations = [conv("old", "a", 1), conv("new", "a", 4), conv("b-task", "b", 2)];
  const fixedOrder = ["b", "c", "a"];
  const before = sortProjectGroups(groupConversationsByProjects(conversations, projects), [], "fixed", fixedOrder);
  assert.deepEqual(keys(before), fixedOrder);
  assert.deepEqual(before[2].items.map(item => item.id), ["new", "old"]);

  projects[1].name = "Renamed project";
  conversations.push(conv("c-task", "c", 5));
  const after = sortProjectGroups(groupConversationsByProjects(conversations, projects), [], "fixed", fixedOrder);
  assert.deepEqual(keys(after), fixedOrder);
  assert.deepEqual(keys(unreadConversationView(conversations, after, { "new": {}, "b-task": {} }).projects), ["b", "a"]);
  assert.deepEqual(keys(sortProjectGroups(after, [], "activity")), ["c", "a", "b"]);
});

test("pins override fixed order and unpinning restores the saved position", async () => {
  const { sortProjectGroups } = await loadGrouping();
  const groups = [group("a", 1), group("b", 2), group("c", 3), group("new", 10)];
  const fixedOrder = ["a", "b", "c"];
  assert.deepEqual(keys(sortProjectGroups(groups, ["c", "b"], "fixed", fixedOrder)), ["c", "b", "a", "new"]);
  assert.deepEqual(keys(sortProjectGroups(groups, ["c"], "fixed", fixedOrder)), ["c", "a", "b", "new"]);
  assert.deepEqual(keys(sortProjectGroups(groups, [], "fixed", fixedOrder)), ["a", "b", "c", "new"]);
});

test("fixed order persists per user, appends new projects, and forgets deleted projects", async t => {
  mockStorage(t);
  const { useProjectSortStore, projectSortPreferenceForUser: preference } = await loadStore();
  const state = useProjectSortStore.getState;
  assert.equal(preference(state(), "alice").mode, "activity");
  // Snapshot the complete list, including projects beyond the sidebar limit.
  const snapshot = Array.from({ length: 9 }, (_, index) => `p${index}`);
  state().setMode("alice", "fixed", snapshot);
  state().rememberProjects("alice", ["new", ...snapshot.toReversed()]);
  assert.deepEqual(preference(state(), "alice").fixedOrder, [...snapshot, "new"]);
  assert.equal(preference(state(), "bob").mode, "activity");
  assert.equal(preference(state(), undefined).mode, "activity");

  state().setMode("bob", "fixed", ["bob-project"]);
  state().rememberProjects("alice", ["new", "p1", "p0"]);
  assert.deepEqual(preference(state(), "alice").fixedOrder, ["p0", "p1", "new"]);
  assert.deepEqual(preference(state(), "bob").fixedOrder, ["bob-project"]);

  const restored = await loadStore();
  assert.deepEqual(restored.projectSortPreferenceForUser(restored.useProjectSortStore.getState(), "alice"), {
    mode: "fixed", fixedOrder: ["p0", "p1", "new"]
  });
  assert.deepEqual(restored.projectSortPreferenceForUser(restored.useProjectSortStore.getState(), "bob").fixedOrder, ["bob-project"]);
});

test("returning to fixed mode captures the current activity order", async t => {
  mockStorage(t);
  const { useProjectSortStore, projectSortPreferenceForUser: preference } = await loadStore();
  const state = useProjectSortStore.getState;
  state().setMode("alice", "fixed", ["a", "b"]);
  state().setMode("alice", "activity", ["b", "a"]);
  state().rememberProjects("alice", ["c", "b", "a"]);
  state().setMode("alice", "fixed", ["c", "b", "a"]);
  assert.deepEqual(preference(state(), "alice").fixedOrder, ["c", "b", "a"]);
  const unchanged = state();
  state().rememberProjects("alice", ["a", "b", "c"]);
  assert.equal(state(), unchanged, "activity-only changes do not rewrite a fixed order");
});

test("invalid stored data falls back safely and unavailable storage keeps the in-memory preference", async t => {
  mockStorage(t, "{broken json", true);
  const { useProjectSortStore, projectSortPreferenceForUser: preference } = await loadStore();
  const state = useProjectSortStore.getState;
  assert.equal(preference(state(), "alice").mode, "activity");
  state().setMode("alice", "fixed", ["a", "a", "b"]);
  assert.deepEqual(preference(state(), "alice"), { mode: "fixed", fixedOrder: ["a", "b"] });
});

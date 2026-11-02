import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

let fixtureId = 0;
async function loadStore() {
  const source = fs.readFileSync(new URL("../src/store/newTaskUiStore.ts", import.meta.url), "utf8")
    .replace('from "zustand"', `from ${JSON.stringify(import.meta.resolve("zustand"))}`);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// fixture ${++fixtureId}`).toString("base64")}`);
  return module.useNewTaskUiStore;
}

function useStorage(t, storage) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
}

test("new conversations and a restarted app retain the chosen agent", async t => {
  const values = new Map();
  useStorage(t, { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  const store = await loadStore();
  assert.equal(store.getState().preferredAgentId, undefined);
  store.getState().setPreferredAgentId("cli-claude-agent-acp");
  store.getState().requestNewTask();
  store.getState().requestNewTask({ cwd: "/project", projectId: "project" });
  store.getState().requestNewTaskCwd("/another-project");
  assert.equal(store.getState().preferredAgentId, "cli-claude-agent-acp");
  const restarted = await loadStore();
  assert.equal(restarted.getState().preferredAgentId, "cli-claude-agent-acp");
  restarted.getState().setPreferredAgentId("cli-codex-acp");
  assert.equal((await loadStore()).getState().preferredAgentId, "cli-codex-acp");
});

test("one-off agent requests and team navigation preserve the normal agent preference", async t => {
  const values = new Map();
  useStorage(t, { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  const store = await loadStore();
  store.getState().setPreferredAgentId("cli-codex-acp");
  store.getState().requestNewTask({ agentId: "cli-imported-agent" });
  assert.equal(store.getState().requestedAgentId, "cli-imported-agent");
  store.getState().setTaskMode("team");
  store.getState().setRequestedTeamId("team");
  store.getState().setTaskMode("normal");
  store.getState().requestNewTask();
  assert.equal(store.getState().requestedAgentId, undefined);
  assert.equal((await loadStore()).getState().preferredAgentId, "cli-codex-acp");
});

test("blocked persistent storage still remembers the agent for this app session", async t => {
  useStorage(t, { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  const store = await loadStore();
  assert.equal(store.getState().preferredAgentId, undefined);
  store.getState().setPreferredAgentId("cli-codex-acp");
  store.getState().requestNewTask();
  assert.equal(store.getState().preferredAgentId, "cli-codex-acp");
});

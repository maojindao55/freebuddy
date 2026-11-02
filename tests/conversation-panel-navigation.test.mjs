import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { create } from "zustand";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const toUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const navigation = await import(toUrl(transpile(read("../src/utils/conversationPanelNavigation.ts"))));
let fixtureId = 0;

const timestamp = "2026-10-05T03:00:00.000Z";
const conversation = (id) => ({
  id, title: id, agentId: "agent", agentName: "Agent", adapter: "codex",
  createdAt: timestamp, updatedAt: timestamp
});
const unreadEntry = { kind: "success", at: timestamp };
const unreadKey = "freebuddy.conversations.unread.v1";

/** Run the real store and reading/unread helpers; only external services are stubs. */
async function fixture(t, { initialUnread = {}, selectedId, readingVisible = false } = {}) {
  const previous = Object.fromEntries(["window", "sessionStorage", "localStorage"].map((key) => [
    key, { exists: Object.hasOwn(globalThis, key), value: globalThis[key] }
  ]));
  t.after(() => {
    for (const [key, saved] of Object.entries(previous)) {
      if (saved.exists) globalThis[key] = saved.value;
      else delete globalThis[key];
    }
  });
  const storage = new Map([[unreadKey, JSON.stringify(initialUnread)]]);
  const session = new Map(selectedId ? [["fb_last_active_conversation", selectedId]] : []);
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.sessionStorage = {
    getItem: (key) => session.get(key) ?? null,
    setItem: (key, value) => session.set(key, value),
    removeItem: (key) => session.delete(key)
  };
  globalThis.window = { location: { search: "" } };

  const id = ++fixtureId;
  const readingUrl = toUrl(`${transpile(read("../src/store/conversationReading.ts"))}\n// fixture ${id}`);
  const reading = await import(readingUrl);
  reading.setConversationReadingVisible(readingVisible);
  const unreadUrl = toUrl(`${transpile(read("../src/store/conversationUnread.ts"))}\n// fixture ${id}`);
  const services = {
    conversations: [],
    deleted: [],
    listRequests: [],
    client: {
      isAvailable: () => true,
      getSetting: async () => undefined,
      listConversations: async (args) => {
        services.listRequests.push(args);
        return services.conversations;
      },
      deleteConversation: async (conversationId) => services.deleted.push(conversationId)
    }
  };
  const dependencyKey = `__conversationPanelTest${id}`;
  globalThis[dependencyKey] = { create, client: services.client };
  const storeSource = transpile(read("../src/store/conversationStore.ts"));
  const imports = ts.createSourceFile("store.js", storeSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const names = new Set();
  for (const statement of imports.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach((element) => names.add(element.propertyName?.text ?? element.name.text));
  }
  const implementations = {
    create: `globalThis.${dependencyKey}.create`,
    cliClient: `globalThis.${dependencyKey}.client`,
    builtinCliMembers: "[]",
    useCliExecutorStore: "({ getState: () => ({ adapters: [], runtimes: {}, resolve: () => undefined, listResolved: () => [] }) })",
    useProjectStore: "({ getState: () => ({ projects: [] }) })",
    workflowClient: "({ isAvailable: () => false })",
    isAppInBackground: "() => false"
  };
  const mockUrl = toUrl([...names].map((name) => `export const ${name} = ${implementations[name] ?? "() => undefined"};`).join("\n"));
  const moduleSource = storeSource.replace(/from\s+["']([^"']+)["']/g, (_, specifier) =>
    `from ${JSON.stringify(specifier === "./conversationReading" ? readingUrl : specifier === "./conversationUnread" ? unreadUrl : mockUrl)}`
  );
  let useConversationStore;
  try {
    ({ useConversationStore } = await import(toUrl(moduleSource)));
  } finally {
    delete globalThis[dependencyKey];
  }
  return { store: useConversationStore, reading, services, persisted: () => JSON.parse(storage.get(unreadKey)) };
}

test("restored panel selection and deletion replacements do not open chat", () => {
  const follow = navigation.shouldFollowConversationSelection;
  assert.equal(follow(undefined, "a", ["a"], "panel"), false);
  assert.equal(follow(undefined, "a", ["a"], "list"), true);
  assert.equal(follow("a", "b", ["a", "b"], "panel"), true);
  assert.equal(follow("a", "b", ["b"], "panel"), false);
  assert.equal(follow("a", "a", ["a"], "panel"), false);
  assert.equal(follow("a", undefined, [], "list"), false);
});

test("a foreground task panel preserves messages and completed unread for its retained chat", async (t) => {
  const { store, reading, persisted } = await fixture(t);
  store.setState({ activeId: "a", conversations: [conversation("a")], messages: { a: [] } });
  assert.equal(reading.isConversationReadingVisible(), false);
  store.getState().markConversationUnread("a");
  assert.equal(store.getState().unreadConversations.a.kind, "message");
  store.getState().markConversationCompletedUnread("a", "success");
  assert.equal(store.getState().activeId, "a");
  assert.equal(store.getState().unreadConversations.a.kind, "success");
  assert.deepEqual(persisted(), store.getState().unreadConversations);
  store.getState().markConversationCompletedUnread("a", "failure");
  assert.equal(store.getState().unreadConversations.a.kind, "failure");
});

test("visible foreground chat suppresses its unread while other conversations keep results", async (t) => {
  const { store } = await fixture(t, { readingVisible: true });
  store.setState({ activeId: "a", conversations: [conversation("a"), conversation("b")], messages: { a: [], b: [] } });
  store.getState().markConversationUnread("a");
  store.getState().markConversationCompletedUnread("a", "success");
  store.getState().markConversationCompletedUnread("b", "success");
  assert.equal(store.getState().unreadConversations.a, undefined);
  assert.equal(store.getState().unreadConversations.b.kind, "success");
});

test("startup restores the last chat on a panel without clearing its saved unread", async (t) => {
  const { store, services, persisted } = await fixture(t, {
    initialUnread: { a: unreadEntry }, selectedId: "a"
  });
  services.conversations = [conversation("a")];
  store.setState({ messages: { a: [] } });
  await store.getState().load();
  assert.deepEqual(services.listRequests, [{ archived: false }]);
  assert.equal(store.getState().activeId, "a");
  assert.deepEqual(store.getState().unreadConversations.a, unreadEntry);
  assert.deepEqual(persisted(), { a: unreadEntry });
});

test("startup in the original list clears the unread of the chat being read", async (t) => {
  const { store, services, persisted } = await fixture(t, {
    initialUnread: { a: unreadEntry }, selectedId: "a", readingVisible: true
  });
  services.conversations = [conversation("a")];
  store.setState({ messages: { a: [] } });
  await store.getState().load();
  assert.equal(store.getState().activeId, "a");
  assert.deepEqual(store.getState().unreadConversations, {});
  assert.deepEqual(persisted(), {});
});

test("deleting the retained panel selection preserves replacement unread and panel navigation", async (t) => {
  const { store, services, reading, persisted } = await fixture(t, {
    initialUnread: { a: unreadEntry, b: unreadEntry }
  });
  store.setState({ activeId: "a", conversations: [conversation("a"), conversation("b")], messages: { a: [], b: [] } });
  const previousId = store.getState().activeId;
  await store.getState().deleteConversation("a");
  const next = store.getState();
  assert.deepEqual(services.deleted, ["a"]);
  assert.equal(next.activeId, "b");
  assert.equal(navigation.shouldFollowConversationSelection(previousId, next.activeId, next.conversations.map((entry) => entry.id), "panel"), false);
  assert.equal(reading.isConversationReadingVisible(), false);
  assert.deepEqual(next.unreadConversations, { b: unreadEntry });
  assert.deepEqual(persisted(), { b: unreadEntry });
  assert.equal(next.messages.a, undefined);
});

test("returning from the panel to the last chat clears only that chat's unread", async (t) => {
  const { store, reading, persisted } = await fixture(t, {
    initialUnread: { a: unreadEntry, b: unreadEntry }
  });
  store.setState({ activeId: "a", conversations: [conversation("a"), conversation("b")], messages: { a: [], b: [] } });
  reading.setConversationReadingVisible(true);
  store.getState().markConversationRead(store.getState().activeId);
  assert.equal(store.getState().activeId, "a");
  assert.deepEqual(persisted(), { b: unreadEntry });
});

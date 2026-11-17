import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { create } from "zustand";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
const toUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

test("todo ordering prefers todoAt and keeps existing cards stable", async () => {
  const { stableConversationOrder } = await import(
    toUrl(transpile(read("../src/components/CLI/conversationPanelData.ts")))
  );
  const todos = [
    {
      id: "t1",
      updatedAt: "2026-10-05T05:00:00Z",
      createdAt: "2026-10-01T00:00:00Z",
      todoAt: "2026-10-02T01:00:00Z"
    },
    {
      id: "t2",
      updatedAt: "2026-10-03T05:00:00Z",
      createdAt: "2026-10-01T00:00:00Z",
      todoAt: "2026-10-05T01:00:00Z"
    }
  ];
  const initial = stableConversationOrder([], todos, (c) => c.todoAt ?? c.updatedAt);
  assert.deepEqual(initial, ["t2", "t1"]);

  // Adding t3 puts it at the front while keeping t2, t1 in place; removing t2 drops it.
  const next = stableConversationOrder(
    initial,
    [
      todos[0],
      {
        id: "t3",
        updatedAt: "2026-10-06T00:00:00Z",
        createdAt: "2026-10-06T00:00:00Z",
        todoAt: "2026-10-06T00:00:00Z"
      }
    ],
    (c) => c.todoAt ?? c.updatedAt
  );
  assert.deepEqual(next, ["t3", "t1"]);
});

test("todo panel UI store keeps filters isolated from the all-conversations board store", async (t) => {
  const dependencyKey = "__todoUiStoreTest";
  globalThis[dependencyKey] = { create };
  t.after(() => { delete globalThis[dependencyKey]; });

  const source = transpile(read("../src/store/conversationPanelUiStore.ts")).replace(
    /from\s+["']zustand["']/,
    `from ${JSON.stringify(toUrl(`export const create = globalThis.${dependencyKey}.create;`))}`
  );
  const { useConversationPanelUiStore, useTodoPanelUiStore } = await import(toUrl(source));

  useConversationPanelUiStore.getState().setQuery("board-query");
  useConversationPanelUiStore.getState().setFilter("running");
  useTodoPanelUiStore.getState().setQuery("todo-query");
  useTodoPanelUiStore.getState().setFilter("unread");

  assert.equal(useConversationPanelUiStore.getState().query, "board-query");
  assert.equal(useConversationPanelUiStore.getState().filter, "running");
  assert.equal(useTodoPanelUiStore.getState().query, "todo-query");
  assert.equal(useTodoPanelUiStore.getState().filter, "unread");
});

test("todos view, navigation, actions, and locales are wired cleanly", async () => {
  const sidebar = read("../src/components/CLI/SidebarNavigation.tsx");
  const app = read("../src/App.tsx");
  const list = read("../src/components/CLI/ConversationList.tsx");
  const panel = read("../src/components/CLI/ConversationTaskPanel.tsx");
  const todoPanel = read("../src/components/CLI/TodoConversationsPanel.tsx");
  const presence = await import(toUrl(transpile(read("../electron/uiPresence.ts"))));
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));

  assert.match(sidebar, /WorkspaceView = [^;]*"todos"/);
  assert.match(sidebar, /onOpenTodos/);
  assert.match(sidebar, /sidebar-primary-badge/);
  assert.match(app, /workspaceView === "todos"/);
  assert.match(app, /<TodoConversationsPanel/);
  assert.match(app, /is-todo-active/);
  assert.match(list, /conv-todo-indicator/);
  assert.match(list, /todo-active/);
  assert.match(list, /setConversationTodo/);
  assert.match(panel, /ctp-todo-indicator/);
  assert.match(panel, /ctp-todo-done-button/);
  assert.match(todoPanel, /mode="todos"/);

  assert.ok(
    presence.parseMainWindowPresence({
      workspaceView: "todos",
      settingsOpen: false,
      settingsTab: null,
      activeConversation: null,
      streaming: false,
      runningTasks: [],
      completedUnreadTasks: [],
      unreadCount: 0,
      updatedAt: "2026-11-17T00:00:00.000Z"
    })
  );

  for (const locale of [en, zh]) {
    assert.ok(locale.sidebar?.todos);
    assert.ok(locale.sidebar?.todosCount);
    assert.ok(locale.conversations?.todoBadge);
    assert.ok(locale.conversations?.markTodo);
    assert.ok(locale.conversations?.unmarkTodo);
    for (const key of [
      "title",
      "searchPlaceholder",
      "markDone",
      "allConversations",
      "emptyTitle",
      "emptyHint",
      "browseConversations"
    ]) {
      assert.ok(locale.todoPanel?.[key], `missing todoPanel.${key}`);
    }
  }
});

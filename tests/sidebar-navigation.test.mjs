import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const loadTs = async (path) => {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
};

test("workspace shortcuts live in Settings by default and can be pinned to the sidebar", () => {
  const app = read("../src/App.tsx");
  const sidebar = read("../src/components/CLI/SidebarNavigation.tsx");
  const settings = read("../src/components/Settings/SettingsModal.tsx");
  const general = read("../src/components/Settings/GeneralTab.tsx");
  const store = read("../src/store/settingsStore.ts");
  const policy = read("../electron/shared/remoteChannelPolicy.ts");

  assert.match(app, /<SidebarNavigation/);
  assert.match(app, /workspaceView=\{workspaceView\}/);
  assert.match(app, /pinnedItems=\{sidebarPinnedItems\}/);
  assert.match(app, /onOpenScheduledTasks=\{openScheduledTasks\}/);
  assert.match(app, /onOpenTeams=\{\(\) => openWorkflowTeams\(\)\}/);
  assert.match(app, /onUnpinItem=\{\(id\) => void setSidebarNavPinned\(id, false\)\}/);
  assert.match(app, /onCustomizeSidebar=\{\(\) => openSettings\("general"\)\}/);
  assert.match(app, /<ScheduledTasksTab/);
  assert.match(app, /<WorkflowTeamsTab/);
  assert.match(app, /workspaceView === "scheduledTasks"/);
  assert.match(app, /workspaceView === "workflowTeams"/);
  assert.match(app, /settings-pin-toggle/);

  assert.match(sidebar, /sidebar-primary-nav/);
  assert.match(sidebar, /pinnedItems = DEFAULT_PINNED_SIDEBAR_ITEMS/);
  assert.match(sidebar, /const workflowTeamsActive = workspaceView === "workflowTeams"/);
  assert.match(sidebar, /aria-current=\{workflowTeamsActive \? "page" : undefined\}/);
  assert.match(sidebar, /<UsersRound \/>/);
  assert.match(sidebar, /onClick=\{onOpenTeams\}/);
  assert.match(sidebar, /trigger=\{\["contextMenu"\]\}/);
  assert.match(sidebar, /sidebar\.unpinFromSidebar/);
  assert.match(sidebar, /sidebar\.customizeSidebar/);
  assert.doesNotMatch(sidebar, /sidebar-team-section/);
  assert.doesNotMatch(sidebar, /sidebar-team-list/);
  assert.doesNotMatch(sidebar, /workflowTeamName/);
  assert.doesNotMatch(sidebar, /onStartTeam/);
  assert.doesNotMatch(sidebar, /onCreateTeam/);

  assert.match(settings, /key: "todos"/);
  assert.match(settings, /key: "scheduledTasks"/);
  assert.match(settings, /key: "workflowTeams"/);
  assert.match(settings, /key: "freebie"/);
  assert.match(settings, /settings\.navGroup\.workspace/);
  assert.match(settings, /<TodoConversationsPanel/);
  assert.match(settings, /<ScheduledTasksTab/);
  assert.match(settings, /<WorkflowTeamsTab/);
  assert.match(settings, /<FreebiePage/);
  assert.match(settings, /settings-nav-pin-btn/);

  assert.match(general, /PINNABLE_SIDEBAR_NAV_ITEMS/);
  assert.match(general, /sidebar-shortcuts-card/);
  assert.match(general, /setSidebarNavPinned/);
  assert.match(general, /moveSidebarNavPinned/);

  assert.match(store, /SIDEBAR_PINNED_ITEMS_SETTING_KEY/);
  assert.match(store, /sidebarPinnedItems/);
  assert.match(policy, /"ui\.sidebarPinnedItems"/);
});

test("sidebar navigation pinning helpers default unconfigured users to todos, teams, and freebie while preserving explicit empty configs", async () => {
  const nav = await loadTs("../src/config/sidebarNavigation.ts");
  const presence = await loadTs("../electron/uiPresence.ts");
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));

  const expectedDefault = ["todos", "workflowTeams", "freebie"];
  assert.deepEqual(nav.DEFAULT_PINNED_SIDEBAR_ITEMS, expectedDefault);
  assert.deepEqual(nav.normalizePinnedSidebarItems(null), expectedDefault);
  assert.deepEqual(nav.normalizePinnedSidebarItems(undefined), expectedDefault);
  assert.deepEqual(nav.normalizePinnedSidebarItems(""), expectedDefault);
  assert.deepEqual(nav.normalizePinnedSidebarItems("not-json"), expectedDefault);
  // Explicitly unpinning everything saves "[]" and must stay empty.
  assert.deepEqual(nav.normalizePinnedSidebarItems("[]"), []);
  assert.deepEqual(nav.normalizePinnedSidebarItems([]), []);
  assert.deepEqual(
    nav.normalizePinnedSidebarItems('["freebie","unknown","todos","freebie"]'),
    ["freebie", "todos"]
  );
  assert.equal(nav.isDefaultPinnedSidebarItems(expectedDefault), true);
  assert.equal(nav.isDefaultPinnedSidebarItems(["workflowTeams", "todos", "freebie"]), false);
  assert.equal(nav.isDefaultPinnedSidebarItems([]), false);

  // Pinning in canonical order keeps items cleanly sorted until manually reordered.
  let items = nav.togglePinnedSidebarItem([], "freebie", true);
  assert.deepEqual(items, ["freebie"]);
  items = nav.togglePinnedSidebarItem(items, "todos", true);
  assert.deepEqual(items, ["todos", "freebie"]);
  items = nav.togglePinnedSidebarItem(items, "scheduledTasks", true);
  assert.deepEqual(items, ["todos", "scheduledTasks", "freebie"]);

  // Reordering persists custom order, and pinning a new item appends to preserve custom order.
  items = nav.movePinnedSidebarItem(items, "freebie", "up");
  assert.deepEqual(items, ["todos", "freebie", "scheduledTasks"]);
  items = nav.togglePinnedSidebarItem(items, "workflowTeams", true);
  assert.deepEqual(items, ["todos", "freebie", "scheduledTasks", "workflowTeams"]);

  // Unpinning removes only the targeted entry.
  items = nav.togglePinnedSidebarItem(items, "freebie", false);
  assert.deepEqual(items, ["todos", "scheduledTasks", "workflowTeams"]);

  // UI presence accepts all newly added Settings tabs.
  for (const tab of ["todos", "scheduledTasks", "workflowTeams", "freebie"]) {
    assert.ok(
      presence.parseMainWindowPresence({
        workspaceView: "chat",
        settingsOpen: true,
        settingsTab: tab,
        activeConversation: null,
        streaming: false,
        runningTasks: [],
        completedUnreadTasks: [],
        unreadCount: 0,
        updatedAt: "2026-11-19T00:00:00.000Z"
      }),
      `uiPresence should accept settingsTab=${tab}`
    );
  }

  for (const locale of [en, zh]) {
    assert.ok(locale.settings?.navGroup?.workspace);
    assert.ok(locale.settings?.tabs?.todos);
    assert.ok(locale.settings?.tabs?.scheduledTasks);
    assert.ok(locale.settings?.tabs?.workflowTeams);
    assert.ok(locale.settings?.tabs?.freebie);
    assert.ok(locale.settings?.pinToSidebar);
    assert.ok(locale.settings?.pinnedToSidebar);
    assert.ok(locale.settings?.unpinFromSidebar);
    assert.ok(locale.sidebar?.unpinFromSidebar);
    assert.ok(locale.sidebar?.customizeSidebar);
    assert.ok(locale.general?.sidebarShortcutsTitle);
    assert.ok(locale.general?.sidebarShortcutsDescription);
    assert.ok(locale.general?.sidebarOrderLabel);
    assert.ok(locale.general?.sidebarResetDefault);
  }
});

test("team primary navigation opens the team workspace", () => {
  const app = read("../src/App.tsx");
  assert.match(app, /onOpenTeams=\{\(\) => openWorkflowTeams\(\)\}/);
  assert.match(app, /setWorkspaceView\("workflowTeams"\)/);
  assert.doesNotMatch(app, /onStartTeam=/);
  assert.doesNotMatch(app, /activeTeamId=/);
});

test("sidebar navigation matches the flat primary reference hierarchy", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  const css = read("../styles.css");

  for (const key of ["primaryNavigation", "newConversation", "scheduledTasks", "teams", "allTeams"]) {
    assert.ok(en.sidebar?.[key], `missing en sidebar.${key}`);
    assert.ok(zh.sidebar?.[key], `missing zh-CN sidebar.${key}`);
  }

  assert.equal(zh.conversations.title, "对话");
  assert.match(css, /\.sidebar-primary-nav\s*\{/);
  assert.match(css, /\.sidebar-primary-item\s*\{/);
  assert.match(css, /\.sidebar-primary-item\s*\{[^}]*color:\s*var\(--fb-text-secondary\);/m);
  assert.match(css, /\.sidebar-primary-item\s*\{[^}]*font-weight:\s*500;/m);
  assert.match(css, /\.sidebar-primary-item\.active\s*\{[^}]*font-weight:\s*500;/m);
  assert.doesNotMatch(css, /\.sidebar-team-section\s*\{/);
  assert.doesNotMatch(css, /\.sidebar-team-item\s*\{/);
  assert.match(css, /\.workspace-tool-page\s*\{/);
  assert.match(css, /\.app-shell\.tool-page-mode\s*\{/);
});

test("sidebar search opens a command palette instead of an inline list filter", () => {
  const app = read("../src/App.tsx");
  const conversations = read("../src/components/CLI/ConversationList.tsx");
  const palette = read("../src/components/CLI/ConversationCommandPalette.tsx");
  const css = read("../styles.css");
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));

  assert.match(app, /sidebar-search-button/);
  assert.match(app, /<ConversationCommandPalette/);
  assert.match(app, /setCommandPaletteOpen/);
  assert.match(app, /onNewTaskInProject=/);
  assert.match(conversations, /conv-project-trailing/);
  assert.match(conversations, /conv-project-action-btn/);
  assert.match(conversations, /newInProject/);
  assert.match(conversations, /conv-project-menu/);
  assert.match(conversations, /showRunningIndicator/);
  assert.match(conversations, /showUnreadIndicator/);
  assert.match(conversations, /conv-project-running-slot/);
  assert.match(conversations, /conv-project-unread-slot/);
  assert.match(conversations, /conv-projects-add/);
  assert.doesNotMatch(conversations, /conv-list-search-toggle/);
  assert.match(css, /\.command-palette\s*\{/);
  assert.match(css, /\.conv-project-toggle\s*\{/);
  assert.match(css, /\.conv-project-trailing\s*\{/);
  assert.match(css, /\.conv-project-running\s*\{/);
  assert.match(css, /\.conv-project-unread-slot\s*\{/);
  assert.ok(en.commandPalette?.title);
  assert.ok(zh.commandPalette?.title);
  assert.equal(zh.conversations.projects, "项目");
  assert.equal(zh.conversations.recent, "最近");
  assert.equal(zh.conversations.newInProject, "新建任务");
  assert.equal(zh.conversations.projectRunning, "项目内有任务正在运行");
  assert.equal(en.conversations.projectRunning, "A task is running in this project");
});

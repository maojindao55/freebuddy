import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("sidebar exposes scheduled tasks, teams, and conversations as first-class navigation", () => {
  const app = read("../src/App.tsx");
  const sidebar = read("../src/components/CLI/SidebarNavigation.tsx");
  const settings = read("../src/components/Settings/SettingsModal.tsx");

  assert.match(app, /<SidebarNavigation/);
  assert.match(app, /workspaceView=\{workspaceView\}/);
  assert.match(app, /onOpenScheduledTasks=\{openScheduledTasks\}/);
  assert.match(app, /onOpenTeams=\{\(\) => openWorkflowTeams\(\)\}/);
  assert.match(app, /<ScheduledTasksTab/);
  assert.match(app, /<WorkflowTeamsTab/);
  assert.match(app, /workspaceView === "scheduledTasks"/);
  assert.match(app, /workspaceView === "workflowTeams"/);

  assert.match(sidebar, /sidebar-primary-nav/);
  assert.match(sidebar, /sidebar-team-section/);
  assert.match(sidebar, /className="sidebar-section-title"/);
  assert.doesNotMatch(sidebar, /sidebar-section-title\$\{workspaceView/);
  assert.match(sidebar, /workflowTeamName/);
  assert.match(sidebar, /enabledTeams\.slice\(0, 2\)/);
  assert.match(sidebar, /sidebar-team-more/);
  assert.match(sidebar, /sidebar-team-more-icon/);
  assert.match(sidebar, /sidebar-team-more-chevron/);
  assert.match(sidebar, /sidebar\.allTeams/);
  assert.doesNotMatch(sidebar, /sidebar-team-more-count/);
  assert.match(sidebar, /onStartTeam\(team\.id\)/);
  assert.match(sidebar, /onCreateTeam/);

  assert.doesNotMatch(settings, /key: "workflowTeams"/);
  assert.doesNotMatch(settings, /key: "scheduledTasks"/);
  assert.doesNotMatch(settings, /<WorkflowTeamsTab/);
  assert.doesNotMatch(settings, /<ScheduledTasksTab/);
});

test("team sidebar rows open the existing team task mode", () => {
  const app = read("../src/App.tsx");
  const chat = read("../src/components/CLI/ChatView.tsx");
  const store = read("../src/store/newTaskUiStore.ts");

  assert.match(app, /onStartTeam=\{\(teamId\) => startNewTask\("team", teamId\)\}/);
  assert.match(app, /setRequestedTeamId\(teamId\)/);
  assert.match(chat, /requestedTeamId !== selectedTeamId/);
  assert.match(chat, /setSelectedTeamId\(requestedTeamId\)/);
  assert.match(store, /requestedTeamId\?: string/);
  assert.match(store, /setRequestedTeamId/);
});

test("sidebar navigation matches the compact grouped reference hierarchy", () => {
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
  assert.match(css, /\.sidebar-team-section\s*\{/);
  assert.match(css, /\.sidebar-team-item\s*\{/);
  assert.match(css, /\.sidebar-team-more\s*\{/);
  assert.match(css, /\.workspace-tool-page\s*\{/);
  assert.match(css, /\.app-shell\.tool-page-mode\s*\{/);
});

test("conversation list keeps search available behind a compact section action", () => {
  const conversations = read("../src/components/CLI/ConversationList.tsx");
  assert.match(conversations, /conv-list-search-toggle/);
  assert.match(conversations, /setSearchOpen/);
  assert.match(conversations, /<AgentAvatar/);
  assert.match(conversations, /className="conv-item-avatar"/);
});

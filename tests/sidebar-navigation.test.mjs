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
  assert.match(sidebar, /const workflowTeamsActive = workspaceView === "workflowTeams"/);
  assert.match(sidebar, /aria-current=\{workflowTeamsActive \? "page" : undefined\}/);
  assert.match(sidebar, /<UsersRound \/>/);
  assert.match(sidebar, /onClick=\{onOpenTeams\}/);
  assert.doesNotMatch(sidebar, /sidebar-team-section/);
  assert.doesNotMatch(sidebar, /sidebar-team-list/);
  assert.doesNotMatch(sidebar, /workflowTeamName/);
  assert.doesNotMatch(sidebar, /onStartTeam/);
  assert.doesNotMatch(sidebar, /onCreateTeam/);

  assert.doesNotMatch(settings, /key: "workflowTeams"/);
  assert.doesNotMatch(settings, /key: "scheduledTasks"/);
  assert.doesNotMatch(settings, /<WorkflowTeamsTab/);
  assert.doesNotMatch(settings, /<ScheduledTasksTab/);
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
  assert.doesNotMatch(conversations, /conv-list-search-toggle/);
  assert.match(css, /\.command-palette\s*\{/);
  assert.match(css, /\.conv-project-toggle\s*\{/);
  assert.match(css, /\.conv-project-trailing\s*\{/);
  assert.ok(en.commandPalette?.title);
  assert.ok(zh.commandPalette?.title);
  assert.equal(zh.conversations.projects, "项目");
  assert.equal(zh.conversations.recent, "最近");
  assert.equal(zh.conversations.newInProject, "新建任务");
});

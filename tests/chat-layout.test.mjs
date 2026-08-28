import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const chatViewSource = fs.readFileSync(
  new URL("../src/components/CLI/ChatView.tsx", import.meta.url),
  "utf8"
);
const appSource = fs.readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8"
);
const stylesSource = fs.readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8"
);
const sidebarNavigationSource = fs.readFileSync(
  new URL("../src/components/CLI/SidebarNavigation.tsx", import.meta.url),
  "utf8"
);

test("chat scroll leaves enough bottom clearance for the composer", () => {
  assert.match(stylesSource, /--chat-composer-reserve:\s*(1[6-9]\d|2[0-4]\d|250)px/);
  assert.match(
    stylesSource,
    /\.chat-scroll\s*\{[\s\S]*padding:[^;]*calc\(var\(--chat-composer-reserve\)[^;]*;/m
  );
  assert.match(
    stylesSource,
    /\.chat-scroll\s*\{[\s\S]*scroll-padding-bottom:\s*var\(--chat-composer-reserve\)/m
  );
});

test("desktop shell is pinned to the actual viewport in fullscreen", () => {
  assert.match(stylesSource, /html,\s*body,\s*#root\s*\{[\s\S]*height:\s*100%;/m);
  assert.match(stylesSource, /\.app-shell\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/m);
  assert.doesNotMatch(stylesSource, /\.app-shell\s*\{[^}]*\n\s*height:\s*100vh;/m);
});

test("workspace keeps the composer inside the visible column", () => {
  assert.match(stylesSource, /\.workspace\s*\{[^}]*overflow:\s*hidden;/m);
  assert.match(stylesSource, /\.chat-section\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*0;/m);
  assert.match(stylesSource, /\.chat-view\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto;/m);
  assert.match(stylesSource, /\.chat-composer\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*18px;/m);
  assert.match(stylesSource, /\.chat-composer\s*\{[^}]*left:\s*272px;[^}]*right:\s*var\(--fb-detail-width,\s*440px\);/m);
});

test("titlebar truncates long conversation titles to one line", () => {
  assert.match(
    stylesSource,
    /\.breadcrumb\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/m
  );
  assert.match(
    stylesSource,
    /\.breadcrumb strong\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/m
  );
  assert.match(appSource, /className="breadcrumb"[\s\S]*title=\{/m);
});

test("sending a message restores auto-follow to the latest output", () => {
  assert.match(
    chatViewSource,
    /const onSend = async \(\) => \{[\s\S]*isNearBottomRef\.current = true;[\s\S]*setSubmitPreview\(preview\)/m
  );
});

test("sidebar conversation list scrolls instead of being clipped", () => {
  assert.match(stylesSource, /\.sidebar\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/m);
  assert.match(
    stylesSource,
    /\.conv-list\s*\{[\s\S]*?min-height:\s*0;/
  );
  assert.match(
    stylesSource,
    /\.conv-list ul\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/
  );
});

test("sidebar collapse toggle hides the sidebar column", () => {
  assert.match(stylesSource, /\.sidebar-toggle\.floating\s*\{[\s\S]*?position:\s*absolute;/m);
  assert.match(
    stylesSource,
    /\.app-shell\.sidebar-collapsed\s*\{[\s\S]*?grid-template-columns:\s*minmax\(420px,\s*1fr\)\s*var\(--fb-detail-width,\s*440px\);/
  );
  assert.match(stylesSource, /\.sidebar-collapsed \.sidebar\s*\{[\s\S]*?display:\s*none;/m);
  assert.match(
    stylesSource,
    /\.sidebar-collapsed \.chat-composer\s*\{[\s\S]*?left:\s*0;/
  );
});

test("opening the browser preview collapses the conversation sidebar", () => {
  assert.match(appSource, /const activeDetailTab = useDetailLayoutStore\(\(s\) => s\.activeTab\)/);
  assert.match(
    appSource,
    /useEffect\(\(\) => \{[\s\S]*if \(activeDetailTab === "preview"\) \{[\s\S]*setSidebarCollapsed\(true\);[\s\S]*\}[\s\S]*\}, \[activeDetailTab\]\);/
  );
});

test("new-task page sending flag is not stuck true without an active conversation", () => {
  // submitPreview is null and conv is undefined on the new-task page, so both
  // sides would be `undefined`. The guard must require submitPreview !== null
  // or the attach button (which early-returns when sending) never works there.
  assert.match(
    chatViewSource,
    /const sending =\s*running \|\|\s*\(submitPreview !== null && submitPreview\.conversationId === conv\?\.id\);/m
  );
});

test("new-task page drops the hero heading, subtitle, and quick-prompt chips", () => {
  assert.doesNotMatch(chatViewSource, /className="new-task-hero"/);
  assert.doesNotMatch(chatViewSource, /className="new-task-subtitle"/);
  assert.doesNotMatch(chatViewSource, /className="new-task-chips"/);
  assert.doesNotMatch(chatViewSource, /newTaskPrompts/);
});

test("new-task page keeps task controls in one toolbar and workspace context below it", () => {
  // There is exactly one .new-task-toolbar row and no legacy workspace-picker.
  const toolbarOpenings = chatViewSource.match(/className="new-task-toolbar"/g) ?? [];
  assert.equal(toolbarOpenings.length, 1);
  assert.doesNotMatch(chatViewSource, /className="workspace-picker"/);

  // The single toolbar carries task controls; workspace context begins afterward.
  const newTaskHome = chatViewSource.slice(
    chatViewSource.indexOf("function NewTaskHome")
  );
  const toolbarStart = newTaskHome.indexOf('className="new-task-toolbar"');
  const contextStart = newTaskHome.indexOf(
    'data-testid="new-task-context-bar"',
    toolbarStart
  );
  const toolbar = newTaskHome.slice(toolbarStart, contextStart);
  assert.match(toolbar, /onSelectAttachments/);
  assert.match(toolbar, /onMember/);
  assert.match(toolbar, /onPermissionMode/);
  assert.match(toolbar, /className="new-task-send/);
  assert.doesNotMatch(toolbar, /selectWorkspace/);
  assert.ok(contextStart > toolbarStart);
});

test("new-task workspace context renders project, mode, and branch below the composer", () => {
  const newTaskHome = chatViewSource.slice(
    chatViewSource.indexOf("function NewTaskHome")
  );
  assert.match(newTaskHome, /data-testid="new-task-context-bar"/);
  assert.match(newTaskHome, /className="new-task-context-remove"/);
  assert.match(newTaskHome, /new-task-context-control new-task-context-project/);
  assert.match(newTaskHome, /workspaceModeWorktree/);
  assert.match(newTaskHome, /branchAria/);
  assert.match(newTaskHome, /t\("chat\.changeWorkspace"\)/);
  assert.match(newTaskHome, /aria-label=\{t\("chat\.removeWorkspace"\)\}/);
  assert.match(newTaskHome, /workspaceParts\[workspaceParts\.length - 1\]/);
  assert.doesNotMatch(newTaskHome, /className="new-task-cwd-input"/);
  assert.doesNotMatch(newTaskHome, /className="new-task-workspace-control"/);
  assert.match(
    stylesSource,
    /\.new-task-context-project span\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/m
  );
  assert.match(stylesSource, /\.new-task-context-remove\s*\{[^}]*width:\s*24px;[^}]*opacity:\s*0;/m);
  assert.match(
    stylesSource,
    /\.new-task-context-workspace:hover \.new-task-context-remove,\s*\.new-task-context-workspace:focus-within \.new-task-context-remove\s*\{[^}]*opacity:\s*1;/m
  );
  assert.match(stylesSource, /\.new-task-context-remove svg\s*\{[^}]*stroke-width:\s*1\.7;/m);
  assert.match(
    stylesSource,
    /\.task-context-dropdown-trigger\s*\{[^}]*border-radius:\s*9px;[^}]*transition:/m
  );
  assert.match(stylesSource, /\.task-context-dropdown-menu\s*\{[^}]*border-radius:\s*12px;[^}]*box-shadow:/m);
  assert.match(newTaskHome, /<TaskContextDropdown/);
  assert.match(chatViewSource, /aria-haspopup="dialog"/);
  assert.match(chatViewSource, /className="task-context-dropdown-search"/);
  assert.match(chatViewSource, /className="task-context-dropdown-create-trigger"/);
  assert.match(stylesSource, /\.task-context-dropdown-options\s*\{[^}]*overflow-y:\s*auto;/m);

  const context = newTaskHome.slice(
    newTaskHome.indexOf('data-testid="new-task-context-bar"')
  );
  assert.ok(context.indexOf('t("chat.branchAria")') < context.indexOf('t("chat.workspaceModeAria")'));
});

test("active composer presents the assigned source as an isolated workspace", () => {
  assert.match(chatViewSource, /conversationDisplayCwd\(conv\)/);
  assert.match(chatViewSource, /className="composer-workspace-name"/);
  assert.match(chatViewSource, /className="composer-workspace-badge"/);
  assert.match(chatViewSource, /t\("chat\.isolatedWorkspace"\)/);
  assert.match(chatViewSource, /t\("chat\.isolatedWorkspaceTooltip"/);
  assert.match(
    stylesSource,
    /\.composer-workspace-name\s*\{[^}]*text-overflow:\s*ellipsis;/m
  );
  assert.match(
    stylesSource,
    /\.composer-workspace-badge\s*\{[^}]*border-radius:\s*999px;/m
  );
});

test("sidebar primary navigation exposes a clear current page in team and normal task modes", () => {
  assert.match(
    sidebarNavigationSource,
    /const newTaskActive = workspaceView === "chat" && isNewTask;/
  );
  assert.doesNotMatch(sidebarNavigationSource, /isNewTask && !activeTeamId/);
  assert.match(sidebarNavigationSource, /aria-current=\{newTaskActive \? "page" : undefined\}/);
  assert.match(sidebarNavigationSource, /aria-current=\{scheduledTasksActive \? "page" : undefined\}/);
  assert.match(stylesSource, /\.sidebar-primary-nav\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/m);
  assert.match(stylesSource, /\.sidebar-primary-item\.active\s*\{[^}]*background:\s*var\(--fb-panel-soft\);[^}]*box-shadow:\s*none;/m);
  assert.match(stylesSource, /\.sidebar-primary-item\s*\{[^}]*font-weight:\s*500;/m);
  assert.match(stylesSource, /\.sidebar-primary-item\.active\s*\{[^}]*font-weight:\s*500;/m);
  assert.match(stylesSource, /\.sidebar-primary-icon\.new-task\s*\{[^}]*background:\s*transparent;/m);
  assert.match(stylesSource, /\.sidebar-primary-item:focus-visible\s*\{/);
});

test("new-task toolbar keeps agent compact and reuses the chat permission pill", () => {
  const newTaskHome = chatViewSource.slice(
    chatViewSource.indexOf("function NewTaskHome")
  );
  const toolbarStart = newTaskHome.indexOf('className="new-task-toolbar"');
  const toolbarEnd = newTaskHome.indexOf("new-task-warn", toolbarStart);
  const toolbar = newTaskHome.slice(toolbarStart, toolbarEnd);

  assert.match(toolbar, /<AgentPicker/);
  assert.match(toolbar, /groups=\{agentAvailability\}/);
  assert.doesNotMatch(toolbar, /<span>\{t\("chat\.agent"\)\}<\/span>/);
  assert.match(toolbar, /className="composer-permission"/);
  assert.match(toolbar, /className="composer-permission-label"/);
  assert.match(toolbar, /className="composer-permission-select"/);
});

test("team picker keeps its accessible label without a visible prefix", () => {
  const newTaskHome = chatViewSource.slice(
    chatViewSource.indexOf("function NewTaskHome")
  );
  assert.match(newTaskHome, /className="new-task-team-picker"/);
  assert.match(newTaskHome, /aria-label=\{t\("workflow\.selectTeam"\)\}/);
  assert.doesNotMatch(newTaskHome, /<span>\{t\("workflow\.selectTeam"\)\}<\/span>/);
});

test("new-task page separates normal and team modes into tabs above the composer", () => {
  const newTaskHome = chatViewSource.slice(
    chatViewSource.indexOf("function NewTaskHome")
  );
  const tabsStart = newTaskHome.indexOf('className="new-task-mode-tabs"');
  const composerStart = newTaskHome.indexOf("new-task-composer");
  assert.ok(tabsStart > -1, "missing new-task mode tabs");
  assert.ok(tabsStart < composerStart, "mode tabs should sit above the composer");
  assert.match(newTaskHome, /workflow\.normalMode/);
  assert.match(newTaskHome, /workflow\.teamExecution/);
  assert.doesNotMatch(newTaskHome, /new-task-mode-tab[^"]*"\$\{taskMode === "workflow"/);
});

test("sidebar brand uses the dedicated sidebar logo asset", () => {
  const brandMarkSource = appSource.match(/function BrandMark\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(appSource, /import\s+sidebarLogoUrl\s+from\s+"..\/assets\/sidebar-logo\.png"/);
  assert.match(appSource, /<img\s+src=\{sidebarLogoUrl\}\s+alt=""\s+className="sidebar-logo-img"\s*\/>/);
  assert.doesNotMatch(brandMarkSource, /<svg/m);
  assert.match(stylesSource, /\.sidebar-logo-img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*cover;/m);
});

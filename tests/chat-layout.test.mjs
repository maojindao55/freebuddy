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

test("opening the draft preview collapses the conversation sidebar", () => {
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

test("new-task page merges attach, workspace, agent, and send into one toolbar row", () => {
  // There is exactly one .new-task-toolbar row and no separate workspace-picker.
  const toolbarOpenings = chatViewSource.match(/className="new-task-toolbar"/g) ?? [];
  assert.equal(toolbarOpenings.length, 1);
  assert.doesNotMatch(chatViewSource, /className="workspace-picker"/);

  // The single toolbar must carry every control: attach, cwd, agent, permission, send.
  const newTaskHome = chatViewSource.slice(
    chatViewSource.indexOf("function NewTaskHome")
  );
  const toolbarStart = newTaskHome.indexOf('className="new-task-toolbar"');
  const toolbarEnd = newTaskHome.indexOf("new-task-warn", toolbarStart);
  const toolbar = newTaskHome.slice(toolbarStart, toolbarEnd);
  assert.match(toolbar, /onSelectAttachments/);
  assert.match(toolbar, /onCwd/);
  assert.match(toolbar, /onMember/);
  assert.match(toolbar, /onPermissionMode/);
  assert.match(toolbar, /className="new-task-send/);
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

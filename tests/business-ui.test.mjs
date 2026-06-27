import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("Settings modal exposes Business Workspaces tab", () => {
  const settings = read("../src/components/Settings/SettingsModal.tsx");
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  assert.match(settings, /BusinessWorkspacesTab/);
  assert.match(settings, /workflowTeams[\s\S]*businessWorkspaces[\s\S]*general/);
  assert.ok(en.settings.tabs.businessWorkspaces);
  assert.ok(zh.settings.tabs.businessWorkspaces);
});

test("Business workspace editor captures surfaces, repo paths, agents, and verify commands", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  assert.match(editor, /repoPath/);
  assert.match(editor, /defaultAgentId/);
  assert.match(editor, /verifyCommands/);
  assert.match(editor, /allowedPaths/);
  assert.match(editor, /contractRole/);
});

test("ChatView exposes business requirement mode and assignment preview", () => {
  const chat = read("../src/components/CLI/ChatView.tsx");
  const preview = read("../src/components/Business/BusinessAssignmentPreviewCard.tsx");
  assert.match(chat, /taskMode.*business/s);
  assert.match(chat, /businessRequirement/);
  assert.match(chat, /BusinessAssignmentPreviewCard/);
  assert.match(preview, /assignmentPlan\.surfaces/);
  assert.match(preview, /contractDraft/);
});

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

test("Business workspace editor captures repository projects, agents, and verify commands", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  assert.match(editor, /repoPath/);
  assert.match(editor, /defaultAgentId/);
  assert.match(editor, /verifyCommands/);
  assert.match(editor, /allowedPaths/);
  assert.match(editor, /contractRole/);
});

test("Business workspace editor uses a guided user-facing setup model", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));

  assert.match(editor, /WORKSPACE_TEMPLATES/);
  assert.match(editor, /applyTemplate/);
  assert.match(editor, /business\.setupBusiness/);
  assert.match(editor, /business\.codeRepositories/);
  assert.match(editor, /business\.collaboration/);
  assert.match(editor, /business\.advancedSettings/);
  assert.doesNotMatch(editor, /<span>\{t\("business\.contractRole"\)\}<\/span>/);

  assert.equal(zh.business.setupBusiness, "先说明这个业务");
  assert.equal(zh.business.codeRepositories, "它包含哪些代码仓库？");
  assert.equal(zh.business.collaboration, "它们如何协作？");
  assert.equal(zh.business.advancedSettings, "高级设置");
  assert.equal(en.business.codeRepositories, "Which code repositories are involved?");
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

test("WorkspacePanel mounts business surface run panel", () => {
  const workspacePanel = read("../src/components/CLI/WorkspacePanel.tsx");
  const panel = read("../src/components/Business/BusinessSurfaceRunPanel.tsx");
  assert.match(workspacePanel, /BusinessSurfaceRunPanel/);
  assert.match(panel, /surfaceRuns/);
  assert.match(panel, /verificationResults/);
  assert.match(panel, /commitGate/);
});

test("Business workspace editor exposes UX redesign i18n keys in both locales", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  const keys = [
    "chooseDirectory", "saveFailed", "nameRequired", "switchTemplateConfirm",
    "collaborationAndPolicy", "advancedCountHint", "createWorkspace", "templateRepoCount",
    "kind_client", "kind_server", "kind_admin", "kind_shared",
    "kind_docs", "kind_test", "kind_custom"
  ];
  for (const k of keys) {
    assert.ok(en.business[k], `en missing business.${k}`);
    assert.ok(zh.business[k], `zh missing business.${k}`);
  }
  // advancedCountHint / templateRepoCount must support interpolation
  assert.match(zh.business.advancedCountHint, /\{\{count\}\}/);
  assert.match(en.business.templateRepoCount, /\{\{count\}\}/);
});

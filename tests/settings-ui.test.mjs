import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const settingsSource = fs.readFileSync(
  new URL("../src/components/Settings/CLIAdaptersTab.tsx", import.meta.url),
  "utf8"
);
const storeSource = fs.readFileSync(
  new URL("../src/store/cliExecutorStore.ts", import.meta.url),
  "utf8"
);
const cliCheckSource = fs.readFileSync(
  new URL("../electron/cli/check.ts", import.meta.url),
  "utf8"
);
const preloadSource = fs.readFileSync(
  new URL("../electron/preload.ts", import.meta.url),
  "utf8"
);
const conversationStoreSource = fs.readFileSync(
  new URL("../src/store/conversationStore.ts", import.meta.url),
  "utf8"
);
const agentDisplaySource = fs.readFileSync(
  new URL("../src/config/agentDisplay.ts", import.meta.url),
  "utf8"
);
const zhLocale = JSON.parse(
  fs.readFileSync(new URL("../src/locales/zh-CN.json", import.meta.url), "utf8")
);
const enLocale = JSON.parse(
  fs.readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")
);

test("coding agent settings hide protocol command details by default", () => {
  assert.equal(settingsSource.includes("placeholder={ex.defaultBinary}"), false);
  assert.equal(settingsSource.includes("rt.binaryPath"), false);
  assert.equal(/<a[^>]*>\s*\{ex\.docsUrl\}\s*<\/a>/s.test(settingsSource), false);
});

test("coding agent settings expose model as a first-class field", () => {
  assert.equal(settingsSource.includes("Model"), true);
  assert.equal(settingsSource.includes("extractModelArg"), true);
  assert.equal(settingsSource.includes("withModelArg"), true);
});

test("coding agent settings expose Codex BYOK without echoing saved keys", () => {
  assert.equal(settingsSource.includes("settings.cli.byok.title"), true);
  assert.equal(settingsSource.includes("settings-choice-group"), true);
  assert.equal(settingsSource.includes("settings.cli.byok.modeCustom"), true);
  assert.equal(settingsSource.includes("settings.cli.byok.advanced"), true);
  assert.equal(settingsSource.includes("codexByok"), true);
  assert.equal(settingsSource.includes("claudeByok"), true);
  assert.equal(settingsSource.includes("ANTHROPIC_API_KEY"), true);
  assert.equal(settingsSource.includes("settings.cli.byok.baseUrlHintClaude"), true);
  assert.equal(settingsSource.includes("type=\"password\""), true);
  assert.equal(settingsSource.includes("apiKeyPreview"), true);
  assert.equal(settingsSource.includes("value={codexApiKey}"), true);
  assert.equal(settingsSource.includes("value={savedByok?.apiKey"), false);
  assert.equal(zhLocale.settings.cli.byok.title, "API Key");
  assert.equal(zhLocale.settings.cli.byok.modeCustom, "使用自己的 API Key");
  assert.equal(enLocale.settings.cli.byok.title, "API Key");
  assert.equal(enLocale.settings.cli.byok.modeCustom, "Use my own API key");
});

test("coding agent settings use an inline master detail editor", () => {
  assert.equal(settingsSource.includes("adapter-settings-workspace"), true);
  assert.equal(settingsSource.includes("adapter-editor-panel"), true);
  assert.equal(settingsSource.includes("EditOverridePanel"), true);
  assert.equal(settingsSource.includes("EditOverrideDialog"), false);
  assert.equal(settingsSource.includes("modal-backdrop"), false);
});

test("coding agent settings show save progress and reload public override state", () => {
  assert.equal(settingsSource.includes("saveStatus"), true);
  assert.equal(settingsSource.includes("settings.cli.saveSuccess"), true);
  assert.equal(settingsSource.includes("settings.cli.saveFailed"), true);
  assert.equal(settingsSource.includes("adapter-save-feedback"), true);
  assert.equal(storeSource.includes("await cliClient.listOverrides()"), true);
  assert.equal(zhLocale.common.saving, "保存中…");
  assert.equal(zhLocale.common.saved, "已保存");
  assert.equal(enLocale.common.saving, "Saving…");
  assert.equal(enLocale.common.saved, "Saved");
  assert.equal(zhLocale.settings.cli.saveSuccess, "已保存");
  assert.equal(enLocale.settings.cli.saveSuccess, "Saved");
});

test("coding agent reset and delete actions use the secondary footer style", () => {
  assert.equal(settingsSource.includes("adapter-secondary-action"), true);
  const footer = settingsSource.slice(settingsSource.indexOf("adapter-editor-actions"));
  assert.equal(footer.includes("onResetOrDelete"), true);
  assert.match(footer, /adapter-secondary-action/);
});

test("coding agent runtime stores Claude BYOK separately from Codex BYOK", () => {
  const electronStoreSource = fs.readFileSync(
    new URL("../electron/cli/store.ts", import.meta.url),
    "utf8"
  );
  const electronRuntimeSource = fs.readFileSync(
    new URL("../electron/cli/runtime.ts", import.meta.url),
    "utf8"
  );
  assert.equal(electronStoreSource.includes("claude_byok"), true);
  assert.equal(electronStoreSource.includes("resolveClaudeByokEnv"), true);
  assert.equal(electronStoreSource.includes("ANTHROPIC_API_KEY"), true);
  assert.equal(electronStoreSource.includes("ANTHROPIC_BASE_URL"), true);
  assert.equal(
    electronStoreSource.includes("model_supports_reasoning_summaries"),
    true
  );
  assert.equal(electronStoreSource.includes("model_catalog_json"), true);
  assert.equal(electronStoreSource.includes("codex-model-catalogs"), true);
  assert.equal(electronStoreSource.includes("CODEX_PATH"), true);
  assert.equal(electronStoreSource.includes("codex-wrappers"), true);
  assert.equal(electronStoreSource.includes("readCodexModelTemplate"), true);
  assert.equal(electronStoreSource.includes("readOverrideExtraArgs"), true);
  assert.equal(electronStoreSource.includes("secretDecryptCache"), true);
  assert.match(electronStoreSource, /secretDecryptCache\.get\(value\)/);
  assert.match(electronStoreSource, /secretDecryptCache\.set\(value, decrypted\)/);
  assert.equal(electronRuntimeSource.includes("resolveCliByokEnv"), true);
});

test("coding agent settings let only cloned agents rename their display label", () => {
  assert.equal(settingsSource.includes("settings.cli.name"), true);
  assert.equal(settingsSource.includes("const [label, setLabel]"), true);
  assert.equal(settingsSource.includes("const isClone = Boolean(ex.isClone)"), true);
  assert.match(settingsSource, /label:\s*isClone \? label\.trim\(\) \|\| ex\.label : undefined/);
  assert.match(settingsSource, /\{isClone && \(\s*<label>\s*\{t\("settings\.cli\.name"\)\}/s);
  assert.equal(conversationStoreSource.includes("syncConversationAgentNames"), true);
  assert.equal(conversationStoreSource.includes("updateConversationAgentName"), true);
  assert.equal(agentDisplaySource.includes("normalized !== adapterLabel"), true);
  assert.match(conversationStoreSource, /agentId:\s*member\.id,\s*agentName:\s*member\.name,\s*adapter:\s*member\.cli\.adapter/s);
  assert.equal(zhLocale.settings.cli.name, "名称");
  assert.equal(enLocale.settings.cli.name, "Name");
});

test("coding agent settings let only cloned agents be deleted", () => {
  assert.equal(settingsSource.includes("onResetOrDelete"), true);
  assert.equal(settingsSource.includes("settings.cli.deleteAgentConfirm"), true);
  assert.match(settingsSource, /\{isClone \? t\("common\.delete"\) : t\("common\.reset"\)\}/);
  assert.equal(zhLocale.settings.cli.deleteAgentConfirm, "删除 1 个 Agent“{{label}}”？");
  assert.equal(enLocale.settings.cli.deleteAgentConfirm, "Delete 1 agent \"{{label}}\"?");
});

test("coding agent settings support bulk check and auto-check on load", () => {
  assert.equal(settingsSource.includes("checkAll"), true);
  assert.equal(settingsSource.includes("handleCheckAll"), true);
  assert.equal(settingsSource.includes("installJobs"), true);
  assert.equal(settingsSource.includes("installingIdSet"), true);
  assert.equal(settingsSource.includes("sortAdapters"), true);
  assert.equal(settingsSource.includes("lastCheckAt"), false);
  assert.equal(storeSource.includes("async checkAll()"), true);
  assert.match(storeSource, /for \(const adapter of acpAdapters\)/);
});

test("cloned coding agents keep independent check status", () => {
  assert.equal(preloadSource.includes("runtimeAdapter"), true);
  assert.match(storeSource, /resolved\.env,\s*resolved\.id/s);
  assert.match(storeSource, /adapter\.env,\s*adapter\.id/s);
  assert.match(storeSource, /runtime:\s*isClone \? runtimes\[id\] : runtimes\[def\.id\]/);
  assert.match(cliCheckSource, /const runtimeKey = runtimeAdapter\?\.trim\(\) \|\| adapter/);
  assert.match(cliCheckSource, /upsertRuntime\(runtimeKey/);
});

test("coding agent checks search common desktop CLI install paths", () => {
  assert.equal(cliCheckSource.includes("mergedEnv.PATH"), true);
  assert.equal(cliCheckSource.includes("/opt/homebrew/bin"), true);
  assert.equal(cliCheckSource.includes("/usr/local/bin"), true);
});

test("coding agent settings explain binary lookup failures separately", () => {
  assert.equal(settingsSource.includes("cliRuntimeErrorKey"), true);
  assert.equal(settingsSource.includes("binary not found"), true);
  assert.equal(settingsSource.includes("settings.cli.commandNotFound"), true);
  assert.equal(settingsSource.includes("settings.cli.codexAcpUpgradeRequired"), true);
  assert.equal(settingsSource.includes("settings.cli.checkProbeFailed"), true);
  assert.equal(zhLocale.settings.cli.commandNotFound, "未找到命令");
  assert.equal(zhLocale.settings.cli.codexAcpUpgradeRequired, "需要新版 Codex ACP — 请安装");
  assert.equal(zhLocale.settings.cli.checkProbeFailed, "检测失败 — 请重试");
  assert.equal(enLocale.settings.cli.commandNotFound, "command not found");
  assert.equal(enLocale.settings.cli.codexAcpUpgradeRequired, "new Codex ACP required — install");
  assert.equal(enLocale.settings.cli.checkProbeFailed, "check failed — retry");
});

test("coding agent settings force-install the new Codex ACP when the old package is detected", () => {
  assert.equal(settingsSource.includes("needsForcedInstall"), true);
  assert.equal(settingsSource.includes("codex-acp requires @agentclientprotocol/codex-acp"), true);
  assert.equal(settingsSource.includes("autoInstallAttemptedRef"), true);
  assert.match(settingsSource, /startInstall\(\{\s*adapterId: ex\.id,\s*label: ex\.label,\s*command: ex\.installHint!/s);
});

test("avatar picker is compact until users choose to change the icon", () => {
  const avatarSource = fs.readFileSync(
    new URL("../src/components/Settings/AvatarPicker.tsx", import.meta.url),
    "utf8"
  );
  assert.equal(avatarSource.includes("avatar-picker-current"), true);
  assert.equal(avatarSource.includes("setExpanded"), true);
  assert.match(avatarSource, /\{expanded && \(/);
  assert.equal(zhLocale.settings.cli.changeAvatar, "更换");
  assert.equal(enLocale.settings.cli.changeAvatar, "Change");
});

test("coding agent settings can clone agents from a base adapter", () => {
  assert.equal(settingsSource.includes("handleClone"), true);
  assert.equal(settingsSource.includes("baseAdapter"), true);
  assert.equal(settingsSource.includes("common.clone"), true);
  assert.equal(storeSource.includes("override.baseAdapter"), true);
  assert.equal(storeSource.includes("isClone"), true);
  assert.equal(conversationStoreSource.includes("buildConversationMembers"), true);
  assert.equal(conversationStoreSource.includes("executor.baseAdapter!"), true);
  assert.equal(zhLocale.common.clone, "克隆");
  assert.equal(enLocale.common.clone, "Clone");
});

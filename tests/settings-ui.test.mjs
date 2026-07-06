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

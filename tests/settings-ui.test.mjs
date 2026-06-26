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
  assert.equal(settingsSource.includes("settings.cli.checkProbeFailed"), true);
  assert.equal(zhLocale.settings.cli.commandNotFound, "未找到命令");
  assert.equal(zhLocale.settings.cli.checkProbeFailed, "检测失败 — 请重试");
  assert.equal(enLocale.settings.cli.commandNotFound, "command not found");
  assert.equal(enLocale.settings.cli.checkProbeFailed, "check failed — retry");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");

test("Electron main registers Windows Explorer verbs and --open handling", () => {
  const mainTs = read("electron/main.ts");
  assert.match(mainTs, /applyWindowsContextMenu/);
  assert.match(mainTs, /applyWindowsExplorerCommandPackage/);
  assert.match(mainTs, /collectLaunchShellOpenPaths/);
  assert.match(mainTs, /enqueueShellOpenPaths/);
  assert.match(mainTs, /freebuddy:\/\/shell-open/);
  assert.match(mainTs, /app\.on\("open-file"/);
  assert.match(mainTs, /app\.on\("second-instance"/);
  assert.match(mainTs, /prepareAttachmentFiles/);
});

test("Preload exposes onShellOpen listener", () => {
  const preloadTs = read("electron/preload.ts");
  assert.match(preloadTs, /onShellOpen/);
  assert.match(preloadTs, /freebuddy:\/\/shell-open/);
});

test("App routes shell-open into a new-task workspace", () => {
  const app = read("src/App.tsx");
  assert.match(app, /onShellOpen/);
  assert.match(app, /requestNewTask\(\{[\s\S]*cwd:\s*payload\.cwd/);
  const en = JSON.parse(read("src/locales/en.json"));
  const zh = JSON.parse(read("src/locales/zh-CN.json"));
  assert.equal(typeof en.shellOpen.openedFolder, "string");
  assert.equal(typeof zh.shellOpen.openedFolder, "string");
  assert.equal(typeof en.shellOpen.openedFiles, "string");
  assert.equal(typeof zh.shellOpen.openedFolderWithFiles, "string");
});

test("NSIS uninstall removes Explorer context-menu keys", () => {
  const builder = read("electron-builder.yml");
  assert.match(builder, /include:\s+desktop\/windows\/installer\.nsh/);
  assert.match(builder, /afterPack:\s+scripts\/after-pack\.mjs/);
  const nsh = read("desktop/windows/installer.nsh");
  assert.match(nsh, /customUnInstall/);
  assert.match(nsh, /Directory\\shell\\FreeBuddy/);
  assert.match(nsh, /Classes\\\*\\shell\\FreeBuddy/);
  assert.match(nsh, /uninstall-explorer-command\.ps1/);
  assert.match(nsh, /Remove-AppxPackage|uninstall-explorer-command/);
});

test("macOS pack registers Finder Open With and a Quick Action", () => {
  const builder = read("electron-builder.yml");
  assert.match(builder, /extendInfo:/);
  assert.match(builder, /public\.folder/);
  assert.match(builder, /LSHandlerRank:\s+Alternate/);
  const afterPack = read("scripts/after-pack.mjs");
  assert.match(afterPack, /after-pack-macos\.mjs/);
  assert.match(afterPack, /packWindowsExplorerCommand/);
  const macosAfterPack = read("scripts/after-pack-macos.mjs");
  assert.match(macosAfterPack, /writeMacOpenWithService/);
  assert.match(macosAfterPack, /dev\.freebuddy\.app\.dev/);
  const mainTs = read("electron/main.ts");
  assert.match(mainTs, /app\.on\("open-file"/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  devBundleIdentifierForWorkspace,
  prepareMacElectronShell
} from "../scripts/electron-shell.mjs";

const electronShellSource = fs.readFileSync(new URL("../scripts/electron-shell.mjs", import.meta.url), "utf8");
const electronBuilderConfig = fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");

test("macOS shell preparation does not depend on macOS-only plist tools", () => {
  assert.doesNotMatch(electronShellSource, /\/usr\/libexec\/PlistBuddy/);
});

test("missing Electron runtime reports recovery command and preserves existing shell", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-electron-missing-"));
  const targetApp = path.join(tmp, "FreeBuddy.app");
  fs.mkdirSync(targetApp);
  fs.writeFileSync(path.join(targetApp, "existing"), "keep");
  assert.throws(() => prepareMacElectronShell({
    sourceApp: path.join(tmp, "missing.app"), targetApp
  }), /node node_modules\/electron\/install.js/);
  assert.equal(fs.readFileSync(path.join(targetApp, "existing"), "utf8"), "keep");
});

test("prepareMacElectronShell creates a FreeBuddy-named macOS app shell with freebuddy-dev scheme at root dict", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-electron-shell-"));
  const sourceApp = path.join(tmp, "Electron.app");
  const targetApp = path.join(tmp, "FreeBuddy.app");
  const iconPath = path.join(tmp, "AppIcon.icns");

  fs.mkdirSync(path.join(sourceApp, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(sourceApp, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(sourceApp, "Contents", "MacOS", "Electron"), "");
  fs.chmodSync(path.join(sourceApp, "Contents", "MacOS", "Electron"), 0o755);
  fs.writeFileSync(
    path.join(sourceApp, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Electron</string>
  <key>CFBundleExecutable</key>
  <string>Electron</string>
  <key>CFBundleIdentifier</key>
  <string>com.github.Electron</string>
  <key>CFBundleName</key>
  <string>Electron</string>
  <key>CFBundleIconFile</key>
  <string>electron</string>
  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/default_app.asar</key>
    <dict>
      <key>algorithm</key>
      <string>SHA256</string>
      <key>hash</key>
      <string>abc</string>
    </dict>
  </dict>
</dict>
</plist>
`
  );
  fs.writeFileSync(iconPath, "icon");

  const executable = prepareMacElectronShell({
    sourceApp,
    targetApp,
    appName: "FreeBuddy",
    bundleIdentifier: "dev.freebuddy.electron",
    iconPath
  });

  const targetPlistPath = path.join(targetApp, "Contents", "Info.plist");
  const targetInfo = fs.readFileSync(targetPlistPath, "utf8");
  assert.equal(executable, path.join(targetApp, "Contents", "MacOS", "Electron"));
  assert.match(targetInfo, /<key>CFBundleDisplayName<\/key>\s*<string>FreeBuddy<\/string>/);
  assert.match(targetInfo, /<key>CFBundleName<\/key>\s*<string>FreeBuddy<\/string>/);
  assert.match(targetInfo, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.freebuddy\.electron<\/string>/);
  assert.match(targetInfo, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/);
  assert.match(targetInfo, /<key>CFBundleURLTypes<\/key>[\s\S]*<string>freebuddy-dev<\/string>/);
  assert.doesNotMatch(targetInfo, /<string>freebuddy<\/string>/);

  // CFBundleURLTypes must live in the root <dict>, after the nested ElectronAsarIntegrity <dict>.
  const integrityIdx = targetInfo.indexOf("<key>ElectronAsarIntegrity</key>");
  const urlTypesIdx = targetInfo.indexOf("<key>CFBundleURLTypes</key>");
  assert.ok(integrityIdx !== -1 && urlTypesIdx > integrityIdx);
  assert.equal(fs.readFileSync(path.join(targetApp, "Contents", "Resources", "AppIcon.icns"), "utf8"), "icon");

  if (process.platform === "darwin") {
    execFileSync("plutil", ["-lint", targetPlistPath]);
    const json = JSON.parse(
      execFileSync("plutil", ["-convert", "json", "-o", "-", targetPlistPath], { encoding: "utf8" })
    );
    assert.deepEqual(json.CFBundleURLTypes?.[0]?.CFBundleURLSchemes, ["freebuddy-dev"]);
    assert.equal(json.ElectronAsarIntegrity?.CFBundleURLTypes, undefined);
  }
});

test("electron-builder.yml registers freebuddy only and does not claim freebuddy-dev", () => {
  const protocolsMatch = electronBuilderConfig.match(/protocols:\s*\n([\s\S]*?)\ndirectories:/);
  assert.ok(protocolsMatch, "protocols section should exist in electron-builder.yml");
  assert.match(protocolsMatch[1], /-\s*freebuddy\b/);
  assert.doesNotMatch(protocolsMatch[1], /freebuddy-dev/);
});

test("devBundleIdentifierForWorkspace produces deterministic, workspace-distinct bundle IDs", () => {
  const idA = devBundleIdentifierForWorkspace("/tmp/freebuddy-repo-a");
  const idB = devBundleIdentifierForWorkspace("/tmp/freebuddy-repo-b");
  const idASame = devBundleIdentifierForWorkspace("/tmp/freebuddy-repo-a/");
  assert.match(idA, /^dev\.freebuddy\.electron\.[0-9a-f]{8}$/);
  assert.equal(idA, idASame);
  assert.notEqual(idA, idB);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareMacElectronShell } from "../scripts/electron-shell.mjs";

test("prepareMacElectronShell creates a FreeBuddy-named macOS app shell", () => {
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

  const targetInfo = fs.readFileSync(path.join(targetApp, "Contents", "Info.plist"), "utf8");
  assert.equal(executable, path.join(targetApp, "Contents", "MacOS", "Electron"));
  assert.match(targetInfo, /<key>CFBundleDisplayName<\/key>\s*<string>FreeBuddy<\/string>/);
  assert.match(targetInfo, /<key>CFBundleName<\/key>\s*<string>FreeBuddy<\/string>/);
  assert.match(targetInfo, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.freebuddy\.electron<\/string>/);
  assert.match(targetInfo, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/);
  assert.equal(fs.readFileSync(path.join(targetApp, "Contents", "Resources", "AppIcon.icns"), "utf8"), "icon");
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const APP_NAME = "FreeBuddy";
export const DEV_BUNDLE_ID = "dev.freebuddy.electron";

function setPlistString(plistPath, key, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath], {
      stdio: "ignore"
    });
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plistPath], {
      stdio: "ignore"
    });
  }
}

export function prepareMacElectronShell({
  sourceApp,
  targetApp,
  appName = APP_NAME,
  bundleIdentifier = DEV_BUNDLE_ID,
  iconPath
}) {
  const contentsDir = path.join(targetApp, "Contents");
  const resourcesDir = path.join(contentsDir, "Resources");
  const plistPath = path.join(contentsDir, "Info.plist");

  fs.rmSync(targetApp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetApp), { recursive: true });
  fs.cpSync(sourceApp, targetApp, {
    recursive: true,
    force: true,
    verbatimSymlinks: true
  });

  setPlistString(plistPath, "CFBundleDisplayName", appName);
  setPlistString(plistPath, "CFBundleName", appName);
  setPlistString(plistPath, "CFBundleIdentifier", bundleIdentifier);

  if (iconPath && fs.existsSync(iconPath)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.copyFileSync(iconPath, path.join(resourcesDir, "AppIcon.icns"));
    setPlistString(plistPath, "CFBundleIconFile", "AppIcon");
  }

  return path.join(targetApp, "Contents", "MacOS", "Electron");
}

export function resolveElectronCommand(rootDir, entryPoint) {
  if (process.platform !== "darwin") {
    return {
      command: "npm",
      args: ["exec", "electron", "--", entryPoint]
    };
  }

  const executable = prepareMacElectronShell({
    sourceApp: path.join(rootDir, "node_modules/electron/dist/Electron.app"),
    targetApp: path.join(rootDir, "build/electron-dev/FreeBuddy.app"),
    iconPath: path.join(rootDir, "desktop/macos/AppIcon.icns")
  });

  return {
    command: executable,
    args: [entryPoint]
  };
}

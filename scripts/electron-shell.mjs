import fs from "node:fs";
import path from "node:path";

export const APP_NAME = "FreeBuddy";
export const DEV_BUNDLE_ID = "dev.freebuddy.electron";

function escapePlistString(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setPlistString(plistPath, key, value) {
  const escapedValue = escapePlistString(value);
  let plist = fs.readFileSync(plistPath, "utf8");
  const keyPattern = new RegExp(
    `(<key>${key}</key>\\s*<string>)[\\s\\S]*?(</string>)`
  );

  if (keyPattern.test(plist)) {
    plist = plist.replace(keyPattern, `$1${escapedValue}$2`);
  } else if (plist.includes("</dict>")) {
    plist = plist.replace("</dict>", `  <key>${key}</key>\n  <string>${escapedValue}</string>\n</dict>`);
  } else {
    throw new Error(`${plistPath} is missing a plist <dict>`);
  }

  fs.writeFileSync(plistPath, plist);
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

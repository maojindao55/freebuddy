import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const APP_NAME = "FreeBuddy";
export const DEV_BUNDLE_ID = "dev.freebuddy.electron";
export const DEV_URL_SCHEMES = ["freebuddy-dev"];
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export function devBundleIdentifierForWorkspace(rootDir) {
  const hash = crypto
    .createHash("sha256")
    .update(path.resolve(rootDir))
    .digest("hex")
    .slice(0, 8);
  return `${DEV_BUNDLE_ID}.${hash}`;
}

function escapePlistString(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function insertBeforeRootDictEnd(plist, block) {
  const closeIdx = plist.lastIndexOf("</dict>");
  if (closeIdx === -1) {
    throw new Error("Info.plist is missing a closing </dict>");
  }
  const prefix = plist.slice(0, closeIdx);
  const needsNewline = prefix.length > 0 && !prefix.endsWith("\n");
  return `${prefix}${needsNewline ? "\n" : ""}${block}\n${plist.slice(closeIdx)}`;
}

function setPlistString(plistPath, key, value) {
  const escapedValue = escapePlistString(value);
  let plist = fs.readFileSync(plistPath, "utf8");
  const keyPattern = new RegExp(
    `(<key>${key}</key>\\s*<string>)[\\s\\S]*?(</string>)`
  );

  if (keyPattern.test(plist)) {
    plist = plist.replace(keyPattern, `$1${escapedValue}$2`);
  } else {
    plist = insertBeforeRootDictEnd(
      plist,
      `  <key>${key}</key>\n  <string>${escapedValue}</string>`
    );
  }

  fs.writeFileSync(plistPath, plist);
}

function setPlistUrlSchemes(
  plistPath,
  urlSchemes,
  urlName = "FreeBuddy Dev URL Protocol"
) {
  let plist = fs.readFileSync(plistPath, "utf8");
  const schemesXml = urlSchemes
    .map((scheme) => `        <string>${escapePlistString(scheme)}</string>`)
    .join("\n");
  const urlTypesBlock = [
    "  <key>CFBundleURLTypes</key>",
    "  <array>",
    "    <dict>",
    "      <key>CFBundleTypeRole</key>",
    "      <string>Editor</string>",
    "      <key>CFBundleURLName</key>",
    `      <string>${escapePlistString(urlName)}</string>`,
    "      <key>CFBundleURLSchemes</key>",
    "      <array>",
    schemesXml,
    "      </array>",
    "    </dict>",
    "  </array>"
  ].join("\n");

  const selfClosingMatch = /<key>CFBundleURLTypes<\/key>\s*<array\s*\/>/.exec(plist);
  if (selfClosingMatch) {
    plist =
      plist.slice(0, selfClosingMatch.index) +
      urlTypesBlock.trimStart() +
      plist.slice(selfClosingMatch.index + selfClosingMatch[0].length);
    fs.writeFileSync(plistPath, plist);
    return;
  }

  const openMatch = /<key>CFBundleURLTypes<\/key>\s*<array\b[^>]*>/.exec(plist);
  if (openMatch) {
    const tagPattern = /<\/?array\b[^>]*>/g;
    tagPattern.lastIndex = openMatch.index + openMatch[0].length;
    let depth = 1;
    let tagMatch;
    while ((tagMatch = tagPattern.exec(plist)) !== null) {
      if (tagMatch[0].startsWith("</")) {
        depth -= 1;
        if (depth === 0) {
          const replaceEnd = tagMatch.index + tagMatch[0].length;
          plist =
            plist.slice(0, openMatch.index) +
            urlTypesBlock.trimStart() +
            plist.slice(replaceEnd);
          fs.writeFileSync(plistPath, plist);
          return;
        }
      } else if (!tagMatch[0].endsWith("/>")) {
        depth += 1;
      }
    }
    throw new Error(`${plistPath} has unbalanced CFBundleURLTypes <array>`);
  }

  plist = insertBeforeRootDictEnd(plist, urlTypesBlock);
  fs.writeFileSync(plistPath, plist);
}

export function prepareMacElectronShell({
  sourceApp,
  targetApp,
  appName = APP_NAME,
  bundleIdentifier = DEV_BUNDLE_ID,
  iconPath,
  urlSchemes = DEV_URL_SCHEMES
}) {
  if (!fs.existsSync(sourceApp)) {
    throw new Error("Electron runtime is missing. Run `node node_modules/electron/install.js` before starting FreeBuddy.");
  }
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

  if (Array.isArray(urlSchemes) && urlSchemes.length > 0) {
    setPlistUrlSchemes(plistPath, urlSchemes);
  }

  const devAppex = path.join(path.dirname(path.dirname(targetApp)), ".build/macos/FreeBuddyShareDev.appex");
  if (fs.existsSync(devAppex)) {
    const pluginsDir = path.join(contentsDir, "PlugIns");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.cpSync(devAppex, path.join(pluginsDir, "FreeBuddyShare.appex"), { recursive: true });
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

  const targetApp = path.join(rootDir, "build/electron-dev/FreeBuddy.app");
  const executable = prepareMacElectronShell({
    sourceApp: path.join(rootDir, "node_modules/electron/dist/Electron.app"),
    targetApp,
    bundleIdentifier: devBundleIdentifierForWorkspace(rootDir),
    iconPath: path.join(rootDir, "desktop/macos/AppIcon.icns")
  });

  if (fs.existsSync(LSREGISTER)) {
    try {
      execFileSync(LSREGISTER, ["-f", targetApp], { stdio: "ignore" });
    } catch {
      // Non-fatal: protocol registration still works if already indexed.
    }
  }

  return {
    command: executable,
    args: [entryPoint]
  };
}

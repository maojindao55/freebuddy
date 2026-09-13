import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShareExtension } from "./build-macos-share-extension.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function patchAsar(targetAsarPath) {
  const tempExtract = `/tmp/freebuddy-asar-patch-${Date.now()}`;
  fs.rmSync(tempExtract, { recursive: true, force: true });
  execSync(`npx asar extract "${targetAsarPath}" "${tempExtract}"`, { stdio: "inherit" });

  fs.cpSync(path.join(rootDir, "dist"), path.join(tempExtract, "dist"), {
    recursive: true
  });
  fs.cpSync(path.join(rootDir, "dist-electron"), path.join(tempExtract, "dist-electron"), {
    recursive: true
  });

  execSync(`npx asar pack "${tempExtract}" "${targetAsarPath}"`, { stdio: "inherit" });
  fs.rmSync(tempExtract, { recursive: true, force: true });
}

function updatePlistValue(plistPath, key, value) {
  let content = fs.readFileSync(plistPath, "utf-8");
  const regex = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (regex.test(content)) {
    content = content.replace(regex, `$1${value}$2`);
  } else {
    content = content.replace("</dict>", `  <key>${key}</key>\n  <string>${value}</string>\n</dict>`);
  }
  fs.writeFileSync(plistPath, content);
}

export function deployApp(isDev = false) {
  const appName = isDev ? "FreeBuddy Dev" : "FreeBuddy";
  const targetApp = `/Applications/${appName}.app`;
  const bundleId = isDev ? "dev.freebuddy.app.dev" : "dev.freebuddy.app";
  const shareBundleId = isDev ? "dev.freebuddy.app.dev.share" : "dev.freebuddy.app.share";
  const baseApp = "/Applications/FreeBuddy.app";

  if (!fs.existsSync(targetApp)) {
    if (isDev && fs.existsSync(baseApp)) {
      console.log(`[deploy] Creating ${targetApp} from base app...`);
      execSync(`cp -R "${baseApp}" "${targetApp}"`);
    } else {
      console.error(`Target app not found: ${targetApp}`);
      return;
    }
  }

  console.log(`[deploy] Building ${appName} Share Extension...`);
  const appexSource = buildShareExtension({ silent: false, isDev });

  console.log(`[deploy] Patching ${appName} app.asar...`);
  const asarPath = path.join(targetApp, "Contents", "Resources", "app.asar");
  patchAsar(asarPath);

  // Update app Info.plist
  const appPlist = path.join(targetApp, "Contents", "Info.plist");
  updatePlistValue(appPlist, "CFBundleDisplayName", appName);
  updatePlistValue(appPlist, "CFBundleName", appName);
  updatePlistValue(appPlist, "CFBundleIdentifier", bundleId);

  if (isDev) {
    let plistContent = fs.readFileSync(appPlist, "utf-8");
    if (!plistContent.includes("freebuddy-dev")) {
      const urlTypesSnippet = `
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>FreeBuddy Dev Protocol</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>freebuddy-dev</string>
        <string>freebuddy</string>
      </array>
    </dict>
  </array>
</dict>`;
      plistContent = plistContent.replace("</dict>", urlTypesSnippet);
      fs.writeFileSync(appPlist, plistContent);
    }
  }

  console.log(`[deploy] Installing Share Extension into ${targetApp}...`);
  const pluginsDir = path.join(targetApp, "Contents", "PlugIns");
  fs.mkdirSync(pluginsDir, { recursive: true });
  const targetAppex = path.join(pluginsDir, "FreeBuddyShare.appex");
  fs.rmSync(targetAppex, { recursive: true, force: true });
  fs.cpSync(appexSource, targetAppex, { recursive: true });

  const entitlements = path.join(
    rootDir,
    "desktop",
    "macos",
    "ShareExtension",
    "FreeBuddyShare.entitlements"
  );
  try {
    execSync(`codesign --force --sign - --entitlements "${entitlements}" "${targetAppex}"`, {
      stdio: "ignore"
    });
    execSync(`codesign --force --sign - "${targetApp}"`, {
      stdio: "ignore"
    });
  } catch {}

  if (fs.existsSync(LSREGISTER)) {
    try {
      execSync(`"${LSREGISTER}" -f "${targetApp}"`, { stdio: "ignore" });
    } catch {}
  }
  try {
    execSync(`pluginkit -a "${targetAppex}"`, { stdio: "ignore" });
    execSync(`pluginkit -e use -i ${shareBundleId}`, { stdio: "ignore" });
  } catch {}

  console.log(`[deploy] ✅ 成功部署 ${appName} 到 ${targetApp} (Bundle ID: ${bundleId})！`);
}

export function deployToApplications() {
  const args = process.argv.slice(2);
  const isDevOnly = args.includes("--dev");
  const isProdOnly = args.includes("--prod");

  console.log("[deploy] 1. Building latest renderer and electron bundles...");
  execSync("npm run build:electron && npm run build:renderer", {
    cwd: rootDir,
    stdio: "inherit"
  });

  if (isDevOnly) {
    deployApp(true);
  } else if (isProdOnly) {
    deployApp(false);
  } else {
    // Default: deploy both Prod and Dev apps
    deployApp(false);
    deployApp(true);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  deployToApplications();
}

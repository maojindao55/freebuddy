import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShareExtension } from "./build-macos-share-extension.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export function registerShareExtension() {
  if (process.platform !== "darwin") {
    console.error("Registering macOS Share Extension is only supported on macOS.");
    process.exit(1);
  }

  const appexSource = buildShareExtension({ silent: false });
  if (!appexSource || !fs.existsSync(appexSource)) {
    console.error("Failed to find built FreeBuddyShare.appex.");
    process.exit(1);
  }

  const appPaths = [
    "/Applications/FreeBuddy.app",
    path.join(rootDir, "build", "FreeBuddy.app")
  ];

  let targetApp = appPaths.find((p) => fs.existsSync(p));
  if (!targetApp) {
    targetApp = "/Applications/FreeBuddy.app";
    console.warn(`[register] Neither /Applications/FreeBuddy.app nor build/FreeBuddy.app found.`);
  }

  const pluginsDir = path.join(targetApp, "Contents", "PlugIns");
  fs.mkdirSync(pluginsDir, { recursive: true });
  const targetAppex = path.join(pluginsDir, "FreeBuddyShare.appex");
  fs.rmSync(targetAppex, { recursive: true, force: true });
  fs.cpSync(appexSource, targetAppex, { recursive: true });
  console.log(`[register] Copied FreeBuddyShare.appex to: ${targetAppex}`);

  // Re-sign appex if codesign is available
  try {
    const entitlements = path.join(
      rootDir,
      "desktop",
      "macos",
      "ShareExtension",
      "FreeBuddyShare.entitlements"
    );
    execSync(`codesign --force --sign - --entitlements "${entitlements}" "${targetAppex}"`, {
      stdio: "ignore"
    });
  } catch {}

  // Register with LaunchServices
  if (fs.existsSync(LSREGISTER)) {
    try {
      execSync(`"${LSREGISTER}" -f "${targetApp}"`, { stdio: "ignore" });
      console.log(`[register] Registered ${targetApp} with LaunchServices.`);
    } catch (e) {
      console.warn(`[register] lsregister warning:`, e);
    }
  }

  // Register with pluginkit
  try {
    execSync(`pluginkit -a "${targetAppex}"`, { stdio: "ignore" });
    execSync(`pluginkit -e use -i dev.freebuddy.app.share`, { stdio: "ignore" });
  } catch {}

  // Verify status
  try {
    const status = execSync(`pluginkit -m -v -i dev.freebuddy.app.share`, {
      encoding: "utf8"
    }).trim();
    if (status) {
      console.log(`[register] Extension status:\n${status}`);
      console.log(`\n🎉 成功注册！微信中“转发到其他应用” -> “选择电脑中的应用”现已包含【发送到 FreeBuddy】。`);
    } else {
      console.log(`[register] Extension installed into ${targetAppex}.`);
      console.log(`提示：若在微信中未看到，请打开【系统设置 -> 隐私与安全性 -> 扩展 -> 分享菜单】勾选开启。`);
    }
  } catch (e) {
    console.log(`[register] Installed to ${targetAppex}.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  registerShareExtension();
}

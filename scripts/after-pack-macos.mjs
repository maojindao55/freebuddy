import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShareExtension } from "./build-macos-share-extension.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const isDev =
    context.packager.appInfo.productFilename?.toLowerCase().includes("dev") ||
    context.packager.config?.appId?.includes(".dev") ||
    false;

  const appexSource = buildShareExtension({ silent: false, isDev });
  if (!appexSource || !fs.existsSync(appexSource)) {
    console.warn("[afterPack] Share extension build skipped or output missing.");
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const pluginsDir = path.join(appPath, "Contents", "PlugIns");

  fs.mkdirSync(pluginsDir, { recursive: true });
  const targetAppex = path.join(pluginsDir, "FreeBuddyShare.appex");
  fs.rmSync(targetAppex, { recursive: true, force: true });
  fs.cpSync(appexSource, targetAppex, { recursive: true });

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

  console.log(`[afterPack] Bundled FreeBuddyShare.appex into ${targetAppex}`);
}


import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShareExtension } from "./build-macos-share-extension.mjs";
import { resolveMacSigningIdentity } from "./resolve-codesign-identity.mjs";
import { writeMacOpenWithService } from "../dist-electron/cli/shellOpen.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function q(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const isDev =
    context.packager.appInfo.productFilename?.toLowerCase().includes("dev") ||
    context.packager.config?.appId?.includes(".dev") ||
    false;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const productName = context.packager.appInfo.productName || "FreeBuddy";
  const bundleId = isDev ? "dev.freebuddy.app.dev" : "dev.freebuddy.app";
  try {
    const servicePath = writeMacOpenWithService(appPath, { bundleId, productName });
    console.log(`[afterPack] Bundled Finder Open with service into ${servicePath}`);
  } catch (err) {
    console.warn("[afterPack] Failed to bundle Finder Open with service:", err);
  }

  const appexSource = buildShareExtension({ silent: false, isDev });
  if (!appexSource || !fs.existsSync(appexSource)) {
    console.warn("[afterPack] Share extension build skipped or output missing.");
    return;
  }

  const pluginsDir = path.join(appPath, "Contents", "PlugIns");

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
  // electron-builder signs Contents/Frameworks and the outer bundle after
  // afterPack but never walks Contents/PlugIns, so the appex must be signed
  // here with the same identity: macOS refuses to load an extension whose
  // team differs from its containing app, and Gatekeeper treats an ad-hoc
  // nested binary inside a signed app as damaged.
  const identity = isDev ? null : resolveMacSigningIdentity();
  const hardenedRuntime = context.packager.config?.mac?.hardenedRuntime !== false;

  if (identity) {
    execSync(
      [
        "codesign --force --sign",
        q(identity),
        `--entitlements ${q(entitlements)}`,
        ...(hardenedRuntime ? ["--options runtime"] : []),
        "--timestamp",
        q(targetAppex)
      ].join(" "),
      { stdio: "inherit" }
    );
    console.log(`[afterPack] Signed FreeBuddyShare.appex with "${identity}"`);
  } else {
    if (!isDev) {
      console.warn(
        "[afterPack] No codesigning identity found; FreeBuddyShare.appex stays ad-hoc signed to match the unsigned app build."
      );
    }
    execSync(`codesign --force --sign - --entitlements ${q(entitlements)} ${q(targetAppex)}`, {
      stdio: "inherit"
    });
  }

  console.log(`[afterPack] Bundled FreeBuddyShare.appex into ${targetAppex}`);
}

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(rootDir, "desktop", "macos", "ShareExtension");
const swiftSource = path.join(srcDir, "ShareViewController.swift");
const infoPlistSource = path.join(srcDir, "Info.plist");
const entitlementsSource = path.join(srcDir, "FreeBuddyShare.entitlements");
const appIconSource = path.join(rootDir, "desktop", "macos", "AppIcon.icns");

const buildDir = path.join(rootDir, ".build", "macos");
const appexDir = path.join(buildDir, "FreeBuddyShare.appex");
const contentsDir = path.join(appexDir, "Contents");
const macosDir = path.join(contentsDir, "MacOS");
const resourcesDir = path.join(contentsDir, "Resources");

export function buildShareExtension(options = {}) {
  const silent = options.silent ?? false;
  const isDev = options.isDev ?? false;
  if (process.platform !== "darwin") {
    if (!silent) console.log("[share-extension] Skipping build on non-macOS platform.");
    return null;
  }

  const targetAppexName = isDev ? "FreeBuddyShareDev.appex" : "FreeBuddyShare.appex";
  const targetAppexDir = path.join(buildDir, targetAppexName);
  const targetContentsDir = path.join(targetAppexDir, "Contents");
  const targetMacosDir = path.join(targetContentsDir, "MacOS");
  const targetResourcesDir = path.join(targetContentsDir, "Resources");

  if (!silent) console.log(`[share-extension] Building ${isDev ? "Dev " : ""}FreeBuddy macOS Share Extension...`);

  fs.rmSync(targetAppexDir, { recursive: true, force: true });
  fs.mkdirSync(targetMacosDir, { recursive: true });
  fs.mkdirSync(targetResourcesDir, { recursive: true });

  const tempArm64 = path.join(buildDir, `FreeBuddyShare_${isDev ? "dev_" : ""}arm64`);
  const tempX86 = path.join(buildDir, `FreeBuddyShare_${isDev ? "dev_" : ""}x86_64`);

  try {
    // 1. Compile arm64
    execSync(
      `swiftc "${swiftSource}" ` +
        `-target arm64-apple-macosx13.0 ` +
        `-framework AppKit -framework Foundation -framework UniformTypeIdentifiers ` +
        `-Xlinker -e -Xlinker _NSExtensionMain ` +
        `-O -o "${tempArm64}"`,
      { stdio: "inherit" }
    );

    // 2. Compile x86_64
    execSync(
      `swiftc "${swiftSource}" ` +
        `-target x86_64-apple-macosx13.0 ` +
        `-framework AppKit -framework Foundation -framework UniformTypeIdentifiers ` +
        `-Xlinker -e -Xlinker _NSExtensionMain ` +
        `-O -o "${tempX86}"`,
      { stdio: "inherit" }
    );

    // 3. Create Universal Binary
    const finalBinary = path.join(targetMacosDir, "FreeBuddyShare");
    execSync(`lipo -create "${tempArm64}" "${tempX86}" -output "${finalBinary}"`, {
      stdio: "inherit"
    });
    fs.unlinkSync(tempArm64);
    fs.unlinkSync(tempX86);

    // 4. Write Info.plist & copy AppIcon.icns
    let plistContent = fs.readFileSync(infoPlistSource, "utf-8");
    if (isDev) {
      plistContent = plistContent
        .replace("<string>dev.freebuddy.app.share</string>", "<string>dev.freebuddy.app.dev.share</string>")
        .replace("<string>发送到 FreeBuddy</string>", "<string>发送到 FreeBuddy Dev</string>");
    }
    fs.writeFileSync(path.join(targetContentsDir, "Info.plist"), plistContent);

    if (fs.existsSync(appIconSource)) {
      fs.copyFileSync(appIconSource, path.join(targetResourcesDir, "AppIcon.icns"));
    }

    // 5. plutil lint Info.plist
    execSync(`plutil -lint "${path.join(targetContentsDir, "Info.plist")}"`, {
      stdio: "ignore"
    });

    // 6. Sign appex bundle ad-hoc
    try {
      execSync(
        `codesign --force --sign - --entitlements "${entitlementsSource}" "${targetAppexDir}"`,
        { stdio: "ignore" }
      );
    } catch {
      // codesign fallback
    }

    if (!silent) console.log(`[share-extension] Successfully built: ${targetAppexDir}`);
    return targetAppexDir;
  } catch (err) {
    console.error("[share-extension] Build failed:", err);
    throw err;
  }
}

// Run directly if invoked from CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildShareExtension();
}

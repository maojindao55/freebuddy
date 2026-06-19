import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const releaseScriptPath = new URL("../scripts/release.sh", import.meta.url);
const releaseScript = fs.existsSync(releaseScriptPath)
  ? fs.readFileSync(releaseScriptPath, "utf8")
  : "";

test("package exposes release script shortcuts", () => {
  assert.equal(packageJson.scripts?.release, "bash scripts/release.sh");
  assert.equal(packageJson.scripts?.["release:patch"], "bash scripts/release.sh patch");
  assert.equal(packageJson.scripts?.["release:minor"], "bash scripts/release.sh minor");
  assert.equal(packageJson.scripts?.["release:major"], "bash scripts/release.sh major");
});

test("release script updates Electron version files", () => {
  assert.ok(releaseScript.includes("package.json"));
  assert.ok(releaseScript.includes("package-lock.json"));
  assert.ok(releaseScript.includes("desktop/macos/Info.plist"));
  assert.match(releaseScript, /CFBundleShortVersionString/);
});

test("release script tags and pushes to trigger the packaging workflow", () => {
  assert.match(releaseScript, /--dry-run/);
  assert.match(releaseScript, /-y\|--yes/);
  assert.match(releaseScript, /patch\|minor\|major/);
  assert.match(releaseScript, /git status --porcelain/);
  assert.match(releaseScript, /git fetch origin --tags --quiet/);
  assert.match(releaseScript, /git tag \\?"\$\{NEW_TAG\}\\?"/);
  assert.match(releaseScript, /git push origin \\?"\$\{NEW_TAG\}\\?"/);
  assert.match(releaseScript, /GitHub Actions/);
});

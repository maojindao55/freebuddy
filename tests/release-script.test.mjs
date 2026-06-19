import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { bumpVersion, validateSemver, parseReleaseArgs } from "../scripts/release-lib.mjs";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const releaseScriptPath = new URL("../scripts/release.mjs", import.meta.url);
const releaseScript = fs.existsSync(releaseScriptPath)
  ? fs.readFileSync(releaseScriptPath, "utf8")
  : "";

test("package exposes node-based release script shortcuts", () => {
  assert.equal(packageJson.scripts?.release, "node scripts/release.mjs");
  assert.equal(packageJson.scripts?.["release:patch"], "node scripts/release.mjs patch");
  assert.equal(packageJson.scripts?.["release:minor"], "node scripts/release.mjs minor");
  assert.equal(packageJson.scripts?.["release:major"], "node scripts/release.mjs major");
});

test("bumpVersion increments the requested part and zeros the rest", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("0.0.0", "patch"), "0.0.1");
});

test("bumpVersion throws on an invalid part", () => {
  assert.throws(() => bumpVersion("1.2.3", "bogus"), /无效的 bump 类型/);
});

test("validateSemver accepts valid and rejects invalid versions", () => {
  validateSemver("1.2.3");
  assert.throws(() => validateSemver("1.2"), /版本号格式无效/);
  assert.throws(() => validateSemver("1.2.3.4"), /版本号格式无效/);
});

test("parseReleaseArgs parses bump, explicit version, dry-run, yes, help", () => {
  assert.deepEqual(parseReleaseArgs(["minor"]), {
    help: false, bumpType: "minor", explicitVersion: "", dryRun: false, skipConfirm: false
  });
  assert.deepEqual(parseReleaseArgs(["1.2.3"]), {
    help: false, bumpType: "patch", explicitVersion: "1.2.3", dryRun: false, skipConfirm: false
  });
  assert.deepEqual(parseReleaseArgs(["v2.0.0", "--dry-run", "-y"]), {
    help: false, bumpType: "patch", explicitVersion: "2.0.0", dryRun: true, skipConfirm: true
  });
  assert.equal(parseReleaseArgs(["--help"]).help, true);
  assert.throws(() => parseReleaseArgs(["--nope"]), /未知参数/);
});

test("release runner updates Electron version files and performs git ops", () => {
  assert.ok(releaseScript.includes("package.json"));
  assert.ok(releaseScript.includes("package-lock.json"));
  assert.ok(releaseScript.includes("desktop/macos/Info.plist"));
  assert.match(releaseScript, /CFBundleShortVersionString/);
  assert.match(releaseScript, /--dry-run/);
  assert.match(releaseScript, /git/);
  assert.match(releaseScript, /tag/);
  assert.match(releaseScript, /push/);
  assert.match(releaseScript, /GitHub Actions/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const builderConfig = fs.existsSync(new URL("../electron-builder.yml", import.meta.url))
  ? fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8")
  : "";
const workflow = fs.existsSync(new URL("../.github/workflows/release.yml", import.meta.url))
  ? fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  : "";

test("package exposes electron-builder release scripts", () => {
  assert.equal(packageJson.devDependencies?.["electron-builder"], "^26.15.3");
  assert.equal(packageJson.scripts?.dist, "npm run build && electron-builder");
  assert.equal(packageJson.scripts?.["dist:mac"], "npm run build && electron-builder --mac --x64 --arm64");
  assert.equal(packageJson.scripts?.["dist:linux"], "npm run build && electron-builder --linux");
  assert.equal(packageJson.scripts?.["dist:win"], "npm run build && electron-builder --win --x64");
});

test("electron-builder config packages FreeBuddy for desktop platforms", () => {
  assert.match(builderConfig, /^appId:\s+dev\.freebuddy\.app/m);
  assert.match(builderConfig, /^productName:\s+FreeBuddy/m);
  assert.match(builderConfig, /mac:[\s\S]*target:[\s\S]*- target:\s+dmg[\s\S]*- target:\s+zip/m);
  assert.match(builderConfig, /win:[\s\S]*target:[\s\S]*- target:\s+nsis/m);
  assert.match(builderConfig, /linux:[\s\S]*target:[\s\S]*- target:\s+AppImage[\s\S]*- target:\s+deb/m);
  assert.match(builderConfig, /linux:[\s\S]*maintainer:\s+FreeBuddy <noreply@freebuddy\.dev>/m);
  assert.match(builderConfig, /extraResources:[\s\S]*from:\s+assets\/app-icon\.png[\s\S]*to:\s+app-icon\.png/m);
});

test("release workflow uploads version-suffixed assets and Windows update metadata", () => {
  assert.match(workflow, /name:\s+Release/);
  assert.match(workflow, /tags:\s+\['v\*'\]/);
  assert.match(workflow, /FreeBuddy_macOS-Apple-Silicon-__VERSION__\.dmg/);
  assert.match(workflow, /FreeBuddy_macOS-Apple-Silicon-__VERSION__\.zip/);
  assert.match(workflow, /FreeBuddy_macOS-Intel-__VERSION__\.dmg/);
  assert.match(workflow, /FreeBuddy_macOS-Intel-__VERSION__\.zip/);
  assert.match(workflow, /FreeBuddy_Windows_x64-__VERSION__\.exe/);
  assert.match(workflow, /asset_name="\$\{asset_name\/\/__VERSION__\/\$version_suffix\}"/);
  assert.match(workflow, /\$assetName = \$assetName\.Replace\("__VERSION__", "v\$appVersion"\)/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  // Build only; assets are renamed and uploaded manually to keep friendly names.
  assert.match(workflow, /npx electron-builder \$\{\{ matrix\.builder_args \}\} --publish never/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /Upload macOS update metadata/);
  assert.match(workflow, /FreeBuddy_macOS-Apple-Silicon-\$\{version_suffix\}\.zip/);
  assert.match(workflow, /FreeBuddy_macOS-Intel-\$\{version_suffix\}\.zip/);
  // Auto-update metadata: latest.yml rewritten to the version-suffixed Windows name.
  assert.match(workflow, /Upload Windows update metadata/);
  assert.match(workflow, /FreeBuddy_Windows_x64-v\$appVersion\.exe/);
  assert.match(workflow, /\$windowsAssetName\.blockmap/);
});

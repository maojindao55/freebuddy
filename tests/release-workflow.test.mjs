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
  assert.match(builderConfig, /mac:[\s\S]*target:[\s\S]*- target:\s+dmg/m);
  assert.match(builderConfig, /win:[\s\S]*target:[\s\S]*- target:\s+nsis/m);
  assert.match(builderConfig, /linux:[\s\S]*target:[\s\S]*- target:\s+AppImage[\s\S]*- target:\s+deb/m);
  assert.match(builderConfig, /linux:[\s\S]*maintainer:\s+FreeBuddy <noreply@freebuddy\.dev>/m);
  assert.match(builderConfig, /extraResources:[\s\S]*from:\s+assets\/app-icon\.png[\s\S]*to:\s+app-icon\.png/m);
});

test("release workflow publishes electron-builder assets with update metadata", () => {
  assert.match(workflow, /name:\s+Release/);
  assert.match(workflow, /tags:\s+\['v\*'\]/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  // Native publish so latest.yml / latest-mac.yml are uploaded for auto-update.
  assert.match(workflow, /npx electron-builder \$\{\{ matrix\.builder_args \}\} --publish always/);
  assert.match(workflow, /GH_TOKEN:\s+\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  // macOS builds both arches in one job so latest-mac.yml lists them together.
  assert.match(workflow, /builder_args:\s+--mac --arm64 --x64/);
  assert.match(workflow, /builder_args:\s+--win --x64/);
  assert.match(workflow, /--draft=false/);
  assert.match(workflow, /--latest/);
});

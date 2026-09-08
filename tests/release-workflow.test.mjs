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
  assert.match(packageJson.scripts?.["dist:mac"], /ensure-tokscale-platform\.mjs[\s\S]*--arch arm64[\s\S]*--arch x64[\s\S]*electron-builder --mac --x64 --arm64/);
  assert.match(packageJson.scripts?.["dist:linux"], /ensure-tokscale-platform\.mjs[\s\S]*--platform linux --arch x64[\s\S]*electron-builder --linux/);
  assert.match(packageJson.scripts?.["dist:win"], /ensure-tokscale-platform\.mjs[\s\S]*--platform win32 --arch x64[\s\S]*electron-builder --win --x64/);
});

test("electron-builder config packages FreeBuddy for desktop platforms", () => {
  assert.match(builderConfig, /^appId:\s+dev\.freebuddy\.app/m);
  assert.match(builderConfig, /^productName:\s+FreeBuddy/m);
  assert.match(builderConfig, /mac:[\s\S]*target:[\s\S]*- target:\s+dmg[\s\S]*- target:\s+zip/m);
  assert.match(builderConfig, /win:[\s\S]*target:[\s\S]*- target:\s+nsis/m);
  assert.match(builderConfig, /linux:[\s\S]*target:[\s\S]*- target:\s+AppImage[\s\S]*- target:\s+deb/m);
  assert.match(builderConfig, /linux:[\s\S]*category:\s+Development/m);
  assert.match(builderConfig, /linux:[\s\S]*maintainer:\s+FreeBuddy <noreply@freebuddy\.dev>/m);
  assert.match(builderConfig, /toolsets:[\s\S]*appimage:\s+"1\.0\.3"/m);
  assert.match(builderConfig, /extraResources:[\s\S]*from:\s+assets\/app-icon\.png[\s\S]*to:\s+app-icon\.png/m);
  assert.match(builderConfig, /beforePack:\s+scripts\/prepare-tokscale-for-pack\.mjs/);
  assert.match(builderConfig, /extraResources:[\s\S]*from:\s+\.build\/tokscale[\s\S]*to:\s+tokscale/m);
  assert.match(
    builderConfig,
    /extraResources:[\s\S]*from:\s+third_party\/deepseek-harness\/overlays[\s\S]*to:\s+dsh-harness-overlays/m
  );
});

test("release workflow uploads version-suffixed assets and update metadata for every platform", () => {
  assert.match(workflow, /name:\s+Release/);
  assert.match(workflow, /tags:\s+\['v\*'\]/);
  assert.match(workflow, /workflow_dispatch:[\s\S]*inputs:[\s\S]*tag:[\s\S]*required:\s+true/);
  assert.match(workflow, /RELEASE_TAG:\s+\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(workflow, /ref:\s+\$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(workflow, /Create release notes/);
  assert.match(workflow, /node scripts\/release-notes\.mjs --version "\$\{\{ env\.RELEASE_TAG \}\}"/);
  assert.match(workflow, /--notes-file \.release-notes\.md/);
  assert.match(workflow, /FreeBuddy_macOS-Apple-Silicon-__VERSION__\.dmg/);
  assert.match(workflow, /FreeBuddy_macOS-Apple-Silicon-__VERSION__\.zip/);
  assert.match(workflow, /FreeBuddy_macOS-Intel-__VERSION__\.dmg/);
  assert.match(workflow, /FreeBuddy_macOS-Intel-__VERSION__\.zip/);
  assert.match(workflow, /FreeBuddy_Windows_x64-__VERSION__\.exe/);
  assert.match(workflow, /platform:\s+ubuntu-latest[\s\S]*builder_args:\s+--linux --x64/m);
  assert.match(workflow, /FreeBuddy_Ubuntu_x64-__VERSION__\.deb/);
  assert.match(workflow, /FreeBuddy_Linux_x64-__VERSION__\.AppImage/);
  assert.match(workflow, /asset_name="\$\{asset_name\/\/__VERSION__\/\$version_suffix\}"/);
  assert.match(workflow, /\$assetName = \$assetName\.Replace\("__VERSION__", "v\$appVersion"\)/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /Import macOS signing certificate/);
  assert.match(workflow, /scripts\/import-macos-csc-cert\.sh/);
  assert.match(workflow, /Checkout signing helper/);
  assert.match(workflow, /path:\s+\.ci-helpers/);
  assert.match(workflow, /ensure-tokscale-platform\.mjs --platform \$\{\{ matrix\.tokscale_platform \}\} --arch \$\{\{ matrix\.tokscale_arch \}\}/);
  // Build only; assets are renamed and uploaded manually to keep friendly names.
  assert.match(workflow, /npx electron-builder \$\{\{ matrix\.builder_args \}\} --publish never/);
  const buildStep = workflow.split("- name: Build Electron app")[1]?.split("- name:")[0] ?? "";
  assert.match(buildStep, /CSC_IDENTITY_AUTO_DISCOVERY/);
  assert.doesNotMatch(
    buildStep,
    /CSC_LINK:/,
    "electron-builder must not receive CSC_LINK; it would rebuild a temp keychain and fail on macOS 26.6"
  );
  assert.doesNotMatch(buildStep, /CSC_KEY_PASSWORD:/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /Upload macOS update metadata/);
  assert.match(workflow, /FreeBuddy_macOS-Apple-Silicon-\$\{version_suffix\}\.zip/);
  assert.match(workflow, /FreeBuddy_macOS-Intel-\$\{version_suffix\}\.zip/);
  // Auto-update metadata: latest.yml rewritten to the version-suffixed Windows name.
  assert.match(workflow, /Upload Windows update metadata/);
  assert.match(workflow, /FreeBuddy_Windows_x64-v\$appVersion\.exe/);
  assert.match(workflow, /\$windowsAssetName\.blockmap/);
  // AppImage and .deb both auto-update through latest-linux.yml; rewrite both
  // friendly asset names so Ubuntu .deb installs do not 404.
  assert.match(workflow, /Upload Linux update metadata/);
  assert.match(workflow, /find release -name latest-linux\.yml/);
  assert.match(workflow, /FreeBuddy_Linux_x64-\$\{version_suffix\}\.AppImage/);
  assert.match(workflow, /FreeBuddy_Ubuntu_x64-\$\{version_suffix\}\.deb/);
  assert.match(
    workflow,
    /FreeBuddy-\[0-9\]\+\\.\[0-9\]\+\\.\[0-9\]\+-linux-\(amd64\|x64\|x86_64\)\\.deb/
  );
});

test("macOS cert import uses the keychain password for set-key-partition-list", () => {
  const script = fs.readFileSync(
    new URL("../scripts/import-macos-csc-cert.sh", import.meta.url),
    "utf8"
  );
  assert.match(script, /security create-keychain -p "\$\{keychain_password\}"/);
  assert.match(
    script,
    /security set-key-partition-list[\s\S]*?-k "\$\{keychain_password\}"/
  );
  assert.match(script, /-P "\$\{CSC_KEY_PASSWORD:-\}"/);
});

test("macOS cert import is a no-op off Darwin", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "bash",
    [new URL("../scripts/import-macos-csc-cert.sh", import.meta.url).pathname],
    { encoding: "utf8", env: { ...process.env, CSC_LINK: "dGVzdA==" } }
  );
  if (process.platform === "darwin") {
    assert.ok(true);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skipping macOS certificate import/);
});

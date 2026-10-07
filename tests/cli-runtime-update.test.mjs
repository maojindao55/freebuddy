import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRuntimeUpdate, versionFromProbe, upgradeVerificationError, runtimeVersionBelow } from "../dist-electron/shared/cliRuntimeUpdate.js";
import { readRuntimePackage, getRuntimePackagePolicy } from "../dist-electron/cli/runtimePackages.js";

test("optional probes retain Antigravity versions and reject help banners", () => {
  assert.equal(versionFromProbe("agy-acp 0.3.6", true), "0.3.6");
  assert.equal(versionFromProbe("Usage: agy-acp [options]", true), undefined);
  assert.equal(runtimeVersionBelow("0.3.6", getRuntimePackagePolicy("agy-acp").minimumVersion), true);
  assert.equal(runtimeVersionBelow("0.3.8", "0.3.8"), false);
});

test("updates are cached for one day, but a manual check refreshes immediately", async () => {
  let queries = 0;
  const fetch = async () => { queries++; return "0.3.9"; };
  const now = Date.parse("2026-10-06T12:00:00Z");
  const snapshot = { version: "0.3.6", latestVersion: "0.3.8", updateStatus: "available", lastUpdateCheckAt: new Date(now - 1000).toISOString() };
  assert.equal((await checkRuntimeUpdate(snapshot, fetch, { now })).latestVersion, "0.3.8");
  assert.equal(queries, 0);
  assert.equal((await checkRuntimeUpdate(snapshot, fetch, { now, force: true })).latestVersion, "0.3.9");
  assert.equal(queries, 1);
  await checkRuntimeUpdate(snapshot, fetch, { now: now + 24 * 60 * 60 * 1000 });
  assert.equal(queries, 2);
});

test("a changed local version recalculates cached update availability", async () => {
  const state = await checkRuntimeUpdate({ version: "0.3.8", latestVersion: "0.3.8", updateStatus: "available", lastUpdateCheckAt: new Date().toISOString() }, async () => { throw new Error("must use cache"); });
  assert.equal(state.updateStatus, "current");
});

test("registry failure preserves known versions and does not invent latest status", async () => {
  const state = await checkRuntimeUpdate({ version: "0.3.6", latestVersion: "0.3.8" }, async () => { throw new Error("offline"); });
  assert.equal(state.version, "0.3.6");
  assert.equal(state.latestVersion, "0.3.8");
  assert.equal(state.updateStatus, "error");
  assert.equal(state.lastUpdateError, "offline");
});

test("successful installation cannot verify an old version, an unknown version, or another path", () => {
  const plan = { command: "", targetVersion: "0.3.8", expectedBinaryPath: "C:\\npm\\agy-acp.cmd" };
  const actual = { installed: true, path: plan.expectedBinaryPath, version: "0.3.6" };
  assert.equal(upgradeVerificationError(actual, plan, "win32"), "runtime_target_not_active");
  assert.equal(upgradeVerificationError({ ...actual, version: undefined }, plan, "win32"), "runtime_version_unknown");
  assert.equal(upgradeVerificationError({ ...actual, path: "D:\\npm\\agy-acp.cmd", version: "0.3.8" }, plan, "win32"), "runtime_path_changed");
  assert.equal(upgradeVerificationError({ ...actual, path: "c:/NPM/agy-acp.cmd", version: "0.3.8" }, plan, "win32"), undefined);
  assert.equal(upgradeVerificationError({ ...actual, installed: false }, plan, "win32"), "runtime_not_installed");
});

test("official installer validation rejects downgrades even without a latest-version API", () => {
  const plan = { command: "", previousVersion: "1.2.0" };
  assert.equal(upgradeVerificationError({ installed: true, version: "1.1.0" }, plan, "darwin"), "runtime_version_regressed");
  assert.equal(upgradeVerificationError({ installed: true, version: "1.2.0" }, plan, "darwin"), undefined);
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-runtime-package-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("global npm identity follows executable symlinks to the selected prefix", { skip: process.platform === "win32" }, t => {
  const prefix = fixture(t);
  const directory = path.join(prefix, "lib/node_modules/agy-acp-bridge");
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "agy-acp-bridge", version: "0.3.6" }));
  fs.writeFileSync(path.join(directory, "index.js"), "");
  const binary = path.join(prefix, "bin/agy-acp");
  fs.symlinkSync(path.join(directory, "index.js"), binary);
  assert.deepEqual(readRuntimePackage(binary, "agy-acp-bridge"), { prefix, directory, version: "0.3.6" });
  assert.equal(readRuntimePackage(binary, "unrelated-package"), undefined);
});

test("Windows npm shims must refer to the matching package", t => {
  const prefix = fixture(t);
  const directory = path.join(prefix, "node_modules/agy-acp-bridge");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "agy-acp-bridge", version: "0.3.8" }));
  const binary = path.join(prefix, "agy-acp.cmd");
  fs.writeFileSync(binary, '@"node" "%dp0%\\node_modules\\agy-acp-bridge\\dist\\index.js" %*');
  assert.deepEqual(readRuntimePackage(binary, "agy-acp-bridge"), { prefix, directory, version: "0.3.8" });
  fs.writeFileSync(binary, '@"other-agent.exe" %*');
  assert.equal(readRuntimePackage(binary, "agy-acp-bridge"), undefined);
});

test("project dependencies provide versions but are never treated as global upgrade targets", t => {
  const root = fixture(t);
  const directory = path.join(root, "node_modules/agy-acp-bridge");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "agy-acp-bridge", version: "0.3.8" }));
  const binary = path.join(directory, "index.js");
  fs.writeFileSync(binary, "");
  assert.equal(readRuntimePackage(binary, "agy-acp-bridge").prefix, undefined);
});

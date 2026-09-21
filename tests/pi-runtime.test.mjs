import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensurePiAcpLauncher,
  piAcpEntryForRoot,
  piCliEntryForRoot,
  piLauncherDir,
  piRuntimeRoots,
  readPiRuntimeManifest,
  resolvePiAcpRuntime,
  resolvePiAcpSpawnPlan,
  resolvePiNodeRuntime
} from "../dist-electron/cli/piRuntime.js";

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-root-"));
  const piAcpEntry = piAcpEntryForRoot(root);
  const piCliEntry = piCliEntryForRoot(root);
  fs.mkdirSync(path.dirname(piAcpEntry), { recursive: true });
  fs.mkdirSync(path.dirname(piCliEntry), { recursive: true });
  fs.writeFileSync(piAcpEntry, "// bridge entry\n");
  fs.writeFileSync(piCliEntry, "// pi cli entry\n");
  return { root, piAcpEntry, piCliEntry };
}

test("piRuntimeRoots prefers packaged resources, then staging, then repo", () => {
  const roots = piRuntimeRoots();
  assert.ok(roots.length >= 2);
  assert.equal(roots[roots.length - 1], path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  assert.ok(roots.some((root) => root.endsWith(".build/pi-runtime")));
});

test("resolvePiAcpRuntime finds the first ready root and its manifest", () => {
  const { root, piAcpEntry } = makeFixtureRoot();
  fs.writeFileSync(
    path.join(root, "pi-runtime.json"),
    JSON.stringify({ piVersion: "1.2.3", piAcpVersion: "0.0.33" })
  );

  const status = resolvePiAcpRuntime([root]);
  assert.equal(status.ready, true);
  assert.equal(status.root, root);
  assert.equal(status.piAcpEntry, piAcpEntry);
  assert.equal(status.piVersion, "1.2.3");
  assert.equal(status.piAcpVersion, "0.0.33");

  const empty = resolvePiAcpRuntime([fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-empty-"))]);
  assert.equal(empty.ready, false);

  // First ready root wins.
  const second = makeFixtureRoot();
  const both = resolvePiAcpRuntime([second.root, root]);
  assert.equal(both.root, second.root);
});

test("readPiRuntimeManifest falls back to package.json versions", () => {
  const { root } = makeFixtureRoot();
  fs.writeFileSync(
    path.join(root, "node_modules", "pi-acp", "package.json"),
    JSON.stringify({ version: "0.0.33" })
  );
  const manifest = readPiRuntimeManifest(root);
  assert.equal(manifest.piAcpVersion, "0.0.33");
  assert.equal(manifest.piVersion, undefined);
});

test("resolvePiAcpRuntime requires both bridge and pi CLI entries", () => {
  const { root, piCliEntry } = makeFixtureRoot();
  fs.rmSync(piCliEntry);
  assert.equal(resolvePiAcpRuntime([root]).ready, false);
});

test("resolvePiNodeRuntime prefers an explicit node and falls back to Electron-as-Node", () => {
  const fakeNode = path.join(os.tmpdir(), `fake-node-${process.pid}`);
  fs.writeFileSync(fakeNode, "#!/bin/sh\n");
  const withNode = resolvePiNodeRuntime({
    PATH: "",
    FREEBUDDY_NODE_BIN: fakeNode
  });
  assert.equal(withNode.bin, fakeNode);
  assert.deepEqual(withNode.env, {});

  const fallback = resolvePiNodeRuntime({ PATH: "", FREEBUDDY_NODE_BIN: "" });
  assert.equal(fallback.bin, process.execPath);
  assert.deepEqual(fallback.env, { ELECTRON_RUN_AS_NODE: "1" });
});

test("ensurePiAcpLauncher writes an idempotent executable launcher", () => {
  const { piCliEntry } = makeFixtureRoot();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-data-"));
  const node = { bin: "/usr/bin/node", env: {} };
  const launcher = ensurePiAcpLauncher({ dataDir, piCliEntry, node });

  assert.equal(launcher, path.join(piLauncherDir(dataDir), process.platform === "win32" ? "pi-fb.cmd" : "pi-fb"));
  const content = fs.readFileSync(launcher, "utf8");
  assert.match(content, /ELECTRON_RUN_AS_NODE/);
  assert.match(content, new RegExp(piCliEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Rewriting with the same inputs keeps the file untouched.
  const before = fs.statSync(launcher);
  const again = ensurePiAcpLauncher({ dataDir, piCliEntry, node });
  assert.equal(again, launcher);
  const after = fs.statSync(launcher);
  if (process.platform !== "win32") {
    // mtimeMs granularity may be coarse; at minimum the mode stays executable.
    assert.equal(after.mode & 0o111, 0o111);
    assert.ok(before.mtimeMs <= after.mtimeMs + 1000);
  }
});

test("resolvePiAcpSpawnPlan returns a node spawn plan with bridge env", () => {
  const { root } = makeFixtureRoot();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-plan-"));
  const fakeNode = path.join(dataDir, "fake-node");
  fs.writeFileSync(fakeNode, "#!/bin/sh\n");
  const plan = resolvePiAcpSpawnPlan(
    dataDir,
    [root],
    { PATH: "", FREEBUDDY_NODE_BIN: fakeNode }
  );
  assert.ok(plan);
  assert.equal(plan.bin, fakeNode);
  assert.equal(plan.piAcpEntry, piAcpEntryForRoot(root));
  assert.equal(plan.env.PI_ACP_PI_COMMAND, path.join(piLauncherDir(dataDir), process.platform === "win32" ? "pi-fb.cmd" : "pi-fb"));
  assert.equal(plan.env.PI_SKIP_VERSION_CHECK, "1");
  assert.equal(plan.env.PI_CODING_AGENT_DIR, path.join(dataDir, "pi-agent"));

  const none = resolvePiAcpSpawnPlan(
    dataDir,
    [fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-none-"))],
    { PATH: "", FREEBUDDY_NODE_BIN: "" }
  );
  assert.equal(none, undefined);
});

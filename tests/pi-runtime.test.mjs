import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
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
import {
  ensurePackagedPiRuntime,
  piRuntimeCacheRoot
} from "../dist-electron/cli/piRuntimePackage.js";
import {
  PI_ACP_ENTRY_REL,
  PI_CLI_ENTRY_REL,
  PI_RUNTIME_ARCHIVE_FILE,
  PI_RUNTIME_PACKAGE_MANIFEST_FILE,
  PI_RUNTIME_ROOT_DIR,
  PI_RUNTIME_STAGING_SUBDIR,
  piRuntimeStagingDir
} from "../scripts/pi-runtime-layout.mjs";

const require = createRequire(import.meta.url);

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

test("piRuntimeRoots includes local staging and repo fallback", () => {
  const roots = piRuntimeRoots();
  assert.ok(roots.length >= 2);
  assert.equal(roots[roots.length - 1], path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  assert.ok(
    roots.some((root) => root.endsWith(path.join(".build", "pi-runtime", PI_RUNTIME_STAGING_SUBDIR)))
  );
  // Packaged runtime is added after the archive is extracted. The source
  // resource directory itself must never be treated as a ready runtime.
  assert.ok(
    roots.every((root) => !root.endsWith(path.join("pi-runtime"))),
    `packaged root must include the ${PI_RUNTIME_STAGING_SUBDIR} subdir: ${roots.join(", ")}`
  );
});

test("piRuntimeRoots staging root matches the staging script layout", () => {
  // Guards against the layout drifting between scripts/pi-runtime-layout.mjs
  // and electron/cli/piRuntime.ts — the drift that shipped v0.10.5 without pi.
  const roots = piRuntimeRoots();
  assert.ok(roots.includes(piRuntimeStagingDir(PI_RUNTIME_ROOT_DIR)));
  assert.ok(PI_RUNTIME_STAGING_SUBDIR !== "node_modules");
});

test("ensurePackagedPiRuntime is a no-op without a packaged resource", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-no-package-"));
  assert.equal(await ensurePackagedPiRuntime(dataDir, path.join(dataDir, "missing")), undefined);
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

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-no-node-"));
  const fallback = resolvePiNodeRuntime({
    PATH: "",
    FREEBUDDY_NODE_BIN: "",
    ProgramFiles: emptyRoot,
    "ProgramFiles(x86)": emptyRoot
  });
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

test("packaged Pi archive copies, extracts once, and is reused by version", async () => {
  const { FileMatcher, copyFiles } = require("app-builder-lib/out/fileMatcher.js");
  const AdmZip = require("adm-zip");
  const builderConfig = fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(builderConfig, /from: \.build\/pi-runtime-package\s+to: pi-runtime/);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-pack-"));
  const from = path.join(workDir, path.basename(PI_RUNTIME_ROOT_DIR)); // .build/pi-runtime
  const stagingDir = path.join(workDir, "staged-runtime");
  const to = path.join(workDir, "resources", path.basename(PI_RUNTIME_ROOT_DIR));

  // Reproduce the layout scripts/ensure-pi-runtime.mjs produces.
  fs.mkdirSync(path.dirname(path.join(stagingDir, PI_ACP_ENTRY_REL)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(stagingDir, PI_CLI_ENTRY_REL)), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, PI_ACP_ENTRY_REL), "// bridge entry\n");
  fs.writeFileSync(path.join(stagingDir, PI_CLI_ENTRY_REL), "// pi cli entry\n");
  fs.writeFileSync(path.join(stagingDir, "package.json"), "{}\n");
  fs.writeFileSync(
    path.join(stagingDir, "pi-runtime.json"),
    JSON.stringify({ schemaVersion: 1, piVersion: "0.85.1", piAcpVersion: "0.0.33" })
  );

  fs.mkdirSync(from, { recursive: true });
  const archivePath = path.join(from, PI_RUNTIME_ARCHIVE_FILE);
  const zip = new AdmZip();
  zip.addLocalFolder(stagingDir);
  zip.writeZip(archivePath);
  const manifest = {
    schemaVersion: 1,
    piVersion: "0.85.1",
    piAcpVersion: "0.0.33",
    sha256: createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex")
  };
  fs.writeFileSync(path.join(from, PI_RUNTIME_PACKAGE_MANIFEST_FILE), JSON.stringify(manifest));

  // Exercise electron-builder's real extraResources copy path.
  const matcher = new FileMatcher(from, to, (it) => it, []);
  await copyFiles([matcher], null, false);

  assert.ok(fs.existsSync(path.join(to, PI_RUNTIME_ARCHIVE_FILE)));
  assert.equal(fs.existsSync(path.join(to, PI_RUNTIME_STAGING_SUBDIR)), false);
  const { verifyPackagedPiRuntime } = await import("../scripts/pi-runtime-pack-guard.mjs");
  assert.equal(verifyPackagedPiRuntime(path.join(workDir, "resources")), 1);

  const dataDir = path.join(workDir, "user-data");
  const packagedRoot = await ensurePackagedPiRuntime(dataDir, to);
  assert.equal(packagedRoot, piRuntimeCacheRoot(dataDir, manifest));
  const status = resolvePiAcpRuntime([packagedRoot]);
  assert.equal(status.ready, true);
  assert.equal(status.root, packagedRoot);
  assert.equal(status.piAcpVersion, "0.0.33");
  assert.equal(resolvePiAcpRuntime().root, packagedRoot);
  assert.equal(resolvePiAcpSpawnPlan(dataDir)?.piAcpEntry, path.join(packagedRoot, PI_ACP_ENTRY_REL));
  const marker = path.join(packagedRoot, "cache-ready.json");
  const before = fs.statSync(marker).mtimeMs;
  const nextAppResources = path.join(workDir, "next-app", "pi-runtime");
  fs.cpSync(to, nextAppResources, { recursive: true });
  assert.equal(await ensurePackagedPiRuntime(dataDir, nextAppResources), packagedRoot);
  assert.equal(fs.statSync(marker).mtimeMs, before);

  fs.rmSync(path.join(packagedRoot, PI_CLI_ENTRY_REL));
  assert.equal(await ensurePackagedPiRuntime(dataDir, to), packagedRoot);
  assert.ok(fs.existsSync(path.join(packagedRoot, PI_CLI_ENTRY_REL)));

  fs.writeFileSync(path.join(to, PI_RUNTIME_ARCHIVE_FILE), "corrupt");
  fs.rmSync(packagedRoot, { recursive: true });
  await assert.rejects(() => ensurePackagedPiRuntime(dataDir, to), /checksum mismatch/);
  assert.throws(
    () => verifyPackagedPiRuntime(path.join(workDir, "resources")),
    /missing the bundled pi runtime/
  );
});

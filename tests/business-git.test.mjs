import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const mod = await import("../dist-electron/cli/businessGit.js");

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bizgit-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  return dir;
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commitAll(dir, msg) {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", msg]);
}

test("ensureCleanRepo: clean repo is ok, dirty repo is not", async () => {
  const dir = makeRepo();
  write(dir, "a.txt", "1");
  commitAll(dir, "init");

  const clean = await mod.ensureCleanRepo(dir);
  assert.equal(clean.ok, true);

  write(dir, "a.txt", "2");
  const dirty = await mod.ensureCleanRepo(dir);
  assert.equal(dirty.ok, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("listChangedFiles includes both modified and untracked files", async () => {
  const dir = makeRepo();
  write(dir, "tracked.txt", "1");
  commitAll(dir, "init");

  write(dir, "tracked.txt", "2");
  write(dir, "new.txt", "3");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  write(dir, "src/deep.js", "x");

  const changed = await mod.listChangedFiles(dir);
  const paths = changed.map((c) => c.path).sort();
  assert.deepEqual(paths, ["new.txt", "src/deep.js", "tracked.txt"].sort());
  assert.ok(changed.find((c) => c.path === "new.txt" && c.untracked));
  assert.ok(changed.find((c) => c.path === "tracked.txt" && !c.untracked));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("createBranch + stageFiles + commitFiles produce a real commit sha", async () => {
  const dir = makeRepo();
  write(dir, "a.txt", "1");
  commitAll(dir, "init");

  write(dir, "a.txt", "2");
  write(dir, "b.txt", "3");

  const branchOk = await mod.createBranch(dir, "feat/x");
  assert.equal(branchOk, true);

  const stageOk = await mod.stageFiles(dir, ["a.txt", "b.txt"]);
  assert.equal(stageOk, true);

  const commitOk = await mod.commitFiles(dir, "change a and add b");
  assert.equal(commitOk, true);

  const sha = await mod.headSha(dir);
  assert.ok(sha && /^[0-9a-f]{7,}$/.test(sha));

  const branch = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8"
  }).trim();
  assert.equal(branch, "feat/x");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("filterFilesByAllowedPaths only keeps files inside allowed paths", () => {
  const files = ["src/a.ts", "src/nested/b.ts", "README.md", "other/c.ts"];
  const filtered = mod.filterFilesByAllowedPaths(files, ["src", "README.md"]);
  assert.deepEqual(filtered.sort(), ["README.md", "src/a.ts", "src/nested/b.ts"].sort());

  const none = mod.filterFilesByAllowedPaths(files, []);
  assert.deepEqual(none, []);

  const exact = mod.filterFilesByAllowedPaths(files, ["other/c.ts"]);
  assert.deepEqual(exact, ["other/c.ts"]);
});

test("filterFilesByAllowedPaths does not match sibling prefixes", () => {
  const files = ["src-foo/x.ts", "src/x.ts"];
  const filtered = mod.filterFilesByAllowedPaths(files, ["src"]);
  assert.deepEqual(filtered, ["src/x.ts"]);
});

test("orderSurfacesByDependency puts providers before consumers", () => {
  const ordered = mod.orderSurfacesByDependency([
    { surfaceId: "client", dependsOnSurfaceIds: ["server"] },
    { surfaceId: "server", dependsOnSurfaceIds: [] }
  ]);
  assert.deepEqual(ordered.map((s) => s.surfaceId), ["server", "client"]);
});

test("orderSurfacesByDependency handles independent surfaces in input order", () => {
  const ordered = mod.orderSurfacesByDependency([
    { surfaceId: "a", dependsOnSurfaceIds: [] },
    { surfaceId: "b", dependsOnSurfaceIds: [] }
  ]);
  assert.deepEqual(ordered.map((s) => s.surfaceId), ["a", "b"]);
});

test("renderBranchName substitutes runSlug and surfaceKey", () => {
  assert.equal(
    mod.renderBranchName("fb/{{runSlug}}/{{surfaceKey}}", "add-discount", "server"),
    "fb/add-discount/server"
  );
});

test("runVerifyCommand captures exit code and status", async () => {
  const dir = makeRepo();
  const passed = await mod.runVerifyCommand(dir, "true");
  assert.equal(passed.status, "passed");
  assert.equal(passed.exitCode, 0);

  const failed = await mod.runVerifyCommand(dir, "false");
  assert.equal(failed.status, "failed");
  assert.notEqual(failed.exitCode, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Isolate git from user/system config (e.g. core.autocrlf=true on Windows
// would check clones out with CRLF and break byte-exact assertions). The
// product code spawns git with inherited env, so this covers it too.
const gitConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-gitcfg-"));
process.env.GIT_CONFIG_GLOBAL = path.join(gitConfigDir, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function insertUser(db, id, username) {
  db.prepare(
    `INSERT INTO remote_users
       (id, username, password_hash, is_owner, created_at, disabled)
     VALUES (?, ?, 'test-only', 0, ?, 0)`
  ).run(id, username, Date.now());
}

function mkdtemp(prefix) {
  // GitHub Actions Windows runners expose TEMP as an 8.3 short name
  // (C:\Users\RUNNER~1\...). fs.mkdtempSync keeps that short parent, but the
  // product code canonicalizes via fs.realpathSync.native (long form), so raw
  // tmpdir paths never equal their real form. Resolve once at creation.
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  );
}

test("remote workspaces create and reuse an independent clone per user", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const {
    ensureRemoteWorkspace,
    listRemoteWorkspaces,
    removeRemoteWorkspacesForUser,
    sourcePathForManagedWorkspace
  } =
    await import("../dist-electron/cli/remoteWorkspaces.js");

  const source = mkdtemp("freebuddy-source-");
  const userId = `workspace-test-${process.pid}`;
  insertUser(db, userId, "git-alice");
  git(["init"], source);
  fs.writeFileSync(path.join(source, "README.md"), "source\n");
  git(["add", "README.md"], source);
  git(
    [
      "-c",
      "user.name=FreeBuddy Test",
      "-c",
      "user.email=test@freebuddy.invalid",
      "commit",
      "-m",
      "initial"
    ],
    source
  );

  try {
    const first = await ensureRemoteWorkspace(userId, source, [source]);
    const second = await ensureRemoteWorkspace(userId, source, [source]);
    assert.equal(first, second);
    assert.notEqual(fs.realpathSync(first), fs.realpathSync(source));
    assert.equal(fs.readFileSync(path.join(first, "README.md"), "utf8"), "source\n");
    assert.equal(listRemoteWorkspaces(userId).length, 1);
    assert.equal(
      sourcePathForManagedWorkspace(first, listRemoteWorkspaces(userId)),
      fs.realpathSync(source)
    );
    assert.equal(
      sourcePathForManagedWorkspace(
        path.join(first, "src", "feature"),
        listRemoteWorkspaces(userId)
      ),
      path.join(fs.realpathSync(source), "src", "feature")
    );
    assert.equal(
      sourcePathForManagedWorkspace(
        path.join(path.dirname(first), "other-workspace"),
        listRemoteWorkspaces(userId)
      ),
      undefined
    );
    assert.equal(
      git(["remote", "get-url", "--push", "origin"], first),
      "disabled://freebuddy-managed-workspace"
    );
    assert.equal(git(["config", "--local", "user.name"], first), "git-alice");
    assert.equal(
      git(["config", "--local", "user.email"], first),
      "git-alice@freebuddy.local"
    );

    fs.writeFileSync(path.join(first, "README.md"), "isolated\n");
    assert.equal(
      fs.readFileSync(path.join(source, "README.md"), "utf8"),
      "source\n",
      "editing the managed clone must not modify the assigned source checkout"
    );
  } finally {
    removeRemoteWorkspacesForUser(userId);
    fs.rmSync(source, { recursive: true, force: true });
    setDbForTest(null);
    db.close();
  }
});

test("ordinary and empty directories become isolated Git-backed snapshots", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const {
    ensureRemoteWorkspace,
    listRemoteWorkspaces,
    removeRemoteWorkspacesForUser
  } = await import("../dist-electron/cli/remoteWorkspaces.js");

  const source = mkdtemp("freebuddy-folder-source-");
  const emptySource = mkdtemp("freebuddy-empty-source-");
  const outside = mkdtemp("freebuddy-outside-");
  const alice = `folder-alice-${process.pid}`;
  const bob = `folder-bob-${process.pid}`;
  const emptyUser = `folder-empty-${process.pid}`;
  insertUser(db, alice, "alice");
  insertUser(db, bob, "bob");
  insertUser(db, emptyUser, "empty-user");
  fs.writeFileSync(path.join(source, "README.md"), "ordinary source\n");
  fs.writeFileSync(path.join(source, ".gitignore"), "README.md\n");
  fs.mkdirSync(path.join(source, "node_modules"));
  fs.writeFileSync(path.join(source, "node_modules", "skip.js"), "skip\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
  let symlinkCreated = true;
  try {
    fs.symlinkSync(
      path.relative(source, outside),
      path.join(source, "outside-link")
    );
  } catch (error) {
    // Windows requires admin/Developer Mode for symlinks; skip that
    // assertion locally instead of failing the whole test.
    if (error.code !== "EPERM") throw error;
    symlinkCreated = false;
  }

  try {
    const aliceWorkspace = await ensureRemoteWorkspace(alice, source, [source]);
    const bobWorkspace = await ensureRemoteWorkspace(bob, source, [source]);
    assert.notEqual(aliceWorkspace, bobWorkspace);
    assert.notEqual(fs.realpathSync(aliceWorkspace), fs.realpathSync(source));
    assert.equal(
      fs.readFileSync(path.join(aliceWorkspace, "README.md"), "utf8"),
      "ordinary source\n"
    );
    assert.equal(fs.existsSync(path.join(aliceWorkspace, "node_modules")), false);
    if (symlinkCreated) {
      assert.equal(fs.existsSync(path.join(aliceWorkspace, "outside-link")), false);
    }
    assert.equal(git(["status", "--short"], aliceWorkspace), "");
    assert.equal(
      git(["log", "-1", "--format=%s"], aliceWorkspace),
      "FreeBuddy workspace baseline"
    );
    assert.match(git(["ls-files"], aliceWorkspace), /README\.md/);
    assert.equal(git(["remote"], aliceWorkspace), "");
    assert.equal(git(["config", "--local", "user.name"], aliceWorkspace), "alice");
    assert.equal(
      git(["config", "--local", "user.email"], aliceWorkspace),
      "alice@freebuddy.local"
    );
    assert.equal(git(["config", "--local", "user.name"], bobWorkspace), "bob");
    assert.equal(listRemoteWorkspaces(alice).length, 1);
    assert.equal(listRemoteWorkspaces(bob).length, 1);

    fs.writeFileSync(path.join(aliceWorkspace, "README.md"), "alice\n");
    assert.equal(
      fs.readFileSync(path.join(source, "README.md"), "utf8"),
      "ordinary source\n"
    );
    assert.equal(
      fs.readFileSync(path.join(bobWorkspace, "README.md"), "utf8"),
      "ordinary source\n"
    );

    const emptyWorkspace = await ensureRemoteWorkspace(
      emptyUser,
      emptySource,
      [emptySource]
    );
    assert.equal(fs.existsSync(path.join(emptyWorkspace, ".git")), true);
    assert.equal(
      git(["log", "-1", "--format=%s"], emptyWorkspace),
      "FreeBuddy workspace baseline"
    );
    assert.equal(git(["status", "--short"], emptyWorkspace), "");

    db.prepare("UPDATE remote_users SET username = ? WHERE id = ?").run(
      "alice-renamed",
      alice
    );
    const reused = await ensureRemoteWorkspace(alice, source, [source]);
    assert.equal(reused, aliceWorkspace);
    assert.equal(
      git(["config", "--local", "user.name"], aliceWorkspace),
      "alice-renamed"
    );
    assert.equal(
      git(["config", "--local", "user.email"], aliceWorkspace),
      "alice-renamed@freebuddy.local"
    );
  } finally {
    removeRemoteWorkspacesForUser(alice);
    removeRemoteWorkspacesForUser(bob);
    removeRemoteWorkspacesForUser(emptyUser);
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(emptySource, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    setDbForTest(null);
    db.close();
  }
});

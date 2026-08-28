import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createTaskBranch,
  inspectTaskWorkspace,
  prepareTaskWorkspace
} from "../dist-electron/cli/taskWorkspace.js";

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function createRepository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "FreeBuddy Test"]);
  git(root, ["config", "user.email", "freebuddy@example.invalid"]);
  fs.writeFileSync(path.join(root, "README.md"), "# task workspace\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  git(root, ["branch", "-M", "main"]);
  git(root, ["branch", "feature/context-bar"]);
}

test("task workspace inspection lists the current and available local branches", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-task-workspace-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  createRepository(repo);

  const info = await inspectTaskWorkspace(repo);
  assert.equal(info.isGitRepository, true);
  assert.equal(path.resolve(info.root), path.resolve(repo));
  assert.equal(info.currentBranch, "main");
  assert.deepEqual(info.branches, ["main", "feature/context-bar"]);
});

test("task workspace creates and checks out a validated branch", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-task-branch-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  createRepository(repo);
  fs.writeFileSync(path.join(repo, "draft.txt"), "keep me\n", "utf8");

  const info = await createTaskBranch({
    cwd: repo,
    name: "feature/search-and-create",
    startPoint: "main"
  });

  assert.equal(info.currentBranch, "feature/search-and-create");
  assert.equal(info.branches[0], "feature/search-and-create");
  assert.equal(git(repo, ["branch", "--show-current"]), "feature/search-and-create");
  assert.match(git(repo, ["status", "--porcelain"]), /draft\.txt/);
  await assert.rejects(
    createTaskBranch({ cwd: repo, name: "feature/search-and-create" }),
    /already exists/
  );
  await assert.rejects(
    createTaskBranch({ cwd: repo, name: "bad branch name" }),
    /Invalid Git branch name/
  );
});

test("worktree mode creates an isolated checkout from the selected branch", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-task-worktree-"));
  const repo = path.join(tempRoot, "repo");
  const worktreeBase = path.join(tempRoot, "managed-worktrees");
  createRepository(repo);
  let worktreeRoot;
  t.after(() => {
    if (worktreeRoot && fs.existsSync(worktreeRoot)) {
      try {
        git(repo, ["worktree", "remove", "--force", worktreeRoot]);
      } catch {
        // The temp tree cleanup below is sufficient when Git already pruned it.
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const prepared = await prepareTaskWorkspace(
    {
      cwd: repo,
      mode: "worktree",
      branch: "feature/context-bar",
      taskKey: "task-context-123456"
    },
    worktreeBase
  );
  worktreeRoot = prepared.worktreeRoot;

  assert.equal(prepared.mode, "worktree");
  assert.equal(prepared.branch, "feature/context-bar");
  assert.equal(path.resolve(prepared.sourceCwd), path.resolve(repo));
  assert.equal(fs.existsSync(prepared.cwd), true);
  assert.equal(git(prepared.cwd, ["branch", "--show-current"]), "");
  assert.equal(
    git(prepared.cwd, ["rev-parse", "HEAD"]),
    git(repo, ["rev-parse", "feature/context-bar"])
  );
});

test("local mode switches branches only from a clean workspace", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-task-local-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  createRepository(repo);

  const prepared = await prepareTaskWorkspace(
    {
      cwd: repo,
      mode: "local",
      branch: "feature/context-bar",
      taskKey: "task-local-123456"
    },
    path.join(tempRoot, "unused")
  );
  assert.equal(prepared.cwd, path.resolve(repo));
  assert.equal(git(repo, ["branch", "--show-current"]), "feature/context-bar");

  fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty\n", "utf8");
  await assert.rejects(
    prepareTaskWorkspace(
      {
        cwd: repo,
        mode: "local",
        branch: "main",
        taskKey: "task-local-654321"
      },
      path.join(tempRoot, "unused")
    ),
    /requires a clean Git workspace/
  );
});

test("new task composer renders workspace, mode, and branch below the toolbar", () => {
  const source = fs.readFileSync(
    new URL("../src/components/CLI/ChatView.tsx", import.meta.url),
    "utf8"
  );
  const toolbarStart = source.indexOf('<div className="new-task-toolbar">');
  const contextBar = source.indexOf('data-testid="new-task-context-bar"');
  assert.ok(toolbarStart >= 0);
  assert.ok(contextBar > toolbarStart);
  const context = source.slice(contextBar);
  assert.match(context, /workspaceModeWorktree/);
  assert.match(context, /branchAria/);
  assert.ok(
    context.indexOf('t("chat.branchAria")') <
      context.indexOf('t("chat.workspaceModeAria")')
  );
  assert.match(source, /className="task-context-dropdown-menu"/);
  assert.match(source, /searchableAfter=\{7\}/);
  assert.match(source, /createTaskBranch/);
  assert.match(source, /createBranchConfirm/);
  assert.match(source, /prepareTaskWorkspace/);
});

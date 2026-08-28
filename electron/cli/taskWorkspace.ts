import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_GIT_OUTPUT = 1024 * 1024;
const TASK_KEY_PATTERN = /^[a-zA-Z0-9_-]{6,80}$/;

export type TaskWorkspaceMode = "local" | "worktree";

export interface GitWorkspaceInfo {
  isGitRepository: boolean;
  root?: string;
  currentBranch?: string;
  branches: string[];
}

export interface PrepareTaskWorkspaceInput {
  cwd: string;
  mode: TaskWorkspaceMode;
  branch?: string;
  taskKey: string;
}

export interface CreateTaskBranchInput {
  cwd: string;
  name: string;
  startPoint?: string;
}

export interface PreparedTaskWorkspace {
  cwd: string;
  sourceCwd: string;
  mode: TaskWorkspaceMode;
  branch?: string;
  gitRoot?: string;
  worktreeRoot?: string;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true
  });
  return result.stdout.trim();
}

function normalizeDirectory(cwd: string): string {
  const normalized = path.resolve(cwd.trim());
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    throw new Error("Task workspace must be a directory");
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function worktreeFolderName(sourceRoot: string): string {
  const base = path.basename(sourceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return base.slice(0, 40) || "workspace";
}

function gitErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
  if (stderr) return stderr;
  return typeof candidate.message === "string" ? candidate.message : String(error);
}

export async function inspectTaskWorkspace(cwd: string): Promise<GitWorkspaceInfo> {
  let directory: string;
  try {
    directory = normalizeDirectory(cwd);
  } catch {
    return { isGitRepository: false, branches: [] };
  }

  let root: string;
  try {
    root = path.resolve(await runGit(directory, ["rev-parse", "--show-toplevel"]));
  } catch {
    return { isGitRepository: false, branches: [] };
  }

  let currentBranch: string | undefined;
  try {
    currentBranch = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    currentBranch = undefined;
  }

  let branches: string[] = [];
  try {
    const output = await runGit(root, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads"
    ]);
    branches = output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    branches = [];
  }

  branches = Array.from(new Set(branches)).sort((a, b) => {
    if (a === currentBranch) return -1;
    if (b === currentBranch) return 1;
    return a.localeCompare(b);
  });
  if (currentBranch && !branches.includes(currentBranch)) {
    branches.unshift(currentBranch);
  }

  return {
    isGitRepository: true,
    root,
    currentBranch,
    branches
  };
}

export async function createTaskBranch(
  input: CreateTaskBranchInput
): Promise<GitWorkspaceInfo> {
  const sourceCwd = normalizeDirectory(input.cwd);
  const info = await inspectTaskWorkspace(sourceCwd);
  if (!info.isGitRepository || !info.root) {
    throw new Error("Creating a branch requires a Git repository");
  }

  const name = input.name.trim();
  if (!name) {
    throw new Error("Git branch name is required");
  }
  try {
    await runGit(info.root, ["check-ref-format", "--branch", name]);
  } catch {
    throw new Error(`Invalid Git branch name: ${name}`);
  }
  if (info.branches.includes(name)) {
    throw new Error(`Git branch already exists: ${name}`);
  }

  const startPoint = input.startPoint?.trim() || info.currentBranch || "HEAD";
  if (startPoint !== "HEAD" && !info.branches.includes(startPoint)) {
    throw new Error(`Git start branch is unavailable: ${startPoint}`);
  }
  try {
    await runGit(info.root, ["switch", "-c", name, startPoint]);
  } catch (error) {
    throw new Error(`Unable to create Git branch: ${gitErrorMessage(error)}`);
  }

  return inspectTaskWorkspace(sourceCwd);
}

export async function prepareTaskWorkspace(
  input: PrepareTaskWorkspaceInput,
  worktreeBaseDir: string
): Promise<PreparedTaskWorkspace> {
  const sourceCwd = normalizeDirectory(input.cwd);
  const info = await inspectTaskWorkspace(sourceCwd);
  if (!info.isGitRepository || !info.root) {
    if (input.mode === "worktree") {
      throw new Error("Worktree mode requires a Git repository");
    }
    return { cwd: sourceCwd, sourceCwd, mode: "local" };
  }

  const branch = input.branch?.trim() || info.currentBranch;
  if (branch && !info.branches.includes(branch)) {
    throw new Error(`Git branch is unavailable: ${branch}`);
  }

  if (input.mode === "local") {
    if (branch && branch !== info.currentBranch) {
      const dirty = await runGit(info.root, ["status", "--porcelain"]);
      if (dirty) {
        throw new Error("Switching the local branch requires a clean Git workspace");
      }
      try {
        await runGit(info.root, ["switch", branch]);
      } catch (error) {
        throw new Error(`Unable to switch Git branch: ${gitErrorMessage(error)}`);
      }
    }
    return {
      cwd: sourceCwd,
      sourceCwd,
      mode: "local",
      branch,
      gitRoot: info.root
    };
  }

  if (!TASK_KEY_PATTERN.test(input.taskKey)) {
    throw new Error("Invalid task workspace key");
  }
  const startRef = branch || "HEAD";
  const repoKey = createHash("sha256").update(info.root).digest("hex").slice(0, 12);
  const repoDir = `${worktreeFolderName(info.root)}-${repoKey}`;
  const worktreeRoot = path.resolve(worktreeBaseDir, repoDir, input.taskKey);
  const resolvedBase = path.resolve(worktreeBaseDir);
  if (!isWithin(resolvedBase, worktreeRoot)) {
    throw new Error("Invalid task worktree path");
  }
  if (fs.existsSync(worktreeRoot)) {
    throw new Error("Task worktree already exists");
  }
  fs.mkdirSync(path.dirname(worktreeRoot), { recursive: true });

  try {
    await runGit(info.root, ["worktree", "add", "--detach", worktreeRoot, startRef]);
  } catch (error) {
    throw new Error(`Unable to create Git worktree: ${gitErrorMessage(error)}`);
  }

  const relativeCwd = path.relative(info.root, sourceCwd);
  const preparedCwd = path.resolve(worktreeRoot, relativeCwd);
  if (!isWithin(worktreeRoot, preparedCwd) || !fs.existsSync(preparedCwd)) {
    try {
      await runGit(info.root, ["worktree", "remove", "--force", worktreeRoot]);
    } catch {
      // Best effort cleanup; preserve the original error below.
    }
    throw new Error("The selected project folder is unavailable in the new worktree");
  }

  return {
    cwd: preparedCwd,
    sourceCwd,
    mode: "worktree",
    branch,
    gitRoot: info.root,
    worktreeRoot
  };
}

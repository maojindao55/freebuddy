import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { getDb } from "./db.js";
import { getUserById } from "./users.js";
import { isPathWithinRoots } from "../shared/workspaceRoots.js";
import { getRemoteWorkspacesRoot } from "./windowsSandboxPaths.js";

export interface RemoteWorkspace {
  id: string;
  ownerId: string;
  sourcePath: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
}

const materializeLocks = new Map<string, Promise<void>>();

const SNAPSHOT_EXCLUDED_NAMES = new Set([".git", ".hg", ".svn"]);

const SNAPSHOT_EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "coverage",
  "target"
]);

function rowToWorkspace(row: any): RemoteWorkspace {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sourcePath: row.source_path,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listRemoteWorkspaces(userId: string): RemoteWorkspace[] {
  return (
    getDb()
      .prepare(
        `SELECT id, owner_id, source_path, workspace_path, created_at, updated_at
         FROM remote_workspaces
         WHERE owner_id = ?
         ORDER BY created_at ASC`
      )
      .all(userId) as any[]
  ).map(rowToWorkspace);
}

export function listRemoteWorkspacePaths(userId: string): string[] {
  return listRemoteWorkspaces(userId)
    .map((workspace) => workspace.workspacePath)
    .filter((workspacePath) => {
      try {
        return fs.statSync(workspacePath).isDirectory();
      } catch {
        return false;
      }
    });
}

export function sourcePathForManagedWorkspace(
  workspacePath: string,
  workspaces: RemoteWorkspace[]
): string | undefined {
  const requested = path.resolve(workspacePath);
  for (const workspace of workspaces) {
    const managedRoot = path.resolve(workspace.workspacePath);
    const relativePath = path.relative(managedRoot, requested);
    if (
      relativePath === "" ||
      (!path.isAbsolute(relativePath) &&
        !relativePath.startsWith(`..${path.sep}`) &&
        relativePath !== "..")
    ) {
      return path.resolve(workspace.sourcePath, relativePath);
    }
  }
  return undefined;
}

function realDirectory(target: string): string {
  const real = fs.realpathSync.native(path.resolve(target));
  if (!fs.statSync(real).isDirectory()) {
    throw new Error("remote_workspace_not_a_directory");
  }
  return real;
}

function isHostAppDataPath(candidate: string): boolean {
  if (process.platform !== "win32") return false;
  const resolved = path.resolve(candidate).toLowerCase();
  for (const root of [
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    path.join(os.homedir(), "AppData", "Roaming"),
    path.join(os.homedir(), "AppData", "Local")
  ]) {
    if (!root) continue;
    const normalized = path.resolve(root).toLowerCase();
    if (
      resolved === normalized ||
      resolved.startsWith(`${normalized}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}

function existingWorkspacePath(userId: string, requestedPath: string): string | null {
  let requestedReal: string;
  try {
    requestedReal = realDirectory(requestedPath);
  } catch {
    return null;
  }
  // Legacy Windows clones lived under %APPDATA%; Bun Agents lstat that parent
  // and fail closed. Force rematerialization into ProgramData instead.
  if (isHostAppDataPath(requestedReal)) return null;
  for (const workspace of listRemoteWorkspaces(userId)) {
    let workspaceReal: string;
    try {
      workspaceReal = realDirectory(workspace.workspacePath);
    } catch {
      continue;
    }
    if (isHostAppDataPath(workspaceReal)) continue;
    if (isPathWithinRoots(requestedReal, [workspaceReal])) return requestedReal;
  }
  return null;
}

function authorizedSource(
  requestedPath: string,
  sourceRoots: string[]
): { requestedReal: string; allowedRoot: string } {
  const requestedReal = realDirectory(requestedPath);
  const canonicalRoots = sourceRoots
    .map((root) => {
      try {
        return realDirectory(root);
      } catch {
        return null;
      }
    })
    .filter((root): root is string => Boolean(root))
    .sort((a, b) => b.length - a.length);
  const allowedRoot = canonicalRoots.find((root) =>
    isPathWithinRoots(requestedReal, [root])
  );
  if (!allowedRoot) throw new Error("forbidden_path: cwd");
  return { requestedReal, allowedRoot };
}

function findGitRoot(start: string, allowedRoot: string): string | null {
  let cursor = start;
  while (isPathWithinRoots(cursor, [allowedRoot])) {
    if (fs.existsSync(path.join(cursor, ".git"))) return cursor;
    if (cursor === allowedRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function safeWorkspaceName(sourcePath: string): string {
  const base =
    path.basename(sourcePath)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "repository";
  const digest = createHash("sha256").update(sourcePath).digest("hex").slice(0, 12);
  return `${base}-${digest}`;
}

function runGit(
  args: string[],
  errorCode = "remote_workspace_git_failed"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${errorCode}${
              stderr.trim() ? `: ${stderr.trim()}` : ""
            }`
          )
        );
      }
    });
  });
}

async function configureWorkspaceGitIdentity(
  userId: string,
  workspacePath: string
): Promise<void> {
  const user = getUserById(userId);
  if (!user) throw new Error("remote_workspace_owner_not_found");
  await runGit([
    "-C",
    workspacePath,
    "config",
    "--local",
    "user.name",
    user.username
  ]);
  await runGit([
    "-C",
    workspacePath,
    "config",
    "--local",
    "user.email",
    `${user.username.toLowerCase()}@freebuddy.local`
  ]);
}

async function cloneWorkspace(
  userId: string,
  sourcePath: string,
  workspacePath: string
): Promise<void> {
  const ownerDir = path.join(getRemoteWorkspacesRoot(), userId);
  fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    ownerDir,
    `.${path.basename(workspacePath)}.tmp-${randomUUID()}`
  );
  try {
    await runGit(
      ["clone", "--no-hardlinks", "--", sourcePath, temporaryPath],
      "remote_workspace_clone_failed"
    );
    await runGit([
      "-C",
      temporaryPath,
      "remote",
      "set-url",
      "--push",
      "origin",
      "disabled://freebuddy-managed-workspace"
    ]);
    await configureWorkspaceGitIdentity(userId, temporaryPath);
    fs.renameSync(temporaryPath, workspacePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

function shouldCopySnapshotEntry(sourceRoot: string, entryPath: string): boolean {
  const relative = path.relative(sourceRoot, entryPath);
  if (!relative) return true;
  const segments = relative.split(path.sep);
  if (segments.some((segment) => SNAPSHOT_EXCLUDED_NAMES.has(segment))) {
    return false;
  }
  if (
    segments
      .slice(0, -1)
      .some((segment) => SNAPSHOT_EXCLUDED_DIRECTORY_NAMES.has(segment))
  ) {
    return false;
  }

  try {
    const stat = fs.lstatSync(entryPath);
    if (
      stat.isDirectory() &&
      SNAPSHOT_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath))
    ) {
      return false;
    }
    if (!stat.isSymbolicLink()) return stat.isDirectory() || stat.isFile();
    const target = fs.readlinkSync(entryPath);
    if (path.isAbsolute(target)) return false;
    const resolvedTarget = fs.realpathSync.native(entryPath);
    return isPathWithinRoots(resolvedTarget, [sourceRoot]);
  } catch {
    // Skip dangling links and entries that changed while the snapshot was made.
    return false;
  }
}

async function snapshotWorkspace(
  userId: string,
  sourcePath: string,
  workspacePath: string
): Promise<void> {
  const ownerDir = path.join(getRemoteWorkspacesRoot(), userId);
  fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    ownerDir,
    `.${path.basename(workspacePath)}.tmp-${randomUUID()}`
  );
  try {
    await fs.promises.cp(sourcePath, temporaryPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (entryPath) => shouldCopySnapshotEntry(sourcePath, entryPath)
    });
    await runGit(["-C", temporaryPath, "init", "--initial-branch=main"]);
    await configureWorkspaceGitIdentity(userId, temporaryPath);
    await runGit(["-C", temporaryPath, "add", "-A", "--force"]);
    await runGit([
      "-c",
      `core.hooksPath=${os.devNull}`,
      "-c",
      "commit.gpgSign=false",
      "-C",
      temporaryPath,
      "-c",
      "user.name=FreeBuddy",
      "-c",
      "user.email=workspace@freebuddy.local",
      "commit",
      "--allow-empty",
      "-m",
      "FreeBuddy workspace baseline"
    ]);
    fs.renameSync(temporaryPath, workspacePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
    throw new Error(
      `remote_workspace_snapshot_failed: ${
        (error as Error)?.message || String(error)
      }`
    );
  }
}

async function materialize(
  userId: string,
  requestedPath: string,
  sourceRoots: string[]
): Promise<string> {
  const alreadyIsolated = existingWorkspacePath(userId, requestedPath);
  if (alreadyIsolated) {
    await configureWorkspaceGitIdentity(userId, alreadyIsolated);
    return alreadyIsolated;
  }

  const { requestedReal, allowedRoot } = authorizedSource(
    requestedPath,
    sourceRoots
  );
  const gitRoot = findGitRoot(requestedReal, allowedRoot);
  const sourcePath = gitRoot ?? requestedReal;
  const relativePath = path.relative(sourcePath, requestedReal);
  const existing = getDb()
    .prepare(
      `SELECT id, owner_id, source_path, workspace_path, created_at, updated_at
       FROM remote_workspaces
       WHERE owner_id = ? AND source_path = ?`
    )
    .get(userId, sourcePath) as any;
  const preferredWorkspacePath = path.join(
    getRemoteWorkspacesRoot(),
    userId,
    safeWorkspaceName(sourcePath)
  );
  const legacyWorkspacePath =
    existing?.workspace_path && isHostAppDataPath(existing.workspace_path)
      ? existing.workspace_path
      : null;
  const workspacePath =
    legacyWorkspacePath == null && existing?.workspace_path
      ? existing.workspace_path
      : preferredWorkspacePath;

  const needsMaterialization = !fs.existsSync(workspacePath);
  if (needsMaterialization) {
    if (gitRoot) {
      await cloneWorkspace(userId, sourcePath, workspacePath);
    } else {
      await snapshotWorkspace(userId, sourcePath, workspacePath);
    }
  } else if (!fs.statSync(workspacePath).isDirectory()) {
    throw new Error("remote_workspace_path_unavailable");
  }
  if (!needsMaterialization) {
    await configureWorkspaceGitIdentity(userId, workspacePath);
  }

  const now = new Date().toISOString();
  if (existing) {
    getDb()
      .prepare(
        `UPDATE remote_workspaces
         SET workspace_path = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(workspacePath, now, existing.id);
  } else {
    getDb()
      .prepare(
        `INSERT INTO remote_workspaces
           (id, owner_id, source_path, workspace_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), userId, sourcePath, workspacePath, now, now);
  }

  const mapped = path.resolve(workspacePath, relativePath);
  if (!isPathWithinRoots(mapped, [workspacePath]) || !fs.existsSync(mapped)) {
    throw new Error("remote_workspace_subdirectory_unavailable");
  }
  return mapped;
}

/**
 * Return a stable, per-user workspace for an assigned path. Git repositories
 * are cloned; ordinary and empty directories are copied into a private
 * snapshot with a local Git baseline.
 */
export function ensureRemoteWorkspace(
  userId: string,
  requestedPath: string,
  sourceRoots: string[]
): Promise<string> {
  // Serialize materialization per user. Two simultaneous requests for
  // different subdirectories of the same repository must not race while
  // cloning the same destination.
  const key = userId;
  const previous = materializeLocks.get(key) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => materialize(userId, requestedPath, sourceRoots));
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  materializeLocks.set(key, tail);
  void tail.finally(() => {
    if (materializeLocks.get(key) === tail) materializeLocks.delete(key);
  });
  return result;
}

export function removeRemoteWorkspacesForUser(userId: string): number {
  const workspaces = listRemoteWorkspaces(userId);
  const managedRoot = path.join(getRemoteWorkspacesRoot(), userId);
  const remoteWorkspaceRoot = getRemoteWorkspacesRoot();
  if (isPathWithinRoots(managedRoot, [remoteWorkspaceRoot])) {
    fs.rmSync(managedRoot, { recursive: true, force: true });
  }
  getDb().prepare("DELETE FROM remote_workspaces WHERE owner_id = ?").run(userId);
  return workspaces.length;
}

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface WorkspaceFileMatch {
  path: string;
  name: string;
  directory: string;
}

interface WorkspaceFileCacheEntry {
  indexedAt: number;
  files: string[];
}

const CACHE_TTL_MS = 5_000;
const MAX_INDEXED_FILES = 40_000;
const MAX_GIT_OUTPUT_BYTES = 12 * 1024 * 1024;
const DEFAULT_RESULT_LIMIT = 24;
const MAX_RESULT_LIMIT = 100;

const IGNORED_FALLBACK_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "node_modules",
  "bower_components",
  "coverage",
  "dist",
  "build",
  "out",
  "target"
]);

const workspaceFileCache = new Map<string, WorkspaceFileCacheEntry>();

function normalizedRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.includes("\0") || path.posix.isAbsolute(normalized)) {
    return null;
  }
  const cleaned = path.posix.normalize(normalized);
  if (cleaned === ".." || cleaned.startsWith("../")) return null;
  return cleaned;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveWorkspaceRoot(cwd: string): Promise<string | null> {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  try {
    const root = await fs.realpath(cwd);
    const stat = await fs.stat(root);
    return stat.isDirectory() ? root : null;
  } catch {
    return null;
  }
}

function readGitWorkspaceFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_GIT_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (overflow || code !== 0) {
        resolve(null);
        return;
      }
      const files = Buffer.concat(chunks)
        .toString("utf8")
        .split("\0")
        .map(normalizedRelativePath)
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, MAX_INDEXED_FILES);
      resolve(files);
    });
  });
}

async function readFallbackWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [""];

  while (pending.length > 0 && files.length < MAX_INDEXED_FILES) {
    const relDir = pending.pop()!;
    const absoluteDir = path.join(root, relDir);
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_INDEXED_FILES) break;
      const rel = normalizedRelativePath(path.posix.join(relDir.replace(/\\/g, "/"), entry.name));
      if (!rel) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_FALLBACK_DIRECTORIES.has(entry.name)) pending.push(rel);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) files.push(rel);
    }
  }

  return files;
}

async function indexWorkspaceFiles(root: string): Promise<string[]> {
  const cached = workspaceFileCache.get(root);
  if (cached && Date.now() - cached.indexedAt < CACHE_TTL_MS) {
    return cached.files;
  }

  const gitFiles = await readGitWorkspaceFiles(root);
  const files = [...new Set(gitFiles ?? (await readFallbackWorkspaceFiles(root)))].sort(
    (a, b) => a.localeCompare(b)
  );
  workspaceFileCache.set(root, { indexedAt: Date.now(), files });
  return files;
}

function fuzzySubsequenceScore(value: string, query: string): number | null {
  let queryIndex = 0;
  let firstMatch = -1;
  let previousMatch = -1;
  let gaps = 0;

  for (let i = 0; i < value.length && queryIndex < query.length; i += 1) {
    if (value[i] !== query[queryIndex]) continue;
    if (firstMatch < 0) firstMatch = i;
    if (previousMatch >= 0) gaps += i - previousMatch - 1;
    previousMatch = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return null;
  return 80 + Math.max(firstMatch, 0) + gaps;
}

export function workspaceFileMatchScore(filePath: string, rawQuery: string): number | null {
  const query = rawQuery.trim().replace(/\\/g, "/").toLocaleLowerCase();
  const normalizedPath = filePath.toLocaleLowerCase();
  const name = path.posix.basename(normalizedPath);
  const depth = normalizedPath.split("/").length - 1;

  if (!query) return depth * 4 + normalizedPath.length / 100;
  if (name === query) return 0;
  if (name.startsWith(query)) return 10 + name.length / 100;
  const nameIndex = name.indexOf(query);
  if (nameIndex >= 0) return 20 + nameIndex + name.length / 100;
  if (normalizedPath.startsWith(query)) return 30 + depth;
  const pathIndex = normalizedPath.indexOf(query);
  if (pathIndex >= 0) return 40 + pathIndex + depth;
  return fuzzySubsequenceScore(normalizedPath, query);
}

async function isExistingWorkspaceFile(root: string, rel: string): Promise<boolean> {
  const absolute = path.resolve(root, rel);
  if (!isWithinRoot(root, absolute)) return false;
  try {
    const stat = await fs.lstat(absolute);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function searchWorkspaceFiles(
  cwd: string,
  query: string,
  requestedLimit = DEFAULT_RESULT_LIMIT
): Promise<WorkspaceFileMatch[]> {
  const root = await resolveWorkspaceRoot(cwd);
  if (!root) return [];
  const limit = Math.min(Math.max(Math.trunc(requestedLimit) || DEFAULT_RESULT_LIMIT, 1), MAX_RESULT_LIMIT);
  const files = await indexWorkspaceFiles(root);
  const ranked = files
    .map((filePath) => ({ filePath, score: workspaceFileMatchScore(filePath, query) }))
    .filter((entry): entry is { filePath: string; score: number } => entry.score != null)
    .sort((a, b) => a.score - b.score || a.filePath.localeCompare(b.filePath));

  const matches: WorkspaceFileMatch[] = [];
  for (const entry of ranked) {
    if (matches.length >= limit) break;
    if (!(await isExistingWorkspaceFile(root, entry.filePath))) continue;
    const name = path.posix.basename(entry.filePath);
    const directory = path.posix.dirname(entry.filePath);
    matches.push({
      path: entry.filePath,
      name,
      directory: directory === "." ? "" : directory
    });
  }
  return matches;
}

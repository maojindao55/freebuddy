import fs from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";

export const MAX_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_SKILL_ARCHIVE_FILES = 500;
export const MAX_SKILL_ARCHIVE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_ARCHIVE_EXPANDED_BYTES = 20 * 1024 * 1024;

function safeEntryPath(entryName: string): string {
  if (entryName.includes("\0")) throw new Error("ZIP contains an invalid file name");
  const portable = entryName.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) {
    throw new Error(`ZIP contains an absolute path: ${entryName}`);
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (!normalized || normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`ZIP contains a path outside the archive: ${entryName}`);
  }
  return normalized;
}

function isSymbolicLink(entry: AdmZip.IZipEntry): boolean {
  const madeByUnix = (entry.header.made >>> 8) === 3;
  const unixMode = (entry.attr >>> 16) & 0xffff;
  return madeByUnix && (unixMode & 0o170000) === 0o120000;
}

/** Case-fold archive paths so Windows collisions cannot bypass duplicate checks. */
export function archivePathCollisionKey(relative: string): string {
  return relative
    .replace(/\/+$/, "")
    .split("/")
    .map((part) => part.toLocaleLowerCase("en-US"))
    .join("/");
}

interface SeenArchivePath {
  original: string;
  isDirectory: boolean;
}

/**
 * Allow normal "directory entry + descendant files" ZIPs, but reject:
 * - case-folded duplicates (SKILL.md vs skill.md)
 * - a file that shares a prefix with another path (nested vs nested/SKILL.md)
 */
function assertUniqueArchivePath(
  seen: Map<string, SeenArchivePath>,
  relative: string,
  isDirectory: boolean
): void {
  const key = archivePathCollisionKey(relative);
  if (!key) return;
  const existing = seen.get(key);
  if (existing !== undefined) {
    throw new Error(
      existing.original === relative
        ? `Skill ZIP contains a duplicate path: ${relative}`
        : `Skill ZIP contains colliding paths: ${relative} and ${existing.original}`
    );
  }
  for (const [otherKey, other] of seen) {
    if (key.startsWith(`${otherKey}/`)) {
      // Current path is under a previously seen path — only valid if that path is a directory.
      if (!other.isDirectory) {
        throw new Error(
          `Skill ZIP contains colliding paths: ${relative} and ${other.original}`
        );
      }
      continue;
    }
    if (otherKey.startsWith(`${key}/`)) {
      // A previously seen path is under the current path — only valid if current is a directory.
      if (!isDirectory) {
        throw new Error(
          `Skill ZIP contains colliding paths: ${relative} and ${other.original}`
        );
      }
    }
  }
  seen.set(key, { original: relative, isDirectory });
}

function assertArchiveLimits(archivePath: string): AdmZip {
  const archiveStat = fs.statSync(archivePath);
  if (!archiveStat.isFile()) throw new Error("Skill ZIP must be a file");
  if (archiveStat.size > MAX_SKILL_ARCHIVE_BYTES) {
    throw new Error("Skill ZIP exceeds the 25 MB import limit");
  }
  return new AdmZip(archivePath);
}

function writeExtractedEntries(
  entries: Array<{ relative: string; entry: AdmZip.IZipEntry }>,
  destination: string
): void {
  if (entries.filter((item) => !item.entry.isDirectory).length > MAX_SKILL_ARCHIVE_FILES) {
    throw new Error("Skill ZIP exceeds the 500 file import limit");
  }

  let declaredBytes = 0;
  const normalizedEntries = new Map<string, SeenArchivePath>();
  for (const { relative, entry } of entries) {
    assertUniqueArchivePath(normalizedEntries, relative, entry.isDirectory);
    if (isSymbolicLink(entry)) {
      throw new Error(`Symbolic links are not allowed in Skill ZIPs: ${relative}`);
    }
    if (entry.isDirectory) continue;
    if (entry.header.size > MAX_SKILL_ARCHIVE_FILE_BYTES) {
      throw new Error(`Skill ZIP file is too large: ${relative}`);
    }
    declaredBytes += entry.header.size;
    if (declaredBytes > MAX_SKILL_ARCHIVE_EXPANDED_BYTES) {
      throw new Error("Skill ZIP exceeds the 20 MB expanded import limit");
    }
  }

  fs.mkdirSync(destination, { recursive: true });
  const destinationRoot = path.resolve(destination);
  let expandedBytes = 0;
  for (const { relative, entry } of entries) {
    const target = path.resolve(destinationRoot, ...relative.split("/"));
    if (
      target !== destinationRoot &&
      !target.startsWith(`${destinationRoot}${path.sep}`)
    ) {
      throw new Error(`Skill ZIP entry escaped the import directory: ${relative}`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const data = entry.getData();
    if (data.length > MAX_SKILL_ARCHIVE_FILE_BYTES) {
      throw new Error(`Skill ZIP file is too large: ${relative}`);
    }
    expandedBytes += data.length;
    if (expandedBytes > MAX_SKILL_ARCHIVE_EXPANDED_BYTES) {
      throw new Error("Skill ZIP exceeds the 20 MB expanded import limit");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o600 });
  }
}

export function extractSkillArchive(archivePath: string, destination: string): void {
  const archive = assertArchiveLimits(archivePath);
  const mapped = archive
    .getEntries()
    .map((entry) => {
      const relative = safeEntryPath(entry.entryName);
      return relative ? { relative, entry } : null;
    })
    .filter((value): value is { relative: string; entry: AdmZip.IZipEntry } => Boolean(value));
  writeExtractedEntries(mapped, destination);
}

/**
 * Extract only the skill subtree from a GitHub zipball.
 * GitHub archives nest files under `{repo}-{sha}/...`; ClawHub handoffs point at a
 * repo-relative `path` and must ignore sibling/root decoy SKILL.md files.
 */
export function normalizeGitHubSourcePath(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    throw new Error("GitHub skill path is required");
  }
  if (normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid GitHub skill path: ${sourcePath}`);
  }
  return normalized;
}

function stripGitHubZipRoot(relativePath: string): string | null {
  const slash = relativePath.indexOf("/");
  if (slash < 0) return null;
  return relativePath.slice(slash + 1);
}

function relativeUnderGitHubSource(
  repoRelativePath: string,
  sourcePath: string
): string | null {
  if (!sourcePath) return repoRelativePath || null;
  if (repoRelativePath === sourcePath) return null;
  if (!repoRelativePath.startsWith(`${sourcePath}/`)) return null;
  return repoRelativePath.slice(sourcePath.length + 1) || null;
}

export function extractGitHubZipSkillPath(
  archivePath: string,
  destination: string,
  sourcePath: string
): void {
  const normalizedSourcePath = normalizeGitHubSourcePath(sourcePath);
  const archive = assertArchiveLimits(archivePath);
  const mapped: Array<{ relative: string; entry: AdmZip.IZipEntry }> = [];

  for (const entry of archive.getEntries()) {
    const zipRelative = safeEntryPath(entry.entryName);
    if (!zipRelative) continue;
    const repoRelative = stripGitHubZipRoot(zipRelative);
    if (repoRelative === null) continue;
    const targetRelative = relativeUnderGitHubSource(repoRelative, normalizedSourcePath);
    if (!targetRelative) continue;
    const safeTarget = safeEntryPath(targetRelative);
    if (!safeTarget) continue;
    mapped.push({ relative: safeTarget, entry });
  }

  if (!mapped.some((item) => !item.entry.isDirectory)) {
    throw new Error(`GitHub zip did not contain ${normalizedSourcePath}`);
  }

  writeExtractedEntries(mapped, destination);
}

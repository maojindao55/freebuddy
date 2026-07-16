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

export function extractSkillArchive(archivePath: string, destination: string): void {
  const archiveStat = fs.statSync(archivePath);
  if (!archiveStat.isFile()) throw new Error("Skill ZIP must be a file");
  if (archiveStat.size > MAX_SKILL_ARCHIVE_BYTES) {
    throw new Error("Skill ZIP exceeds the 25 MB import limit");
  }

  const archive = new AdmZip(archivePath);
  const entries = archive.getEntries();
  const fileEntries = entries.filter((entry) => !entry.isDirectory);
  if (fileEntries.length > MAX_SKILL_ARCHIVE_FILES) {
    throw new Error("Skill ZIP exceeds the 500 file import limit");
  }

  let declaredBytes = 0;
  const normalizedEntries = new Set<string>();
  for (const entry of entries) {
    const relative = safeEntryPath(entry.entryName);
    if (!relative) continue;
    if (normalizedEntries.has(relative)) {
      throw new Error(`Skill ZIP contains a duplicate path: ${relative}`);
    }
    normalizedEntries.add(relative);
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
  for (const entry of entries) {
    const relative = safeEntryPath(entry.entryName);
    if (!relative) continue;
    const target = path.resolve(destinationRoot, ...relative.split("/"));
    if (!target.startsWith(`${destinationRoot}${path.sep}`)) {
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

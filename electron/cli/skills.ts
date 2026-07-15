import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

import { getDataDir, getDb } from "./db.js";
import type {
  SkillImportResult,
  SkillRecord,
  SkillSnapshot,
  SkillSource
} from "./skillTypes.js";

const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 500;
const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ParsedSkill {
  name: string;
  description: string;
  version: string;
}

function builtinRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "skills")
    : path.join(app.getAppPath(), "assets", "skills");
}

function importedRoot(): string {
  const root = path.join(getDataDir(), "skills");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function snapshotCacheRoot(): string {
  const root = path.join(getDataDir(), "skill-cache");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function getSkillOwnershipRoots(): string[] {
  return [builtinRoot(), importedRoot(), snapshotCacheRoot()];
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseSkillMarkdown(markdown: string): ParsedSkill {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter");
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) fields.set(field[1].toLowerCase(), scalar(field[2]));
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  const version = fields.get("version") || "1.0.0";
  if (!PORTABLE_NAME.test(name)) {
    throw new Error("Skill name must use lowercase letters, numbers, and hyphens");
  }
  if (!description) throw new Error("Skill description is required");
  return { name, description, version };
}

function listFiles(root: string): Array<{ absolute: string; relative: string }> {
  const result: Array<{ absolute: string; relative: string }> = [];
  let totalBytes = 0;
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed inside imported skills");
      }
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = fs.statSync(absolute).size;
      if (size > MAX_SKILL_FILE_BYTES) {
        throw new Error(`Skill file is too large: ${entry.name}`);
      }
      totalBytes += size;
      if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
        throw new Error("Skill exceeds the 20 MB import limit");
      }
      result.push({ absolute, relative: path.relative(root, absolute) });
      if (result.length > MAX_SKILL_FILES) {
        throw new Error("Skill exceeds the 500 file import limit");
      }
    }
  };
  visit(root);
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}

function hashSkill(root: string): string {
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(root)) {
    hash.update(file.relative.replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function inspectSkill(root: string): ParsedSkill & { contentHash: string } {
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error("Skill path must be a directory");
  const entry = path.join(root, "SKILL.md");
  if (!fs.statSync(entry).isFile()) throw new Error("SKILL.md was not found");
  const markdown = fs.readFileSync(entry, "utf8");
  return { ...parseSkillMarkdown(markdown), contentHash: hashSkill(root) };
}

function rowToSkill(row: any): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    source: row.source,
    rootPath: row.root_path,
    contentHash: row.content_hash,
    enabled: row.enabled === 1,
    trusted: row.trusted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function upsertSkill(
  root: string,
  source: SkillSource,
  trusted: boolean
): SkillRecord {
  const metadata = inspectSkill(root);
  const existing = getDb()
    .prepare("SELECT * FROM skills WHERE id = ?")
    .get(metadata.name) as any;
  if (existing && existing.source !== source) {
    throw new Error(`A ${existing.source} skill named ${metadata.name} already exists`);
  }
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO skills
        (id, name, description, version, source, root_path, content_hash,
         enabled, trusted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         description = excluded.description,
         version = excluded.version,
         root_path = excluded.root_path,
         content_hash = excluded.content_hash,
         trusted = excluded.trusted,
         updated_at = excluded.updated_at`
    )
    .run(
      metadata.name,
      metadata.name,
      metadata.description,
      metadata.version,
      source,
      root,
      metadata.contentHash,
      trusted ? 1 : 0,
      existing?.created_at ?? now,
      now
    );
  return getSkill(metadata.name) as SkillRecord;
}

function copySkill(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const file of listFiles(source)) {
    const target = path.join(destination, file.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.absolute, target);
  }
}

function immutableSnapshotRoot(skill: SkillRecord): string {
  const destination = path.join(snapshotCacheRoot(), skill.contentHash);
  if (fs.existsSync(path.join(destination, "SKILL.md"))) {
    try {
      if (inspectSkill(destination).contentHash === skill.contentHash) {
        return destination;
      }
    } catch {
      // Rebuild a damaged app-owned cache entry below.
    }
    fs.rmSync(destination, { recursive: true, force: true });
  }
  const temp = path.join(snapshotCacheRoot(), `.snapshot-${crypto.randomUUID()}`);
  try {
    copySkill(skill.rootPath, temp);
    const copied = inspectSkill(temp);
    if (copied.contentHash !== skill.contentHash) {
      throw new Error(`Skill ${skill.name} changed while its snapshot was created`);
    }
    if (!fs.existsSync(destination)) fs.renameSync(temp, destination);
    return destination;
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function seedBuiltinSkills(): void {
  const root = builtinRoot();
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      upsertSkill(path.join(root, entry.name), "builtin", true);
    } catch (error) {
      console.warn(`[skills] skipped builtin ${entry.name}:`, error);
    }
  }
}

export function listSkills(): SkillRecord[] {
  return (getDb()
    .prepare("SELECT * FROM skills ORDER BY source, name")
    .all() as any[]).map(rowToSkill);
}

export function getSkill(id: string): SkillRecord | undefined {
  const row = getDb().prepare("SELECT * FROM skills WHERE id = ?").get(id) as any;
  return row ? rowToSkill(row) : undefined;
}

export function resolveSkillSnapshots(ids: readonly string[]): SkillSnapshot[] {
  const unique = [...new Set(ids.filter(Boolean))];
  return unique.flatMap((id) => {
    const skill = getSkill(id);
    if (!skill?.enabled || !skill.trusted) return [];
    return [{
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      source: skill.source,
      rootPath: immutableSnapshotRoot(skill),
      contentHash: skill.contentHash
    }];
  });
}

export function importSkills(sourcePath: string): SkillImportResult {
  const result: SkillImportResult = { imported: [], errors: [] };
  let candidates = [sourcePath];
  if (!fs.existsSync(path.join(sourcePath, "SKILL.md"))) {
    candidates = fs.readdirSync(sourcePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(sourcePath, entry.name))
      .filter((candidate) => fs.existsSync(path.join(candidate, "SKILL.md")));
  }
  if (candidates.length === 0) {
    return { imported: [], errors: [{ path: sourcePath, message: "No SKILL.md found" }] };
  }
  for (const candidate of candidates) {
    let temp = "";
    try {
      const metadata = inspectSkill(candidate);
      const existing = getSkill(metadata.name);
      if (existing?.source === "builtin") {
        throw new Error("A built-in skill with this name already exists");
      }
      const destination = path.join(importedRoot(), metadata.name);
      temp = path.join(importedRoot(), `.import-${crypto.randomUUID()}`);
      copySkill(candidate, temp);
      inspectSkill(temp);
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(temp, destination);
      temp = "";
      result.imported.push(upsertSkill(destination, "imported", true));
    } catch (error) {
      result.errors.push({ path: candidate, message: (error as Error).message });
    } finally {
      if (temp && fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  return result;
}

export function setSkillEnabled(id: string, enabled: boolean): SkillRecord | undefined {
  getDb().prepare("UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
  return getSkill(id);
}

export function deleteSkill(id: string): boolean {
  const skill = getSkill(id);
  if (!skill || skill.source !== "imported") return false;
  const managedRoot = path.resolve(importedRoot());
  const target = path.resolve(skill.rootPath);
  if (!target.startsWith(`${managedRoot}${path.sep}`)) return false;
  const info = getDb().prepare("DELETE FROM skills WHERE id = ?").run(id);
  if (info.changes > 0) fs.rmSync(target, { recursive: true, force: true });
  return info.changes > 0;
}

export function readSkillMarkdown(id: string): string | undefined {
  const skill = getSkill(id);
  if (!skill) return undefined;
  return fs.readFileSync(path.join(skill.rootPath, "SKILL.md"), "utf8");
}

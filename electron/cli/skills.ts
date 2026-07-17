import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

import { getDataDir, getDb } from "./db.js";
import { extractSkillArchive } from "./skillArchive.js";
import { nextSkillEnabledFlag } from "./skillEnabled.js";
import {
  assertDestinationReadyForInstall,
  findExistingSkillForInstall,
  hasLocalSkillDrift,
  localDriftConfirmationError,
  removePathBestEffort,
  rewriteSkillIdListJson,
  rewriteWorkflowRolesSkillIdsJson,
  shouldRollbackSkillInstallFiles
} from "./skillInstallResolve.js";
import type {
  SkillImportResult,
  SkillMarketProviderId,
  SkillRecord,
  SkillSnapshot,
  SkillSource
} from "./skillTypes.js";

export { nextSkillEnabledFlag } from "./skillEnabled.js";
export {
  assertDestinationReadyForInstall,
  findExistingSkillForInstall,
  hasLocalSkillDrift,
  localDriftConfirmationError,
  removePathBestEffort,
  rewriteSkillIdListJson,
  rewriteWorkflowRolesSkillIdsJson,
  shouldRollbackSkillInstallFiles
} from "./skillInstallResolve.js";

const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 500;
const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ParsedSkill {
  name: string;
  description: string;
  version: string;
}

export interface PreparedSkillMarketMeta {
  provider: SkillMarketProviderId;
  marketSkillId: string;
  marketSlug: string;
  marketVersion: string;
  marketUrl: string;
  marketContentHash?: string;
}

export interface PreparedSkillInstallOptions {
  source: SkillSource;
  trusted: boolean;
  market?: PreparedSkillMarketMeta;
  allowLocalOverwrite?: boolean;
}

export interface PreparedSkillInstallResult {
  skill: SkillRecord;
  updated: boolean;
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
    updatedAt: row.updated_at,
    marketProvider: row.market_provider ?? null,
    marketSkillId: row.market_skill_id ?? null,
    marketSlug: row.market_slug ?? null,
    marketVersion: row.market_version ?? null,
    marketUrl: row.market_url ?? null,
    marketContentHash: row.market_content_hash ?? null
  };
}

function assertInstallConflict(
  existing: SkillRecord | undefined,
  options: PreparedSkillInstallOptions,
  skillName: string
): void {
  if (!existing) return;
  if (existing.source === "builtin") {
    throw new Error("A built-in skill with this name already exists");
  }
  if (existing.source === "imported" && options.source === "market") {
    throw new Error(
      `A locally imported skill named ${skillName} already exists. Remove it before installing from the market.`
    );
  }
  if (existing.source === "market" && options.source === "imported") {
    throw new Error(
      `A market skill named ${skillName} already exists. Remove it before importing locally.`
    );
  }
  if (existing.source === "market" && options.source === "market") {
    const sameIdentity =
      existing.marketProvider === options.market?.provider &&
      existing.marketSkillId === options.market?.marketSkillId;
    if (!sameIdentity) {
      throw new Error(
        `A market skill named ${skillName} is already installed from another source`
      );
    }
  }
}

export function getSkillByMarketIdentity(
  provider: SkillMarketProviderId,
  marketSkillId: string
): SkillRecord | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM skills WHERE market_provider = ? AND market_skill_id = ?"
    )
    .get(provider, marketSkillId) as any;
  return row ? rowToSkill(row) : undefined;
}

function migrateSkillIdReferences(
  db: ReturnType<typeof getDb>,
  fromId: string,
  toId: string,
  updatedAt: string
): void {
  if (fromId === toId) return;

  const overrides = db
    .prepare("SELECT id, skill_ids FROM cli_executor_overrides")
    .all() as Array<{ id: string; skill_ids: string | null }>;
  const updateOverride = db.prepare(
    "UPDATE cli_executor_overrides SET skill_ids = ?, updated_at = ? WHERE id = ?"
  );
  for (const row of overrides) {
    const next = rewriteSkillIdListJson(row.skill_ids, fromId, toId);
    if (next !== row.skill_ids) {
      updateOverride.run(next ?? "[]", updatedAt, row.id);
    }
  }

  const teams = db
    .prepare("SELECT id, roles_json FROM workflow_teams")
    .all() as Array<{ id: string; roles_json: string }>;
  const updateTeam = db.prepare(
    "UPDATE workflow_teams SET roles_json = ?, updated_at = ? WHERE id = ?"
  );
  for (const row of teams) {
    const next = rewriteWorkflowRolesSkillIdsJson(row.roles_json, fromId, toId);
    if (next !== row.roles_json) {
      updateTeam.run(next, updatedAt, row.id);
    }
  }
}

function upsertSkillRecord(
  root: string,
  source: SkillSource,
  trusted: boolean,
  market: PreparedSkillMarketMeta | undefined,
  previous: SkillRecord | undefined
): SkillRecord {
  const metadata = inspectSkill(root);
  const now = new Date().toISOString();
  const enabled = nextSkillEnabledFlag(previous?.enabled, { trusted });
  const db = getDb();

  // Load the row inside the transaction so a post-commit getSkill() failure cannot
  // leave the DB committed while installPreparedSkill still treats it as uncommitted.
  return db.transaction(() => {
    if (previous && previous.id !== metadata.name) {
      const taken = db
        .prepare("SELECT id FROM skills WHERE id = ?")
        .get(metadata.name) as { id: string } | undefined;
      if (taken) {
        throw new Error(
          `A skill named ${metadata.name} already exists; cannot rename market skill ${previous.id}`
        );
      }
      db.prepare("DELETE FROM skills WHERE id = ?").run(previous.id);
      migrateSkillIdReferences(db, previous.id, metadata.name, now);
    }

    db.prepare(
      `INSERT INTO skills
        (id, name, description, version, source, root_path, content_hash,
         enabled, trusted, created_at, updated_at,
         market_provider, market_skill_id, market_slug, market_version,
         market_url, market_content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         description = excluded.description,
         version = excluded.version,
         source = excluded.source,
         root_path = excluded.root_path,
         content_hash = excluded.content_hash,
         enabled = excluded.enabled,
         trusted = excluded.trusted,
         updated_at = excluded.updated_at,
         market_provider = excluded.market_provider,
         market_skill_id = excluded.market_skill_id,
         market_slug = excluded.market_slug,
         market_version = excluded.market_version,
         market_url = excluded.market_url,
         market_content_hash = excluded.market_content_hash`
    ).run(
      metadata.name,
      metadata.name,
      metadata.description,
      metadata.version,
      source,
      root,
      metadata.contentHash,
      enabled,
      trusted ? 1 : 0,
      previous?.createdAt ?? now,
      now,
      market?.provider ?? null,
      market?.marketSkillId ?? null,
      market?.marketSlug ?? null,
      market?.marketVersion ?? null,
      market?.marketUrl ?? null,
      market?.marketContentHash ?? null
    );

    const row = db
      .prepare("SELECT * FROM skills WHERE id = ?")
      .get(metadata.name) as any;
    if (!row) {
      throw new Error(`Failed to load skill record after upsert: ${metadata.name}`);
    }
    return rowToSkill(row);
  })();
}

function upsertSkill(
  root: string,
  source: SkillSource,
  trusted: boolean
): SkillRecord {
  const metadata = inspectSkill(root);
  const existing = getSkill(metadata.name);
  if (existing && existing.source !== source) {
    throw new Error(`A ${existing.source} skill named ${metadata.name} already exists`);
  }
  return upsertSkillRecord(root, source, trusted, undefined, existing);
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

export function installPreparedSkill(
  sourceRoot: string,
  options: PreparedSkillInstallOptions
): PreparedSkillInstallResult {
  const metadata = inspectSkill(sourceRoot);
  const existing = findExistingSkillForInstall({
    packageName: metadata.name,
    source: options.source,
    market: options.market
      ? {
          provider: options.market.provider,
          marketSkillId: options.market.marketSkillId
        }
      : undefined,
    getById: getSkill,
    getByMarket: getSkillByMarketIdentity
  });

  // Name collisions against a different skill must still be blocked.
  const nameOwner = getSkill(metadata.name);
  if (nameOwner && (!existing || nameOwner.id !== existing.id)) {
    assertInstallConflict(nameOwner, options, metadata.name);
  }
  assertInstallConflict(existing, options, metadata.name);

  if (
    hasLocalSkillDrift({
      existing,
      source: options.source,
      allowLocalOverwrite: options.allowLocalOverwrite,
      diskContentHash: (() => {
        if (!existing || !fs.existsSync(existing.rootPath)) return undefined;
        try {
          return inspectSkill(existing.rootPath).contentHash;
        } catch {
          return null;
        }
      })()
    })
  ) {
    throw localDriftConfirmationError();
  }

  const destination = path.join(importedRoot(), metadata.name);
  const previousRoot = existing?.rootPath;
  const temp = path.join(importedRoot(), `.install-${crypto.randomUUID()}`);
  const backup = existing
    ? path.join(importedRoot(), `.backup-${crypto.randomUUID()}`)
    : "";
  let previousMovedToBackup = false;
  let installedAtDestination = false;
  let databaseCommitted = false;

  try {
    copySkill(sourceRoot, temp);
    inspectSkill(temp);

    // Fail before moving the existing install so a colliding destination cannot
    // destroy the only copy of the user's skill files.
    assertDestinationReadyForInstall({
      destination,
      previousRoot,
      destinationExists: fs.existsSync(destination)
    });

    if (existing && previousRoot && fs.existsSync(previousRoot)) {
      fs.renameSync(previousRoot, backup);
      previousMovedToBackup = true;
    }
    if (fs.existsSync(destination)) {
      throw new Error(
        `Skill directory already exists at ${destination}; remove it before installing`
      );
    }
    fs.renameSync(temp, destination);
    installedAtDestination = true;

    const skill = upsertSkillRecord(
      destination,
      options.source,
      options.trusted,
      options.market
        ? {
            ...options.market,
            marketVersion:
              options.market.marketVersion &&
              options.market.marketVersion !== "latest"
                ? options.market.marketVersion
                : metadata.version
          }
        : undefined,
      existing
    );
    databaseCommitted = true;
    // After commit, never rethrow cleanup failures into the rollback path.
    if (backup) removePathBestEffort(backup);
    return { skill, updated: Boolean(existing) };
  } catch (error) {
    if (shouldRollbackSkillInstallFiles(databaseCommitted)) {
      if (installedAtDestination && fs.existsSync(destination)) {
        removePathBestEffort(destination);
      }
      if (
        previousMovedToBackup &&
        backup &&
        fs.existsSync(backup) &&
        previousRoot &&
        !fs.existsSync(previousRoot)
      ) {
        fs.mkdirSync(path.dirname(previousRoot), { recursive: true });
        fs.renameSync(backup, previousRoot);
      }
    }
    throw error;
  } finally {
    removePathBestEffort(temp);
    // Never delete a leftover pre-commit backup here: after a failed restore it
    // is the only remaining copy of the previous skill files.
  }
}

function importSkillsFromDirectory(sourcePath: string): SkillImportResult {
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
    try {
      const { skill } = installPreparedSkill(candidate, {
        source: "imported",
        trusted: true
      });
      result.imported.push(skill);
    } catch (error) {
      result.errors.push({ path: candidate, message: (error as Error).message });
    }
  }
  return result;
}

export function importSkills(sourcePath: string): SkillImportResult {
  if (!sourcePath.toLowerCase().endsWith(".zip")) {
    return importSkillsFromDirectory(sourcePath);
  }

  const extractionRoot = path.join(
    getDataDir(),
    "skill-imports",
    `.zip-${crypto.randomUUID()}`
  );
  try {
    extractSkillArchive(sourcePath, extractionRoot);
    const result = importSkillsFromDirectory(extractionRoot);
    return {
      imported: result.imported,
      errors: result.errors.map((entry) => ({
        ...entry,
        path: path.relative(extractionRoot, entry.path) || path.basename(sourcePath)
      }))
    };
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

export function setSkillEnabled(id: string, enabled: boolean): SkillRecord | undefined {
  getDb().prepare("UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
  return getSkill(id);
}

/** Explicit user trust after reviewing an untrusted market/imported skill. */
export function setSkillTrusted(id: string, trusted: boolean): SkillRecord | undefined {
  const skill = getSkill(id);
  if (!skill) return undefined;
  const now = new Date().toISOString();
  if (trusted) {
    // Trusting also enables the skill so it becomes selectable immediately.
    getDb()
      .prepare("UPDATE skills SET trusted = 1, enabled = 1, updated_at = ? WHERE id = ?")
      .run(now, id);
  } else {
    getDb()
      .prepare("UPDATE skills SET trusted = 0, updated_at = ? WHERE id = ?")
      .run(now, id);
  }
  return getSkill(id);
}

export function deleteSkill(id: string): boolean {
  const skill = getSkill(id);
  if (!skill || (skill.source !== "imported" && skill.source !== "market")) {
    return false;
  }
  const managedRoot = path.resolve(importedRoot());
  const target = path.resolve(skill.rootPath);
  if (!target.startsWith(`${managedRoot}${path.sep}`)) return false;

  const backup = path.join(importedRoot(), `.delete-${crypto.randomUUID()}`);
  let movedToBackup = false;
  let databaseCommitted = false;

  try {
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedToBackup = true;
    }

    const info = getDb().prepare("DELETE FROM skills WHERE id = ?").run(id);
    if (info.changes <= 0) {
      throw new Error(`Skill record ${id} could not be deleted`);
    }
    databaseCommitted = true;
    if (movedToBackup) removePathBestEffort(backup);
    return true;
  } catch (error) {
    if (
      !databaseCommitted &&
      movedToBackup &&
      fs.existsSync(backup) &&
      !fs.existsSync(target)
    ) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(backup, target);
    }
    if (databaseCommitted) {
      // DB row is gone; keep the target path free even if backup cleanup failed.
      console.warn(`[skills] deleteSkill committed for ${id} but cleanup failed:`, error);
      return true;
    }
    throw error;
  }
}

export function readSkillMarkdown(id: string): string | undefined {
  const skill = getSkill(id);
  if (!skill) return undefined;
  return fs.readFileSync(path.join(skill.rootPath, "SKILL.md"), "utf8");
}

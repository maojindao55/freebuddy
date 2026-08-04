import { randomUUID } from "node:crypto";
import path from "node:path";
import { getDb } from "./db.js";
import { getSetting, setSetting } from "./settings.js";

const CWD_MIGRATION_KEY = "projects.cwdMigration.v1";

export interface Project {
  id: string;
  name: string;
  folders: string[];
  primaryPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name: string;
  folders: string[];
  primaryPath: string;
}

/** Match frontend `projectKeyFromCwd` after trim (see conversationProjectGrouping). */
export function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").toLowerCase();
}

function projectLabelFromCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function normalizeAbsoluteFolder(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    throw new Error("Folder path is required");
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error("Folder paths must be absolute");
  }
  return path.resolve(trimmed);
}

function normalizeProjectInput(input: ProjectInput): {
  name: string;
  folders: string[];
  primaryPath: string;
} {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Project name is required");
  }
  if (!Array.isArray(input.folders) || input.folders.length < 1) {
    throw new Error("At least one folder is required");
  }

  const folders: string[] = [];
  const seen = new Set<string>();
  for (const folder of input.folders) {
    const normalized = normalizeAbsoluteFolder(folder);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    folders.push(normalized);
  }
  if (folders.length < 1) {
    throw new Error("At least one folder is required");
  }

  const primaryPath = normalizeAbsoluteFolder(input.primaryPath);
  if (!folders.includes(primaryPath)) {
    throw new Error("primaryPath must be one of folders");
  }

  return { name, folders, primaryPath };
}

function rowToProject(row: {
  id: string;
  name: string;
  folders: string;
  primary_path: string;
  created_at: string;
  updated_at: string;
}): Project {
  let folders: string[] = [];
  try {
    const parsed = JSON.parse(row.folders);
    if (Array.isArray(parsed)) {
      folders = parsed.filter((f): f is string => typeof f === "string");
    }
  } catch {
    folders = [];
  }
  return {
    id: row.id,
    name: row.name,
    folders,
    primaryPath: row.primary_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listProjects(): Project[] {
  migrateCwdGroupsToProjects();
  const rows = getDb()
    .prepare(
      `SELECT id, name, folders, primary_path, created_at, updated_at
       FROM projects
       ORDER BY updated_at DESC`
    )
    .all() as Array<{
    id: string;
    name: string;
    folders: string;
    primary_path: string;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map(rowToProject);
}

export function getProject(id: string): Project | null {
  const row = getDb()
    .prepare(
      `SELECT id, name, folders, primary_path, created_at, updated_at
       FROM projects WHERE id = ?`
    )
    .get(id) as
    | {
        id: string;
        name: string;
        folders: string;
        primary_path: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  return row ? rowToProject(row) : null;
}

export function findProjectByCwd(cwd: string): Project | null {
  const trimmed = (cwd || "").trim();
  if (!trimmed) return null;
  let normalized: string;
  try {
    normalized = path.resolve(trimmed).toLowerCase();
  } catch {
    return null;
  }
  const all = listProjects();
  for (const project of all) {
    for (const folder of project.folders) {
      let folderNormalized: string;
      try {
        folderNormalized = path.resolve(folder.trim()).toLowerCase();
      } catch {
        continue;
      }
      if (folderNormalized === normalized) return project;
    }
  }
  return null;
}

/** Resolve ACP workspace roots from project folders, else `[cwd]`. */
export function resolveWorkspaceRootsForConversation(conv: {
  projectId?: string;
  cwd?: string;
}): string[] {
  if (conv.projectId) {
    const project = getProject(conv.projectId);
    if (project?.folders?.length) {
      return project.folders
        .map((folder) => {
          const trimmed = folder.trim();
          if (!trimmed) return "";
          try {
            return path.resolve(trimmed);
          } catch {
            return "";
          }
        })
        .filter(Boolean);
    }
  }
  const cwd = conv.cwd?.trim();
  if (!cwd) return [];
  try {
    return [path.resolve(cwd)];
  } catch {
    return [];
  }
}

export function createProject(input: ProjectInput): Project {
  const normalized = normalizeProjectInput(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, folders, primary_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      normalized.name,
      JSON.stringify(normalized.folders),
      normalized.primaryPath,
      now,
      now
    );
  return getProject(id) as Project;
}

export function updateProject(id: string, input: ProjectInput): Project {
  const existing = getProject(id);
  if (!existing) {
    throw new Error(`Project not found: ${id}`);
  }
  const normalized = normalizeProjectInput(input);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE projects
       SET name = ?, folders = ?, primary_path = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      normalized.name,
      JSON.stringify(normalized.folders),
      normalized.primaryPath,
      now,
      id
    );
  return getProject(id) as Project;
}

export function deleteProject(id: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE conversations SET project_id = NULL WHERE project_id = ?`
    ).run(id);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  });
  tx();
}

export function migrateCwdGroupsToProjects(): { migrated: number } {
  if (getSetting(CWD_MIGRATION_KEY) === "1") {
    return { migrated: 0 };
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, cwd FROM conversations
       WHERE cwd IS NOT NULL AND TRIM(cwd) <> '' AND project_id IS NULL`
    )
    .all() as Array<{ id: string; cwd: string }>;

  type Group = { cwd: string; conversationIds: string[] };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const trimmed = row.cwd.trim();
    if (!trimmed) continue;
    const key = projectKeyFromCwd(trimmed);
    const existing = groups.get(key);
    if (existing) {
      existing.conversationIds.push(row.id);
      continue;
    }
    groups.set(key, { cwd: trimmed, conversationIds: [row.id] });
  }

  const insertProject = db.prepare(
    `INSERT INTO projects (id, name, folders, primary_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const updateConversation = db.prepare(
    `UPDATE conversations SET project_id = ? WHERE id = ?`
  );

  let migrated = 0;
  const tx = db.transaction(() => {
    for (const group of groups.values()) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const name = projectLabelFromCwd(group.cwd);
      insertProject.run(
        id,
        name,
        JSON.stringify([group.cwd]),
        group.cwd,
        now,
        now
      );
      for (const conversationId of group.conversationIds) {
        updateConversation.run(id, conversationId);
      }
      migrated += 1;
    }
    setSetting(CWD_MIGRATION_KEY, "1");
  });
  tx();

  return { migrated };
}

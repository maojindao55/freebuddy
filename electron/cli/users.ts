import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";

import { getDb as getGlobalDb } from "./db.js";
import {
  generateRandomPassword,
  hashPassword,
  verifyPassword
} from "../shared/passwordHash.js";
import { normalizeRoot } from "../shared/workspaceRoots.js";

let testDb: DB | null = null;
export function setDbForTest(db: DB | null): void {
  testDb = db;
}
function getDb(): DB {
  return testDb ?? getGlobalDb();
}

export interface RemoteUser {
  id: string;
  username: string;
  isOwner: boolean;
  createdAt: number;
  disabled: boolean;
  /** When true, remote agent runs use OS process sandbox (srt-win/Seatbelt/bwrap). */
  strictIsolation: boolean;
}

export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
export const MIN_PASSWORD_LENGTH = 8;
/** Default login name for the host admin account created on first enable. */
export const DEFAULT_OWNER_USERNAME = "buddy";

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_owner: number;
  created_at: number;
  disabled: number | null;
  strict_isolation: number | null;
}

function rowToUser(row: UserRow): RemoteUser {
  return {
    id: row.id,
    username: row.username,
    isOwner: row.is_owner === 1,
    createdAt: row.created_at,
    disabled: row.disabled === 1,
    strictIsolation: row.strict_isolation === 1
  };
}

const USER_COLUMNS =
  "id, username, password_hash, is_owner, created_at, disabled, strict_isolation";

/**
 * Session revocation lives in remoteAuth, which reads the users table. Taking
 * the dependency the other way would be circular, so the wiring is injected
 * from main during startup.
 */
type SessionInvalidator = (userId: string) => void;

let invalidateSessionsForUser: SessionInvalidator = () => {};

export function setSessionInvalidator(fn: SessionInvalidator): void {
  invalidateSessionsForUser = fn;
}

export function listUsers(): RemoteUser[] {
  return (getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM remote_users ORDER BY created_at ASC`)
    .all() as UserRow[]).map(rowToUser);
}

export function getUserById(id: string): RemoteUser | null {
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM remote_users WHERE id = ?`)
    .get(id) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export function getOwnerUser(): RemoteUser | null {
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM remote_users WHERE is_owner = 1 LIMIT 1`)
    .get() as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export function getLocalUserId(): string | null {
  return getOwnerUser()?.id ?? null;
}

export function createUser(input: {
  username: string;
  password?: string;
  isOwner?: boolean;
  strictIsolation?: boolean;
}): { user: RemoteUser; password: string } {
  const username = input.username.trim();
  if (!USERNAME_RE.test(username)) throw new Error("invalid_username");
  const existing = getDb()
    .prepare("SELECT 1 FROM remote_users WHERE username = ?")
    .get(username);
  if (existing) throw new Error("username_taken");
  const password = input.password ?? generateRandomPassword();
  if (password.length < 8) throw new Error("password_too_short");
  const isOwner =
    input.isOwner ??
    (
      getDb().prepare("SELECT COUNT(*) AS n FROM remote_users").get() as { n: number }
    ).n === 0
      ? 1
      : 0;
  const strictIsolation = input.strictIsolation === true ? 1 : 0;
  const id = randomUUID();
  const createdAt = Date.now();
  getDb()
    .prepare(
      "INSERT INTO remote_users (id, username, password_hash, is_owner, created_at, strict_isolation) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, username, hashPassword(password), isOwner, createdAt, strictIsolation);
  return {
    user: {
      id,
      username,
      isOwner: isOwner === 1,
      createdAt,
      disabled: false,
      strictIsolation: strictIsolation === 1
    },
    password
  };
}

export function verifyUserLogin(username: string, password: string): RemoteUser | null {
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM remote_users WHERE username = ?`)
    .get(username.trim()) as UserRow | undefined;
  if (!row) return null;
  if (row.disabled === 1) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return rowToUser(row);
}

export function resetUserPassword(id: string): { user: RemoteUser; password: string } | null {
  const user = getUserById(id);
  if (!user) return null;
  const password = generateRandomPassword();
  getDb()
    .prepare("UPDATE remote_users SET password_hash = ? WHERE id = ?")
    .run(hashPassword(password), id);
  invalidateSessionsForUser(id);
  return { user, password };
}

export function setUserPassword(id: string, plain: string): boolean {
  if (plain.length < MIN_PASSWORD_LENGTH) throw new Error("password_too_short");
  const user = getUserById(id);
  if (!user) return false;
  getDb()
    .prepare("UPDATE remote_users SET password_hash = ? WHERE id = ?")
    .run(hashPassword(plain), id);
  invalidateSessionsForUser(id);
  return true;
}

export function renameUser(id: string, nextUsername: string): RemoteUser | null {
  const username = nextUsername.trim();
  if (!USERNAME_RE.test(username)) throw new Error("invalid_username");
  const user = getUserById(id);
  if (!user) return null;
  if (user.username === username) return user;
  const taken = getDb()
    .prepare("SELECT 1 FROM remote_users WHERE username = ? AND id != ?")
    .get(username, id);
  if (taken) throw new Error("username_taken");
  getDb().prepare("UPDATE remote_users SET username = ? WHERE id = ?").run(username, id);
  return getUserById(id);
}

export function setUserDisabled(id: string, disabled: boolean): RemoteUser | null {
  const user = getUserById(id);
  if (!user) return null;
  if (user.isOwner && disabled) throw new Error("cannot_disable_owner");
  getDb()
    .prepare("UPDATE remote_users SET disabled = ? WHERE id = ?")
    .run(disabled ? 1 : 0, id);
  if (disabled) invalidateSessionsForUser(id);
  return getUserById(id);
}

export function setUserStrictIsolation(
  id: string,
  strictIsolation: boolean
): RemoteUser | null {
  const user = getUserById(id);
  if (!user) return null;
  if (user.isOwner) throw new Error("cannot_set_owner_strict_isolation");
  getDb()
    .prepare("UPDATE remote_users SET strict_isolation = ? WHERE id = ?")
    .run(strictIsolation ? 1 : 0, id);
  return getUserById(id);
}

export function ensureOwnerUser(options: { password?: string } = {}): {
  user: RemoteUser;
  password: string | null;
} {
  bootstrapOwnerFromLegacyPassword();
  const existing = getOwnerUser();
  if (existing) {
    if (options.password && options.password.length >= 8) {
      setUserPassword(existing.id, options.password);
    }
    return { user: existing, password: null };
  }
  const created = createUser({
    username: DEFAULT_OWNER_USERNAME,
    password: options.password
  });
  return { user: created.user, password: created.password };
}

export function getUserRoots(userId: string): string[] {
  const rows = getDb()
    .prepare("SELECT root_path FROM remote_user_roots WHERE user_id = ? ORDER BY root_path ASC")
    .all(userId) as Array<{ root_path: string }>;
  return rows.map((r) => r.root_path);
}

export function setUserRoots(userId: string, roots: string[]): void {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of roots) {
    const n = normalizeRoot(raw);
    if (n && !seen.has(n)) {
      seen.add(n);
      normalized.push(n);
    }
  }
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM remote_user_roots WHERE user_id = ?").run(userId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO remote_user_roots (user_id, root_path) VALUES (?, ?)"
    );
    for (const root of normalized) insert.run(userId, root);
  });
  tx();
}

export function migrateGlobalRootsToOwner(ownerId: string): void {
  if (getUserRoots(ownerId).length > 0) return;
  const row = getDb()
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get("remote.workspaceRoots") as { value: string } | undefined;
  if (!row?.value) return;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) return;
  setUserRoots(
    ownerId,
    parsed.filter((r): r is string => typeof r === "string")
  );
}

export interface UserDataFootprint {
  conversations: number;
  scheduledTasks: number;
}

export function getUserDataFootprint(id: string): UserDataFootprint {
  const count = (sql: string): number => {
    try {
      return (getDb().prepare(sql).get(id) as { n: number } | undefined)?.n ?? 0;
    } catch {
      return 0;
    }
  };
  return {
    conversations: count("SELECT COUNT(*) AS n FROM conversations WHERE owner_id = ?"),
    scheduledTasks: count("SELECT COUNT(*) AS n FROM scheduled_tasks WHERE owner_id = ?")
  };
}

/**
 * Removes the account itself. Conversations and scheduled tasks are cleared
 * beforehand by ownerCleanup, which reuses the per-record delete paths so
 * managed attachments on disk are released too.
 */
export function deleteUser(id: string): boolean {
  const user = getUserById(id);
  if (!user) return false;
  if (user.isOwner) throw new Error("cannot_delete_owner");
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM remote_user_roots WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM remote_users WHERE id = ?").run(id);
  });
  tx();
  invalidateSessionsForUser(id);
  return true;
}

export function bootstrapOwnerFromLegacyPassword(): void {
  if (getOwnerUser()) return;
  if (listUsers().length > 0) return;
  const row = getDb()
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get("remote.password") as { value: string } | undefined;
  const legacyHash = row?.value;
  if (!legacyHash || !legacyHash.startsWith("scrypt:")) return;
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO remote_users (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, 1, ?)"
    )
    .run(id, DEFAULT_OWNER_USERNAME, legacyHash, Date.now());
}

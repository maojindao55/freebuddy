import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { decryptSecret, encryptSecret } from "../store.js";
import type {
  CliAccountQuotaSnapshot,
  CliAccountStorageMode,
  CliAgentAccount
} from "../../shared/cliAccountTypes.js";

export interface CliAgentAccountRecord extends CliAgentAccount {
  credentialEncrypted?: string;
}

interface CliAgentAccountRow {
  id: string;
  adapter: string;
  label: string;
  account_identity: string | null;
  auth_method: string | null;
  storage_mode: string;
  credential_encrypted: string | null;
  profile_dir: string | null;
  is_active: number;
  quota_snapshot: string | null;
  quota_updated_at: string | null;
  last_used_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseQuotaSnapshot(raw: string | null): CliAccountQuotaSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as CliAccountQuotaSnapshot;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function rowToRecord(row: CliAgentAccountRow): CliAgentAccountRecord {
  const storageMode: CliAccountStorageMode =
    row.storage_mode === "isolated-dir" ? "isolated-dir" : "global-slot";
  return {
    id: row.id,
    adapter: row.adapter,
    label: row.label,
    ...(row.account_identity ? { accountIdentity: row.account_identity } : {}),
    ...(row.auth_method ? { authMethod: row.auth_method } : {}),
    storageMode,
    ...(row.credential_encrypted ? { credentialEncrypted: row.credential_encrypted } : {}),
    ...(row.profile_dir ? { profileDir: row.profile_dir } : {}),
    isActive: row.is_active !== 0,
    ...(row.quota_snapshot ? { quotaSnapshot: parseQuotaSnapshot(row.quota_snapshot) } : {}),
    ...(row.quota_updated_at ? { quotaUpdatedAt: row.quota_updated_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function toPublicAccount(record: CliAgentAccountRecord): CliAgentAccount {
  const { credentialEncrypted: _secret, ...publicAccount } = record;
  return publicAccount;
}

export function decryptAccountCredential(
  record: CliAgentAccountRecord
): string | undefined {
  return decryptSecret(record.credentialEncrypted);
}

export function listAccountRecords(adapter?: string): CliAgentAccountRecord[] {
  const db = getDb();
  const rows = adapter
    ? (db
        .prepare(
          `SELECT * FROM cli_agent_accounts
           WHERE adapter = ?
           ORDER BY is_active DESC, updated_at DESC, created_at ASC`
        )
        .all(adapter) as CliAgentAccountRow[])
    : (db
        .prepare(
          `SELECT * FROM cli_agent_accounts
           ORDER BY adapter ASC, is_active DESC, updated_at DESC, created_at ASC`
        )
        .all() as CliAgentAccountRow[]);
  return rows.map(rowToRecord);
}

export function getAccountRecord(id: string): CliAgentAccountRecord | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM cli_agent_accounts WHERE id = ?`)
    .get(id) as CliAgentAccountRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function getActiveAccountRecord(
  adapter: string
): CliAgentAccountRecord | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM cli_agent_accounts
       WHERE adapter = ? AND is_active = 1
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .get(adapter) as CliAgentAccountRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function findAccountByIdentity(
  adapter: string,
  identity: string
): CliAgentAccountRecord | undefined {
  const normalized = identity.trim().toLowerCase();
  if (!normalized) return undefined;
  const row = getDb()
    .prepare(
      `SELECT * FROM cli_agent_accounts
       WHERE adapter = ? AND LOWER(TRIM(account_identity)) = ?
       LIMIT 1`
    )
    .get(adapter, normalized) as CliAgentAccountRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function normalizeAccountLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Account label cannot be empty.");
  }
  if (trimmed.length > 80) {
    throw new Error("Account label is too long (maximum 80 characters).");
  }
  return trimmed;
}

export function createAccountRecord(input: {
  adapter: string;
  label: string;
  accountIdentity?: string;
  authMethod?: string;
  storageMode: CliAccountStorageMode;
  rawSecret?: string;
  profileDir?: string;
  isActive?: boolean;
  lastSyncedAt?: string;
  lastUsedAt?: string;
}): CliAgentAccountRecord {
  const db = getDb();
  const id = `acct-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  const label = normalizeAccountLabel(input.label);
  const credentialEncrypted =
    typeof input.rawSecret === "string" && input.rawSecret.length > 0
      ? encryptSecret(input.rawSecret)
      : null;

  db.transaction(() => {
    if (input.isActive) {
      db.prepare(`UPDATE cli_agent_accounts SET is_active = 0 WHERE adapter = ?`).run(
        input.adapter
      );
    }
    db.prepare(
      `INSERT INTO cli_agent_accounts (
         id, adapter, label, account_identity, auth_method, storage_mode,
         credential_encrypted, profile_dir, is_active, quota_snapshot,
         quota_updated_at, last_used_at, last_synced_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`
    ).run(
      id,
      input.adapter,
      label,
      input.accountIdentity?.trim() || null,
      input.authMethod?.trim() || null,
      input.storageMode,
      credentialEncrypted,
      input.profileDir?.trim() || null,
      input.isActive ? 1 : 0,
      input.lastUsedAt ?? (input.isActive ? now : null),
      input.lastSyncedAt ?? (credentialEncrypted ? now : null),
      now,
      now
    );
  })();

  const created = getAccountRecord(id);
  if (!created) throw new Error("Failed to create account record.");
  return created;
}

export function updateAccountCredential(
  id: string,
  rawSecret: string,
  meta: {
    accountIdentity?: string;
    authMethod?: string;
    lastSyncedAt?: string;
    lastUsedAt?: string;
  } = {}
): CliAgentAccountRecord | undefined {
  const existing = getAccountRecord(id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const encrypted = encryptSecret(rawSecret);
  getDb()
    .prepare(
      `UPDATE cli_agent_accounts SET
         credential_encrypted = ?,
         account_identity = COALESCE(?, account_identity),
         auth_method = COALESCE(?, auth_method),
         last_synced_at = ?,
         last_used_at = COALESCE(?, last_used_at),
         updated_at = ?
       WHERE id = ?`
    )
    .run(
      encrypted,
      meta.accountIdentity?.trim() || null,
      meta.authMethod?.trim() || null,
      meta.lastSyncedAt ?? now,
      meta.lastUsedAt ?? null,
      now,
      id
    );
  return getAccountRecord(id);
}

export function updateAccountLabel(
  id: string,
  label: string
): CliAgentAccountRecord {
  const normalized = normalizeAccountLabel(label);
  const existing = getAccountRecord(id);
  if (!existing) {
    throw new Error("Account not found.");
  }
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE cli_agent_accounts SET label = ?, updated_at = ? WHERE id = ?`)
    .run(normalized, now, id);
  return getAccountRecord(id)!;
}

export function updateAccountQuota(
  id: string,
  snapshot: CliAccountQuotaSnapshot
): CliAgentAccountRecord | undefined {
  const existing = getAccountRecord(id);
  if (!existing) return undefined;

  let persistedSnapshot: CliAccountQuotaSnapshot = snapshot;
  let quotaUpdatedAt = snapshot.fetchedAt;

  if (!snapshot.ok && snapshot.reason === "expired_token") {
    const previous = existing.quotaSnapshot;
    const previousGroups = previous?.groups;
    if (previousGroups && previousGroups.length > 0) {
      const cachedFetchedAt = previous.ok
        ? previous.fetchedAt
        : previous.cachedFetchedAt ?? previous.fetchedAt;
      persistedSnapshot = {
        ...snapshot,
        groups: previousGroups,
        cachedFetchedAt
      };
      quotaUpdatedAt = existing.quotaUpdatedAt ?? cachedFetchedAt;
    }
  }

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE cli_agent_accounts SET
         quota_snapshot = ?,
         quota_updated_at = ?,
         updated_at = ?
       WHERE id = ?`
    )
    .run(JSON.stringify(persistedSnapshot), quotaUpdatedAt, now, id);
  return getAccountRecord(id);
}

export function setActiveAccountInDb(adapter: string, id: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE cli_agent_accounts SET is_active = 0 WHERE adapter = ?`).run(
      adapter
    );
    if (id) {
      db.prepare(
        `UPDATE cli_agent_accounts
         SET is_active = 1, last_used_at = ?, updated_at = ?
         WHERE id = ? AND adapter = ?`
      ).run(now, now, id, adapter);
    }
  })();
}

export function deleteAccountRecord(id: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM cli_agent_accounts WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

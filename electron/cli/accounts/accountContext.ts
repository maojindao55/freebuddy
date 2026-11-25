import { getDb } from "../db.js";

export interface ActiveAccountContext {
  accountId?: string;
  revision: number;
  profileDir?: string;
  env?: Record<string, string>;
}

const accountRevisionByAdapter = new Map<string, number>();

export function getAccountRevision(adapter: string): number {
  return accountRevisionByAdapter.get(adapter) ?? 0;
}

export function bumpAccountRevision(adapter: string): number {
  const next = getAccountRevision(adapter) + 1;
  accountRevisionByAdapter.set(adapter, next);
  return next;
}

export function resetAccountRevisionsForTest(): void {
  accountRevisionByAdapter.clear();
}

export function getActiveAccountContext(adapter: string): ActiveAccountContext {
  const revision = getAccountRevision(adapter);
  try {
    const row = getDb()
      .prepare(
        `SELECT id, profile_dir FROM cli_agent_accounts
         WHERE adapter = ? AND is_active = 1
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(adapter) as
      | { id?: string; profile_dir?: string | null }
      | undefined;
    if (!row?.id) return { revision };
    return {
      accountId: row.id,
      revision,
      ...(row.profile_dir ? { profileDir: row.profile_dir } : {})
    };
  } catch {
    return { revision };
  }
}

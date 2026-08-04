import { randomUUID } from "node:crypto";

import { getDb } from "./db.js";

export type RemoteAuditEvent =
  | "login.success"
  | "login.failure"
  | "login.locked"
  | "logout"
  | "user.created"
  | "user.deleted"
  | "user.renamed"
  | "user.disabled"
  | "user.enabled"
  | "user.strict_isolation_enabled"
  | "user.strict_isolation_disabled"
  | "user.password_reset"
  | "user.password_set"
  | "user.roots_changed"
  | "session.revoked"
  | "session.revoked_all"
  | "server.enabled"
  | "server.disabled"
  | "server.config_changed";

export interface RemoteAuditEntry {
  id: string;
  createdAt: number;
  event: RemoteAuditEvent | string;
  actorId: string | null;
  actorName: string | null;
  targetId: string | null;
  targetName: string | null;
  ip: string | null;
  detail: string | null;
}

export interface RemoteAuditInput {
  event: RemoteAuditEvent;
  actorId?: string | null;
  actorName?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  ip?: string | null;
  detail?: string | null;
}

const MAX_ENTRIES = 2000;

export function recordAudit(input: RemoteAuditInput): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO remote_audit_log
         (id, created_at, event, actor_id, actor_name, target_id, target_name, ip, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      Date.now(),
      input.event,
      input.actorId ?? null,
      input.actorName ?? null,
      input.targetId ?? null,
      input.targetName ?? null,
      input.ip ?? null,
      input.detail ?? null
    );
    // Keeping the log unbounded would grow the DB forever on a busy host.
    db.prepare(
      `DELETE FROM remote_audit_log WHERE id NOT IN (
         SELECT id FROM remote_audit_log ORDER BY created_at DESC LIMIT ?
       )`
    ).run(MAX_ENTRIES);
  } catch {
    // Auditing must never break the operation it is recording.
  }
}

export function listAudit(limit = 200): RemoteAuditEntry[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, created_at, event, actor_id, actor_name, target_id, target_name, ip, detail
           FROM remote_audit_log ORDER BY created_at DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, MAX_ENTRIES))) as Array<{
      id: string;
      created_at: number;
      event: string;
      actor_id: string | null;
      actor_name: string | null;
      target_id: string | null;
      target_name: string | null;
      ip: string | null;
      detail: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      event: row.event,
      actorId: row.actor_id,
      actorName: row.actor_name,
      targetId: row.target_id,
      targetName: row.target_name,
      ip: row.ip,
      detail: row.detail
    }));
  } catch {
    return [];
  }
}

export function clearAudit(): void {
  try {
    getDb().prepare("DELETE FROM remote_audit_log").run();
  } catch {
    /* ignore */
  }
}

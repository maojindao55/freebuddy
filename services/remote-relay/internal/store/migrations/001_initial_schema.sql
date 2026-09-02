-- 001_initial_schema.sql: Initial SQLite schema for FreeBuddy Remote Relay
-- Strictly stores identity, pairing, session metadata, and audit events.
-- Business payloads, chat messages, code, terminal content, raw tokens, and private keys MUST NEVER be stored.

CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    refresh_hash TEXT NOT NULL UNIQUE,
    token_family_id TEXT NOT NULL,
    device_label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    refresh_expires_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_token_hash ON admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_refresh_hash ON admin_sessions(refresh_hash);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_family ON admin_sessions(token_family_id);

CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    paired_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_hosts_revoked ON hosts(revoked_at);

CREATE TABLE IF NOT EXISTS pairings (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    public_key TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    claimed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pairings_expires ON pairings(expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    remote_ip_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at ON audit_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events(target_type, target_id);

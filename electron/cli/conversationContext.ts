import crypto from "node:crypto";

import type { Database as DB } from "better-sqlite3";
import { nanoid } from "nanoid";

import { getDb } from "./db.js";
import { getHandoffBriefByTarget } from "./handoffBriefs.js";
import type {
  AttachConversationSharesResult,
  ConversationContextPayload,
  ConversationContextReference,
  ConversationContextReferenceType,
  HandoffBrief,
  HandoffTranscriptRef
} from "../shared/handoffTypes.js";

const SHARE_LINK_PREFIX = "freebuddy://conversation-share/v1/";
const SHARE_LINK_RE =
  /freebuddy:\/\/conversation-share\/v1\/([a-zA-Z0-9_-]{20,})/g;

let testDb: DB | null = null;

export function setConversationContextDbForTest(db: DB | null): void {
  testDb = db;
}

function db(): DB {
  return testDb ?? getDb();
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function parseBrief(raw: string): HandoffBrief | null {
  try {
    return JSON.parse(raw) as HandoffBrief;
  } catch {
    return null;
  }
}

function transcriptFromRow(row: any): HandoffTranscriptRef | undefined {
  if (!row.transcript_path) return undefined;
  return {
    format: "jsonl",
    path: row.transcript_path,
    messageCount: row.transcript_message_count ?? 0,
    byteSize: row.transcript_byte_size ?? 0,
    truncated: row.transcript_truncated === 1
  };
}

function payloadFromRow(row: any): ConversationContextPayload | null {
  const brief = parseBrief(row.brief_json);
  if (!brief) return null;
  return {
    id: row.snapshot_id ?? row.id,
    referenceType: row.reference_type as ConversationContextReferenceType,
    brief,
    source: brief.source,
    transcript: transcriptFromRow(row),
    createdAt: row.created_at
  };
}

function referenceFromRow(row: any): ConversationContextReference | null {
  const payload = payloadFromRow(row);
  if (!payload) return null;
  return {
    id: row.reference_id,
    snapshotId: payload.id,
    targetConversationId: row.target_conversation_id,
    referenceType: payload.referenceType,
    source: payload.source,
    transcriptAvailable: Boolean(payload.transcript),
    transcriptTruncated: payload.transcript?.truncated ?? false,
    createdAt: row.reference_created_at ?? row.created_at
  };
}

export interface InsertConversationContextSnapshotInput {
  id: string;
  brief: HandoffBrief;
  sourceLastMessageId?: string;
  transcript?: HandoffTranscriptRef;
}

export function insertConversationContextSnapshot(
  input: InsertConversationContextSnapshotInput
): void {
  const source = input.brief.source;
  db()
    .prepare(
      `INSERT INTO conversation_context_snapshots
         (id, source_conversation_id, source_agent_id, source_agent_name,
          source_adapter, source_title, source_cwd, brief_json,
          source_message_count, source_last_message_id, transcript_path,
          transcript_message_count, transcript_byte_size, transcript_truncated,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      source.conversationId,
      source.agentId,
      source.agentName,
      source.adapter,
      source.title,
      source.cwd ?? null,
      JSON.stringify(input.brief),
      source.messageCount,
      input.sourceLastMessageId ?? null,
      input.transcript?.path ?? null,
      input.transcript?.messageCount ?? null,
      input.transcript?.byteSize ?? null,
      input.transcript?.truncated ? 1 : 0,
      new Date().toISOString()
    );
}

export function insertConversationContextReference(input: {
  id?: string;
  targetConversationId: string;
  snapshotId: string;
  referenceType: ConversationContextReferenceType;
}): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO conversation_context_refs
         (id, target_conversation_id, snapshot_id, reference_type, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.id ?? nanoid(),
      input.targetConversationId,
      input.snapshotId,
      input.referenceType,
      new Date().toISOString()
    );
}

export function createConversationShareToken(
  snapshotId: string,
  expiresAt?: string
): string {
  const token = crypto.randomBytes(24).toString("base64url");
  db()
    .prepare(
      `INSERT INTO conversation_share_tokens
         (token_hash, snapshot_id, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`
    )
    .run(
      hashToken(token),
      snapshotId,
      expiresAt ?? null,
      new Date().toISOString()
    );
  return `${SHARE_LINK_PREFIX}${token}`;
}

export function extractConversationShareTokens(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(SHARE_LINK_RE)) {
    const token = match[1];
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

function snapshotIdForToken(token: string): string | undefined {
  const row = db()
    .prepare(
      `SELECT snapshot_id
       FROM conversation_share_tokens
       WHERE token_hash = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`
    )
    .get(hashToken(token), new Date().toISOString()) as
    | { snapshot_id: string }
    | undefined;
  return row?.snapshot_id;
}

export function attachConversationSharesFromText(
  targetConversationId: string,
  text: string
): AttachConversationSharesResult {
  const tokens = extractConversationShareTokens(text);
  if (tokens.length === 0) {
    return {
      references: listConversationContextReferences(targetConversationId),
      attachedCount: 0
    };
  }

  let attachedCount = 0;
  db().transaction(() => {
    for (const token of tokens) {
      const snapshotId = snapshotIdForToken(token);
      if (!snapshotId) {
        throw new Error("Conversation share link is invalid, expired, or revoked");
      }
      const before = db()
        .prepare(
          `SELECT 1 FROM conversation_context_refs
           WHERE target_conversation_id = ? AND snapshot_id = ?`
        )
        .get(targetConversationId, snapshotId);
      insertConversationContextReference({
        targetConversationId,
        snapshotId,
        referenceType: "share"
      });
      if (!before) attachedCount += 1;
    }
  })();

  return {
    references: listConversationContextReferences(targetConversationId),
    attachedCount
  };
}

const CONTEXT_JOIN = `
  FROM conversation_context_refs r
  JOIN conversation_context_snapshots s ON s.id = r.snapshot_id
`;

export function listConversationContextPayloads(
  targetConversationId: string
): ConversationContextPayload[] {
  const rows = db()
    .prepare(
      `SELECT r.snapshot_id, r.reference_type, r.created_at AS reference_created_at,
              s.*
       ${CONTEXT_JOIN}
       WHERE r.target_conversation_id = ?
       ORDER BY r.created_at`
    )
    .all(targetConversationId) as any[];
  return rows
    .map(payloadFromRow)
    .filter((value): value is ConversationContextPayload => Boolean(value));
}

export function listResolvedConversationContextPayloads(
  targetConversationId: string
): ConversationContextPayload[] {
  const references = listConversationContextPayloads(targetConversationId);
  const legacyHandoff = getHandoffBriefByTarget(targetConversationId);
  if (
    legacyHandoff?.brief &&
    !references.some((reference) => reference.id === legacyHandoff.id)
  ) {
    references.unshift({
      id: legacyHandoff.id,
      referenceType: "transfer",
      brief: legacyHandoff.brief,
      source: legacyHandoff.brief.source,
      transcript: legacyHandoff.transcript,
      createdAt: legacyHandoff.createdAt
    });
  }
  return references;
}

export function conversationContextPromptPrefix(
  references: ConversationContextPayload[]
): string {
  if (references.length === 0) return "";
  return (
    "One or more FreeBuddy conversation references are attached. " +
    "Use `freebuddy-context.read_context_brief` and the context read/search tools " +
    "to load relevant details before answering. Use " +
    "`freebuddy-context.list_context_sources` when you need to select among " +
    "multiple references.\n\n"
  );
}

export function listConversationContextReferences(
  targetConversationId: string
): ConversationContextReference[] {
  const rows = db()
    .prepare(
      `SELECT r.id AS reference_id, r.target_conversation_id, r.snapshot_id,
              r.reference_type, r.created_at AS reference_created_at, s.*
       ${CONTEXT_JOIN}
       WHERE r.target_conversation_id = ?
       ORDER BY r.created_at`
    )
    .all(targetConversationId) as any[];
  return rows
    .map(referenceFromRow)
    .filter((value): value is ConversationContextReference => Boolean(value));
}

export function removeConversationContextReference(
  targetConversationId: string,
  referenceId: string
): ConversationContextReference[] {
  db()
    .prepare(
      `DELETE FROM conversation_context_refs
       WHERE id = ? AND target_conversation_id = ? AND reference_type = 'share'`
    )
    .run(referenceId, targetConversationId);
  return listConversationContextReferences(targetConversationId);
}

export function deleteUnreferencedConversationContextSnapshots(): string[] {
  const rows = db()
    .prepare(
      `SELECT s.id, s.transcript_path
       FROM conversation_context_snapshots s
       WHERE NOT EXISTS (
         SELECT 1 FROM conversation_context_refs r WHERE r.snapshot_id = s.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM conversation_share_tokens t WHERE t.snapshot_id = s.id
       )`
    )
    .all() as Array<{ id: string; transcript_path?: string }>;
  const remove = db().prepare(
    `DELETE FROM conversation_context_snapshots WHERE id = ?`
  );
  db().transaction(() => {
    for (const row of rows) remove.run(row.id);
  })();
  return rows
    .map((row) => row.transcript_path)
    .filter((value): value is string => Boolean(value));
}

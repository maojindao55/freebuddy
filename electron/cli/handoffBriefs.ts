import type { Database as DB } from "better-sqlite3";
import { getDb } from "./db.js";
import type {
  HandoffBrief,
  HandoffBriefRow,
  HandoffTranscriptRef
} from "../shared/handoffTypes.js";

// Test hook: allows injecting an in-memory DB for unit tests
let testDb: DB | null = null;
export function setDbForTest(db: DB | null): void {
  testDb = db;
}
function db(): DB {
  return testDb ?? getDb();
}

export interface InsertHandoffBriefInput {
  id: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceAgentId: string;
  sourceAgentName: string;
  sourceAdapter: string;
  brief: HandoffBrief;
  sourceMessageCount: number;
  sourceLastMessageId?: string;
  transcript?: HandoffTranscriptRef;
}

function rowToHandoffBrief(r: any): HandoffBriefRow {
  let brief: HandoffBrief | null = null;
  try {
    brief = JSON.parse(r.brief_json);
  } catch {
    brief = null;
  }
  return {
    id: r.id,
    sourceConversationId: r.source_conversation_id,
    targetConversationId: r.target_conversation_id,
    sourceAgentId: r.source_agent_id,
    sourceAgentName: r.source_agent_name,
    sourceAdapter: r.source_adapter,
    brief,
    sourceMessageCount: r.source_message_count,
    sourceLastMessageId: r.source_last_message_id ?? undefined,
    transcript: r.transcript_path
      ? {
          format: "jsonl",
          path: r.transcript_path,
          messageCount: r.transcript_message_count ?? 0,
          byteSize: r.transcript_byte_size ?? 0,
          truncated: r.transcript_truncated === 1
        }
      : undefined,
    createdAt: r.created_at
  };
}

export function insertHandoffBrief(input: InsertHandoffBriefInput): HandoffBriefRow {
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO handoff_briefs
         (id, source_conversation_id, target_conversation_id,
          source_agent_id, source_agent_name, source_adapter,
          brief_json, source_message_count, source_last_message_id,
          transcript_path, transcript_message_count, transcript_byte_size,
          transcript_truncated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.sourceConversationId,
      input.targetConversationId,
      input.sourceAgentId,
      input.sourceAgentName,
      input.sourceAdapter,
      JSON.stringify(input.brief),
      input.sourceMessageCount,
      input.sourceLastMessageId ?? null,
      input.transcript?.path ?? null,
      input.transcript?.messageCount ?? null,
      input.transcript?.byteSize ?? null,
      input.transcript?.truncated ? 1 : 0,
      now
    );
  return getHandoffBrief(input.id) as HandoffBriefRow;
}

export function getHandoffBrief(id: string): HandoffBriefRow | undefined {
  const row = db().prepare(`SELECT * FROM handoff_briefs WHERE id = ?`).get(id) as any;
  return row ? rowToHandoffBrief(row) : undefined;
}

export function getHandoffBriefByTarget(targetConversationId: string): HandoffBriefRow | undefined {
  const row = db()
    .prepare(`SELECT * FROM handoff_briefs WHERE target_conversation_id = ?`)
    .get(targetConversationId) as any;
  return row ? rowToHandoffBrief(row) : undefined;
}

export function getHandoffBriefsBySource(sourceConversationId: string): HandoffBriefRow[] {
  const rows = db()
    .prepare(
      `SELECT * FROM handoff_briefs
       WHERE source_conversation_id = ?
       ORDER BY created_at DESC`
    )
    .all(sourceConversationId) as any[];
  return rows.map(rowToHandoffBrief);
}

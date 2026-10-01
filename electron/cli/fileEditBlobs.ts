import { createHash } from "node:crypto";
import type { FileEditBlobChunk, FileEditContent, FileEditPage, ToolCallStatus } from "@freebuddy/protocol";
import type { AcpStreamItem } from "./acp.js";
import { getDb } from "./db.js";
import { requireOwnedConversation } from "./conversations.js";

type FileEdit = Extract<AcpStreamItem, { kind: "file-edit" }>;
type FileEditContext = { conversationId: string; sessionId: string };
interface FileEditRow {
  sequence: number;
  blob_key: string;
  path: string;
  action: FileEdit["action"];
  partial: number;
}

function reference(row: FileEditRow): FileEdit {
  return {
    kind: "file-edit", path: row.path, action: row.action, blobKey: row.blob_key,
    ...(row.partial ? { partial: true } : {})
  };
}

function contentPayload(edit: FileEdit): Buffer {
  return Buffer.from(JSON.stringify({ oldText: edit.oldText, newText: edit.newText, patch: edit.patch }), "utf8");
}

function contentKey(context: FileEditContext, edit: FileEdit, toolCallId: string, entryIndex: number, payload: Buffer): string {
  return createHash("sha256")
    .update(JSON.stringify([context.conversationId, context.sessionId, toolCallId, entryIndex, edit.path, edit.action, !!edit.partial]))
    .update(payload).digest("hex");
}

function standaloneId(edit: FileEdit): string {
  return `standalone:${createHash("sha256").update(JSON.stringify(edit)).digest("hex")}`;
}

function replaceOutputs(item: Extract<AcpStreamItem, { kind: "tool-call" }>, toolOutputs: AcpStreamItem[]): AcpStreamItem {
  const references = toolOutputs.filter((output): output is FileEdit => output.kind === "file-edit");
  let referenceIndex = 0;
  const input = Array.isArray(item.input) ? item.input.map((entry) => {
    if (entry?.type !== "diff" || typeof entry.path !== "string" || !entry.path) return entry;
    const output = references[referenceIndex++];
    if (!output?.blobKey || output.path !== entry.path) return entry;
    return { type: "diff", path: output.path, blobKey: output.blobKey };
  }) : item.input;
  return { ...item, ...(input !== undefined ? { input } : {}), toolOutputs };
}

export function persistFileEditItems(
  context: { conversationId?: string; sessionId: string },
  items: AcpStreamItem[]
): AcpStreamItem[] {
  const { conversationId, sessionId } = context;
  if (!conversationId || !items.some(item => item.kind === "tool-call" || item.kind === "file-edit")) return items;
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId)) return items;
  return db.transaction(() => {
    const save = (edit: FileEdit, toolCallId: string, entryIndex: number, status: ToolCallStatus): FileEdit => {
      if (edit.blobKey || edit.truncated) return edit;
      if (edit.oldText === undefined && edit.newText === undefined && edit.patch === undefined) {
        const previous = db.prepare(
          `SELECT sequence, blob_key, path, action, partial FROM file_edit_blobs WHERE conversation_id = ? AND task_id = ?
           AND tool_call_id = ? AND entry_index = ? AND path = ? ORDER BY sequence DESC LIMIT 1`
        ).get(conversationId, sessionId, toolCallId, entryIndex, edit.path) as FileEditRow | undefined;
        if (previous) db.prepare("UPDATE file_edit_blobs SET active = 1 WHERE blob_key = ?").run(previous.blob_key);
        return previous ? reference(previous) : edit;
      }
      const payload = contentPayload(edit);
      const blobKey = contentKey({ conversationId, sessionId }, edit, toolCallId, entryIndex, payload);
      db.prepare(
        `UPDATE file_edit_blobs SET active = 0 WHERE conversation_id = ? AND task_id = ?
         AND tool_call_id = ? AND entry_index = ?`
      ).run(conversationId, sessionId, toolCallId, entryIndex);
      db.prepare(
        `INSERT INTO file_edit_blobs
         (blob_key, conversation_id, task_id, tool_call_id, entry_index, path, action, partial, status, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(blob_key) DO UPDATE SET active = 1, status = excluded.status`
      ).run(blobKey, conversationId, sessionId, toolCallId, entryIndex, edit.path, edit.action, edit.partial ? 1 : 0, status, payload);
      return { kind: "file-edit", path: edit.path, action: edit.action, blobKey, ...(edit.partial ? { partial: true } : {}) };
    };
    return items.map((item) => {
      if (item.kind === "file-edit") {
        return { ...save(item, standaloneId(item), 0, item.status ?? "completed"), ...(item.status ? { status: item.status } : {}) };
      }
      if (item.kind !== "tool-call" || !item.id) return item;
      const previous = db.prepare(
        `SELECT status FROM file_edit_blobs WHERE conversation_id = ? AND task_id = ?
         AND tool_call_id = ? ORDER BY sequence DESC LIMIT 1`
      ).get(conversationId, sessionId, item.id) as { status: ToolCallStatus } | undefined;
      const status = item.isError ? "failed" : item.status ?? previous?.status ?? "pending";
      db.prepare(
        `UPDATE file_edit_blobs SET status = ? WHERE conversation_id = ? AND task_id = ? AND tool_call_id = ?`
      ).run(status, conversationId, sessionId, item.id);
      if (!item.toolOutputs) return item;
      if (item.replaceToolOutputs) {
        db.prepare(
          `UPDATE file_edit_blobs SET active = 0 WHERE conversation_id = ? AND task_id = ? AND tool_call_id = ?`
        ).run(conversationId, sessionId, item.id);
      }
      const toolCallId = item.id;
      const toolOutputs = item.toolOutputs.map((output, index) =>
        output.kind === "file-edit" ? save(output, toolCallId, index, status) : output
      );
      return replaceOutputs(item, toolOutputs);
    });
  })();
}

export function restoreFileEditReferences(context: FileEditContext, items: AcpStreamItem[]): AcpStreamItem[] {
  const restore = (edit: FileEdit, toolCallId: string, entryIndex: number): FileEdit => {
    if (edit.blobKey || edit.truncated || (edit.oldText === undefined && edit.newText === undefined && edit.patch === undefined)) return edit;
    const blobKey = contentKey(context, edit, toolCallId, entryIndex, contentPayload(edit));
    const row = getDb().prepare(
      "SELECT sequence, blob_key, path, action, partial FROM file_edit_blobs WHERE conversation_id = ? AND task_id = ? AND blob_key = ?"
    ).get(context.conversationId, context.sessionId, blobKey) as FileEditRow | undefined;
    return row ? { ...reference(row), ...(edit.status ? { status: edit.status } : {}) } : edit;
  };
  return items.map(item => {
    if (item.kind === "file-edit") return restore(item, standaloneId(item), 0);
    if (item.kind !== "tool-call" || !item.id || !item.toolOutputs) return item;
    const toolCallId = item.id;
    return replaceOutputs(item, item.toolOutputs.map((output, index) =>
      output.kind === "file-edit" ? restore(output, toolCallId, index) : output
    ));
  });
}

export function readFileEditSnapshot(conversationId: string, blobKey: string, maxChars: number): (FileEditContent & { truncated?: boolean }) | undefined {
  if (typeof blobKey !== "string" || !/^[a-f0-9]{64}$/.test(blobKey) || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 16_000) {
    throw new Error("Invalid file edit snapshot query");
  }
  if (!requireOwnedConversation(conversationId)) throw new Error("Conversation not available");
  const row = getDb().prepare(
    `SELECT substr(json_extract(CAST(payload AS TEXT), '$.oldText'), 1, ?) AS oldText,
            substr(json_extract(CAST(payload AS TEXT), '$.newText'), 1, ?) AS newText,
            substr(json_extract(CAST(payload AS TEXT), '$.patch'), 1, ?) AS patch
     FROM file_edit_blobs WHERE conversation_id = ? AND blob_key = ?`
  ).get(maxChars + 1, maxChars + 1, maxChars + 1, conversationId, blobKey) as Record<keyof FileEditContent, string | null> | undefined;
  if (!row) return undefined;
  const content: FileEditContent & { truncated?: boolean } = {};
  for (const field of ["oldText", "newText", "patch"] as const) {
    const value = row[field];
    if (value === null) continue;
    content[field] = value.length > maxChars ? `${value.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "")}\n[truncated]` : value;
    if (value.length > maxChars) content.truncated = true;
  }
  return content;
}

export function listMessageFileEdits(messageId: string, cursor = 0): FileEditPage {
  if (typeof messageId !== "string" || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid file edit query");
  const db = getDb();
  const message = db.prepare("SELECT conversation_id, task_id FROM conversation_messages WHERE id = ?")
    .get(messageId) as { conversation_id: string; task_id: string | null } | undefined;
  if (!message || !requireOwnedConversation(message.conversation_id)) throw new Error("Message not available");
  const rows = db.prepare(
    `SELECT sequence, blob_key, path, action, partial FROM file_edit_blobs
     WHERE conversation_id = ? AND task_id = ? AND active = 1 AND status = 'completed'
     AND sequence > ? ORDER BY sequence LIMIT 101`
  ).all(message.conversation_id, message.task_id, cursor) as FileEditRow[];
  const page = rows.slice(0, 100);
  return { edits: page.map(reference), nextCursor: page.at(-1)?.sequence ?? cursor, hasMore: rows.length > page.length };
}

export function readFileEditBlob(conversationId: string, blobKey: string, offset = 0): FileEditBlobChunk | undefined {
  if (typeof conversationId !== "string" || typeof blobKey !== "string" || !/^[a-f0-9]{64}$/.test(blobKey)
    || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid file edit query");
  if (!requireOwnedConversation(conversationId)) throw new Error("Conversation not available");
  const row = getDb().prepare(
    `SELECT substr(payload, ?, 65536) AS chunk, length(payload) AS total_bytes
     FROM file_edit_blobs WHERE conversation_id = ? AND blob_key = ?`
  ).get(offset + 1, conversationId, blobKey) as { chunk: Buffer; total_bytes: number } | undefined;
  if (!row) return undefined;
  const nextOffset = Math.min(offset + row.chunk.length, row.total_bytes);
  return { data: row.chunk.toString("base64"), nextOffset, totalBytes: row.total_bytes, hasMore: nextOffset < row.total_bytes };
}

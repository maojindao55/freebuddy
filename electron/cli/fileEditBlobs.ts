import { createHash } from "node:crypto";
import { aggregateFileEdits, buildFileDiff } from "@freebuddy/cli-stream";
import type { FileEditBlobChunk, FileEditContent, FileEditPage, ToolCallStatus } from "@freebuddy/protocol";
import type { AcpStreamItem } from "./acp.js";
import { getDb } from "./db.js";
import { requireOwnedConversation } from "./conversations.js";
import { readFileEditLogVersions } from "./fileEditLogRecovery.js";
import { snapshotIndex, snapshotPathIdentity, snapshotPathIdentities, readSnapshotPair } from "./turnFileSnapshots.js";

type FileEdit = Extract<AcpStreamItem, { kind: "file-edit" }>;
type FileEditContext = { conversationId: string; sessionId: string };
interface FileEditRow {
  sequence: number;
  blob_key: string;
  path: string;
  action: FileEdit["action"];
  partial: number;
  counts: string | null;
  tool_call_id?: string;
}
type SnippetInput = { oldText: string; newText: string; recover: boolean };

function messageSnippetInputs(content: string): Map<string, SnippetInput> {
  const inputs = new Map<string, SnippetInput>();
  try {
    const items = JSON.parse(content);
    if (!Array.isArray(items)) return inputs;
    for (const item of items) {
      if (item?.kind !== "tool-call" || !item.id || item.status !== "completed" || item.isError ||
        typeof item.input?.old_string !== "string" || typeof item.input.new_string !== "string") continue;
      const text = [item.output, ...(item.toolOutputs ?? []).map((output: any) => output.text ?? output.content)]
        .filter(value => typeof value === "string").join("\n");
      inputs.set(item.id, { oldText: item.input.old_string, newText: item.input.new_string,
        recover: /Successfully edited file:/i.test(text) && !(item.toolOutputs ?? []).some((output: any) => output.kind === "file-edit") });
    }
  } catch { /* historical content may be unavailable */ }
  return inputs;
}

function turnSourcePredicate(recoverIds: string[]): string {
  if (!recoverIds.length) return "e.active = 1";
  // Old text-only completion notifications deactivated previews. Recover only
  // the latest entry confirmed successful by the persisted message; do not
  // reactivate old rows or resurrect failed/pending tools.
  return `(e.active = 1 OR (e.tool_call_id IN (${recoverIds.map(() => "?").join(",")}) AND NOT EXISTS (
    SELECT 1 FROM file_edit_blobs newer WHERE newer.conversation_id = e.conversation_id AND newer.task_id = e.task_id
    AND newer.tool_call_id = e.tool_call_id AND newer.entry_index = e.entry_index AND newer.sequence > e.sequence)))`;
}

function countsJson(edit: FileEdit): string {
  const diff = buildFileDiff(edit);
  return JSON.stringify(diff.notice ? null : { added: diff.added, removed: diff.removed });
}

function reference(row: FileEditRow): FileEdit {
  // Older blobs have no summary. Backfill once, without sending their body over IPC.
  if (row.counts === null) {
    const db = getDb();
    const content = db.prepare("SELECT payload FROM file_edit_blobs WHERE blob_key = ? AND length(payload) <= ?")
      .get(row.blob_key, 8 * 1024 * 1024) as { payload: Buffer } | undefined;
    row.counts = content ? countsJson({ kind: "file-edit", path: row.path, action: row.action,
      blobKey: row.blob_key, partial: !!row.partial, ...JSON.parse(content.payload.toString("utf8")) }) : "null";
    db.prepare("UPDATE file_edit_blobs SET counts = ? WHERE blob_key = ?").run(row.counts, row.blob_key);
  }
  const counts = JSON.parse(row.counts) as FileEdit["counts"] | null;
  return {
    kind: "file-edit", path: row.path, action: row.action, blobKey: row.blob_key,
    ...(counts ? { counts } : {}),
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
          `SELECT sequence, blob_key, path, action, partial, counts FROM file_edit_blobs WHERE conversation_id = ? AND task_id = ?
           AND tool_call_id = ? AND entry_index = ? AND path = ? ORDER BY sequence DESC LIMIT 1`
        ).get(conversationId, sessionId, toolCallId, entryIndex, edit.path) as FileEditRow | undefined;
        if (previous) db.prepare("UPDATE file_edit_blobs SET active = 1 WHERE blob_key = ?").run(previous.blob_key);
        return previous ? reference(previous) : edit;
      }
      const payload = contentPayload(edit);
      const blobKey = contentKey({ conversationId, sessionId }, edit, toolCallId, entryIndex, payload);
      const counts = countsJson({ ...edit, blobKey });
      db.prepare(
        `UPDATE file_edit_blobs SET active = 0 WHERE conversation_id = ? AND task_id = ?
         AND tool_call_id = ? AND entry_index = ?`
      ).run(conversationId, sessionId, toolCallId, entryIndex);
      db.prepare(
        `INSERT INTO file_edit_blobs
         (blob_key, conversation_id, task_id, tool_call_id, entry_index, path, action, partial, status, counts, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(blob_key) DO UPDATE SET active = 1, status = excluded.status, counts = excluded.counts`
      ).run(blobKey, conversationId, sessionId, toolCallId, entryIndex, edit.path, edit.action, edit.partial ? 1 : 0, status, counts, payload);
      return reference({ sequence: 0, blob_key: blobKey, path: edit.path, action: edit.action, partial: edit.partial ? 1 : 0, counts });
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
      if (status !== "failed" && item.toolOutputs.length && !item.toolOutputs.some(output => output.kind === "file-edit")) {
        // CodeBuddy/Claude send diff previews before permission, then only text
        // on progress/success. Keep previews until their execution status settles.
        const previousEdits = db.prepare(
          `SELECT sequence, blob_key, path, action, partial, counts FROM file_edit_blobs
           WHERE conversation_id = ? AND task_id = ? AND tool_call_id = ? AND active = 1 ORDER BY sequence`
        ).all(conversationId, sessionId, item.id) as FileEditRow[];
        if (previousEdits.length) return replaceOutputs(item, [...item.toolOutputs, ...previousEdits.map(reference)]);
      }
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

/** Copy a conversation's edit payloads into a fork. Blob keys embed the owning
 * conversation, so rows are re-keyed for the target; the old→new key map is
 * returned for rewriting the blobKey references inside copied messages. */
export function copyFileEditBlobsForFork(
  sourceConversationId: string,
  targetConversationId: string,
  taskIds: string[]
): Map<string, string> {
  const keyMap = new Map<string, string>();
  if (!taskIds.length) return keyMap;
  const db = getDb();
  const rows = db.prepare(
    `SELECT blob_key, task_id, tool_call_id, entry_index, path, action, partial,
            status, active, counts, payload
     FROM file_edit_blobs
     WHERE conversation_id = ? AND task_id IN (${taskIds.map(() => "?").join(",")})
     ORDER BY sequence ASC`
  ).all(sourceConversationId, ...taskIds) as Array<{
    blob_key: string;
    task_id: string;
    tool_call_id: string;
    entry_index: number;
    path: string;
    action: FileEdit["action"];
    partial: number;
    status: string;
    active: number;
    counts: string | null;
    payload: Buffer;
  }>;
  if (!rows.length) return keyMap;
  const insert = db.prepare(
    `INSERT INTO file_edit_blobs
       (blob_key, conversation_id, task_id, tool_call_id, entry_index, path,
        action, partial, status, active, counts, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(blob_key) DO NOTHING`
  );
  for (const row of rows) {
    const payload = Buffer.from(row.payload);
    const nextKey = contentKey(
      { conversationId: targetConversationId, sessionId: row.task_id },
      {
        kind: "file-edit",
        path: row.path,
        action: row.action,
        partial: !!row.partial
      },
      row.tool_call_id,
      row.entry_index,
      payload
    );
    insert.run(
      nextKey,
      targetConversationId,
      row.task_id,
      row.tool_call_id,
      row.entry_index,
      row.path,
      row.action,
      row.partial,
      row.status,
      row.active,
      row.counts,
      payload
    );
    keyMap.set(row.blob_key, nextKey);
  }
  return keyMap;
}

export function restoreFileEditReferences(context: FileEditContext, items: AcpStreamItem[]): AcpStreamItem[] {
  const restore = (edit: FileEdit, toolCallId: string, entryIndex: number): FileEdit => {
    if (edit.truncated || (edit.blobKey && edit.counts)) return edit;
    if (!edit.blobKey && edit.oldText === undefined && edit.newText === undefined && edit.patch === undefined) return edit;
    const blobKey = edit.blobKey ?? contentKey(context, edit, toolCallId, entryIndex, contentPayload(edit));
    const row = getDb().prepare(
      "SELECT sequence, blob_key, path, action, partial, counts FROM file_edit_blobs WHERE conversation_id = ? AND task_id = ? AND blob_key = ?"
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

type MessageEditContext = { id: string; conversation_id: string; task_id: string | null; status: string; content: string };
type TurnSourceRow = FileEditRow & { bytes: number };
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const turnCache = new Map<string, { messageId: string; conversationId: string; taskId: string; path: string; payload: Buffer }>();
let turnCacheBytes = 0;
let turnCacheDb: ReturnType<typeof getDb> | undefined;
type SnapshotEntries = Array<{ edit?: FileEdit; covered: string[] }>;
const indexCache = new Map<string, { entries: SnapshotEntries; capture: FileEditPage["capture"]; bytes: number }>();
let indexCacheBytes = 0;
let indexCacheDb: ReturnType<typeof getDb> | undefined;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
function snapshotPage(entries: SnapshotEntries, capture: FileEditPage["capture"], cursor: number): FileEditPage {
  const page = entries.slice(cursor, cursor + 100);
  return { edits: page.flatMap(entry => entry.edit ? [entry.edit] : []), coveredPaths: page.flatMap(entry => entry.covered),
    nextCursor: cursor + page.length, hasMore: cursor + page.length < entries.length, capture };
}

function messageEditContext(messageId: string): MessageEditContext {
  if (typeof messageId !== "string") throw new Error("Invalid file edit query");
  const message = getDb().prepare("SELECT id, conversation_id, task_id, status, content FROM conversation_messages WHERE id = ?")
    .get(messageId) as MessageEditContext | undefined;
  if (!message || !requireOwnedConversation(message.conversation_id)) throw new Error("Message not available");
  return message;
}

function turnSources(message: MessageEditContext, filePath: string, inputs: Map<string, SnippetInput>): TurnSourceRow[] {
  const recoverIds = [...inputs].filter(([, input]) => input.recover).map(([id]) => id);
  return getDb().prepare(`SELECT e.sequence, e.blob_key, e.path, e.action, e.partial, e.counts, e.tool_call_id, length(e.payload) AS bytes
    FROM file_edit_blobs e WHERE e.conversation_id = ? AND e.task_id = ? AND e.path = ? AND e.status = 'completed'
    AND ${turnSourcePredicate(recoverIds)} ORDER BY e.sequence`)
    .all(message.conversation_id, message.task_id, filePath, ...recoverIds) as TurnSourceRow[];
}

function turnSourceKey(message: MessageEditContext, filePath: string, rows: TurnSourceRow[], inputs: Map<string, SnippetInput>): string {
  return createHash("sha256").update(JSON.stringify(["turn-diff-v1", message.id, message.conversation_id, message.task_id, filePath,
    rows.map(row => [row.blob_key, inputs.get(row.tool_call_id ?? "")])])).digest("hex");
}

/** Group only metadata for cards. No payload reads, composition, or summary writes. */
export function listMessageFileEdits(messageId: string, cursor = 0, groupFiles = false): FileEditPage {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || typeof groupFiles !== "boolean") throw new Error("Invalid file edit query");
  const message = messageEditContext(messageId);
  const db = getDb();
  if (groupFiles) {
    if (message.status === "running" || message.status === "starting" || !message.task_id) return { edits: [], coveredPaths: [], nextCursor: cursor, hasMore: false };
    if (indexCacheDb !== db) { indexCache.clear(); indexCacheBytes = 0; indexCacheDb = db; }
    const run = db.prepare("SELECT state, sealed_at, overlapping FROM turn_file_capture_runs WHERE conversation_id = ? AND task_id = ?")
      .get(message.conversation_id, message.task_id) as { state: string; sealed_at: number | null; overlapping: number } | undefined;
    const indexKey = createHash("sha256").update(JSON.stringify([messageId, message.task_id, message.content, run])).digest("hex");
    const indexed = indexCache.get(indexKey);
    if (indexed) { indexCache.delete(indexKey); indexCache.set(indexKey, indexed); return snapshotPage(indexed.entries, indexed.capture, cursor); }
    const inputs = messageSnippetInputs(message.content);
    const recoverIds = [...inputs].filter(([, input]) => input.recover).map(([id]) => id);
    const snapshot = snapshotIndex(messageId, message.conversation_id, message.task_id);
    if (snapshot) {
      if (snapshot.capture.state === "finalizing") return { edits: [], coveredPaths: [], nextCursor: cursor, hasMore: false, capture: snapshot.capture };
      const records = db.prepare(`SELECT e.path, MIN(e.sequence) AS sequence FROM file_edit_blobs e
        WHERE e.conversation_id = ? AND e.task_id = ? AND e.status = 'completed' AND ${turnSourcePredicate(recoverIds)}
        GROUP BY e.path ORDER BY sequence`).all(message.conversation_id, message.task_id, ...recoverIds) as { path: string; sequence: number }[];
      const identities = (filePath: string) => snapshotPathIdentities(filePath, snapshot.roots);
      const entries: Array<{ edit?: FileEdit; covered: string[] }> = snapshot.edits.map(edit => ({ edit, covered: [edit.path] }));
      const byIdentity = new Map(entries.map(entry => [snapshotPathIdentity(entry.edit!.path), entry]));
      // Unchanged snapshots also suppress old inline records, without exposing bodies.
      for (const identity of snapshot.identities) if (!byIdentity.has(identity)) {
        const entry = { covered: [identity] };
        entries.push(entry);
        byIdentity.set(identity, entry);
      }
      for (const file of records) {
        const ids = identities(file.path);
        if (ids.some(id => snapshot.identities.has(id))) {
          const matching = ids.map(id => byIdentity.get(id)).find(Boolean);
          matching?.covered.push(file.path);
          continue;
        }
        const rows = turnSources(message, file.path, inputs);
        // An incomplete version pair yields to saved operation evidence for that path.
        const uncertain = ids.map(id => byIdentity.get(id)).find(Boolean);
        const record: FileEdit = { kind: "file-edit", path: file.path, source: "records",
          action: rows[0].action === "create" ? "create" : rows.at(-1)!.action === "delete" ? "delete" : "update",
          turnKey: turnSourceKey(message, file.path, rows, inputs) };
        const entry = uncertain ?? { covered: [file.path] };
        entry.edit = record;
        if (uncertain) entry.covered.push(file.path);
        else entries.push(entry);
        ids.forEach(id => byIdentity.set(id, entry));
      }
      // Inline histories may use a different case, slash style or relative path.
      const aliases = new Set<string>();
      const visit = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (["path", "file_path", "filePath", "TargetFile"].includes(key) && typeof child === "string") aliases.add(child);
          else if (child && typeof child === "object") visit(child);
        }
      };
      try { visit(JSON.parse(message.content)); } catch { /* historical text message */ }
      for (const alias of aliases) {
        const ids = identities(alias);
        const entry = ids.map(id => byIdentity.get(id)).find(Boolean);
        if (entry) entry.covered.push(alias);
      }
      const bytes = JSON.stringify(entries).length * 2;
      if (run?.sealed_at && bytes <= MAX_INDEX_BYTES) {
        while (indexCache.size && (indexCacheBytes + bytes > MAX_INDEX_BYTES || indexCache.size >= 32)) {
          const oldest = indexCache.keys().next().value!;
          indexCacheBytes -= indexCache.get(oldest)!.bytes;
          indexCache.delete(oldest);
        }
        indexCache.set(indexKey, { entries, capture: snapshot.capture, bytes });
        indexCacheBytes += bytes;
      }
      return snapshotPage(entries, snapshot.capture, cursor);
    }
    const files = db.prepare(`SELECT e.path, MIN(e.sequence) AS sequence FROM file_edit_blobs e
      WHERE e.conversation_id = ? AND e.task_id = ? AND e.status = 'completed' AND ${turnSourcePredicate(recoverIds)}
      GROUP BY e.path HAVING MIN(e.sequence) > ? ORDER BY sequence LIMIT 101`)
      .all(message.conversation_id, message.task_id, ...recoverIds, cursor) as { path: string; sequence: number }[];
    const page = files.slice(0, 100);
    const edits: FileEdit[] = page.map(file => {
      const rows = turnSources(message, file.path, inputs);
      return { kind: "file-edit", path: file.path,
        action: rows[0].action === "create" ? "create" : rows.at(-1)!.action === "delete" ? "delete" : "update",
        turnKey: turnSourceKey(message, file.path, rows, inputs), source: "records" };
    });
    return { edits, coveredPaths: page.map(file => file.path), nextCursor: page.at(-1)?.sequence ?? cursor, hasMore: files.length > page.length };
  }
  const rows = db.prepare(`SELECT sequence, blob_key, path, action, partial, counts FROM file_edit_blobs
    WHERE conversation_id = ? AND task_id = ? AND active = 1 AND status = 'completed'
    AND sequence > ? ORDER BY sequence LIMIT 101`).all(message.conversation_id, message.task_id, cursor) as FileEditRow[];
  const page = rows.slice(0, 100);
  return { edits: page.map(reference), nextCursor: page.at(-1)?.sequence ?? cursor, hasMore: rows.length > page.length };
}

/** Read the selected file's saved edits and calculate its turn diff only on demand. */
export function readMessageFileEdit(messageId: string, filePath: string, turnKey: string, offset = 0): FileEditBlobChunk | undefined {
  if (typeof filePath !== "string" || !filePath || typeof turnKey !== "string" || !/^[a-f0-9]{64}$/.test(turnKey) ||
    !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid file edit query");
  const message = messageEditContext(messageId);
  if (!message.task_id || message.status === "running" || message.status === "starting") return;
  const db = getDb();
  if (turnCacheDb !== db) { turnCache.clear(); turnCacheBytes = 0; turnCacheDb = db; }
  let cached = turnCache.get(turnKey);
  if (cached && (cached.messageId !== messageId || cached.conversationId !== message.conversation_id ||
    cached.taskId !== message.task_id || cached.path !== filePath)) return;
  if (!cached) {
    const snapshot = readSnapshotPair(messageId, message.conversation_id, message.task_id, filePath, turnKey);
    if (snapshot) cached = { messageId, conversationId: message.conversation_id, taskId: message.task_id, path: filePath, payload: Buffer.from(JSON.stringify(snapshot), "utf8") };
  }
  if (!cached) {
    const inputs = messageSnippetInputs(message.content);
    const rows = turnSources(message, filePath, inputs);
    if (!rows.length || turnSourceKey(message, filePath, rows, inputs) !== turnKey) return;
    let content: FileEditContent;
    if (rows.reduce((total, row) => total + row.bytes, 0) > MAX_CONTENT_BYTES) {
      return { data: "", nextOffset: 0, totalBytes: 0, hasMore: false, notice: "large" };
    }
    const task = db.prepare("SELECT adapter, log_path FROM cli_tasks WHERE id = ?").get(message.task_id) as
      { adapter: string; log_path: string | null } | undefined;
    const versions = task?.adapter === "claude-agent-acp" && task.log_path ? readFileEditLogVersions(task.log_path) : undefined;
    const capturedRows = rows.map(row => {
      const body = db.prepare("SELECT payload FROM file_edit_blobs WHERE blob_key = ?").get(row.blob_key) as { payload: Buffer };
      return { row, captured: JSON.parse(body.payload.toString("utf8")) as FileEditContent };
    });
    // Older ACP events saved multiple hunks for one file as full documents.
    // Scope recovery to entries from the same tool, never unrelated versions.
    const toolHunkCounts = new Map<string, number>();
    for (const { row, captured } of capturedRows) {
      if (row.tool_call_id && row.action === "update" && !captured.patch &&
        captured.oldText !== undefined && captured.newText !== undefined) {
        toolHunkCounts.set(row.tool_call_id, (toolHunkCounts.get(row.tool_call_id) ?? 0) + 1);
      }
    }
    const edits = capturedRows.map(({ row, captured }) => {
      const recovered = versions?.get(row.tool_call_id ?? "")?.find(({ source }) => source.path === row.path &&
        source.oldText === captured.oldText && source.newText === captured.newText && source.patch === captured.patch);
      if (recovered) return recovered.edit;
      const input = inputs.get(row.tool_call_id ?? "");
      const multipleHunks = row.action === "update" && (toolHunkCounts.get(row.tool_call_id ?? "") ?? 0) > 1 &&
        captured.oldText !== undefined && captured.newText !== undefined && !captured.patch;
      return { kind: "file-edit" as const, path: row.path, action: row.action, blobKey: row.blob_key, ...captured,
        partial: !!row.partial || multipleHunks || !!(input && input.oldText === captured.oldText && input.newText === captured.newText) };
    });
    if (edits.reduce((total, edit) => total + contentPayload(edit).length, 0) > MAX_CONTENT_BYTES) {
      return { data: "", nextOffset: 0, totalBytes: 0, hasMore: false, notice: "large" };
    }
    const summary = aggregateFileEdits(edits)[0];
    content = summary ? { source: "records", oldText: summary.oldText, newText: summary.newText, patch: summary.patch, action: summary.action, partial: !!summary.partial }
      : { source: "records", action: "update", oldText: "", newText: "", partial: false, unchanged: true };
    cached = { messageId, conversationId: message.conversation_id, taskId: message.task_id, path: filePath, payload: Buffer.from(JSON.stringify(content), "utf8") };
  }
  if (cached.payload.length > MAX_CONTENT_BYTES) return { data: "", nextOffset: 0, totalBytes: 0, hasMore: false, notice: "large" };
  if (!turnCache.has(turnKey)) {
    if (cached.payload.length <= MAX_CONTENT_BYTES) {
      while (turnCache.size && (turnCacheBytes + cached.payload.length > MAX_CONTENT_BYTES || turnCache.size >= 32)) {
        const oldest = turnCache.keys().next().value!;
        turnCacheBytes -= turnCache.get(oldest)!.payload.length;
        turnCache.delete(oldest);
      }
      turnCache.set(turnKey, cached);
      turnCacheBytes += cached.payload.length;
    }
  } else { turnCache.delete(turnKey); turnCache.set(turnKey, cached); }
  const chunk = cached.payload.subarray(offset, offset + 65536);
  const nextOffset = Math.min(offset + chunk.length, cached.payload.length);
  return { data: chunk.toString("base64"), nextOffset, totalBytes: cached.payload.length, hasMore: nextOffset < cached.payload.length };
}

/** Export bounded, independent text for a handoff; never export database keys. */
export function readTurnFileSnapshotForHandoff(messageId: string, maxChars: number): { edits: FileEdit[]; truncated: boolean } | undefined {
  const message = messageEditContext(messageId);
  if (!message.task_id || message.status === "running" || message.status === "starting") return;
  const snapshot = snapshotIndex(messageId, message.conversation_id, message.task_id);
  if (!snapshot || snapshot.capture.state === "finalizing") return;
  const edits: FileEdit[] = [];
  let remaining = Math.max(0, Math.min(maxChars, 64 * 1024));
  let truncated = false;
  for (const edit of snapshot.edits.slice(0, 100)) {
    const { turnKey, ...metadata } = edit;
    const sizes = getDb().prepare(`SELECT before_version, after_version FROM turn_file_versions WHERE task_id = ? AND identity = ?`)
      .get(message.task_id, snapshotPathIdentity(edit.path)) as { before_version: string; after_version: string };
    const bytes = (JSON.parse(sizes.before_version).bytes ?? 0) + (JSON.parse(sizes.after_version).bytes ?? 0);
    if (bytes > remaining || bytes > 16_000) {
      truncated = true;
      edits.push({ ...metadata, notice: "large", truncated: true });
      continue;
    }
    const content = readSnapshotPair(messageId, message.conversation_id, message.task_id, edit.path, turnKey!);
    if (content) {
      remaining -= (content.oldText?.length ?? 0) + (content.newText?.length ?? 0);
      edits.push({ ...metadata, ...content });
    } else { truncated = true; edits.push({ ...metadata, notice: "unavailable", truncated: true }); }
  }
  return { edits, truncated: truncated || snapshot.edits.length > 100 };
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

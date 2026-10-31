import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { serializeStreamItemsForPersist } from "@freebuddy/cli-stream";
import { localDiffFixture } from "./fixtures/agy-local-diff.mjs";
import { agyTurnChanges, agyTurnUpdate } from "./fixtures/agy-turn-diff.mjs";
import { codebuddyTurnUpdate } from "./fixtures/codebuddy-turn-diff.mjs";
import { claudeTurnBefore, claudeTurnAfter, claudeTurnUpdates } from "./fixtures/claude-turn-diff.mjs";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
const { persistFileEditItems, listMessageFileEdits, readMessageFileEdit, readFileEditBlob, restoreFileEditReferences, readFileEditSnapshot } = await import("../dist-electron/cli/fileEditBlobs.js");
const { readMessageDetails } = await import("../dist-electron/cli/messageDetails.js");
const { createHandoffTranscriptSnapshot, readHandoffTranscriptSnapshot } = await import("../dist-electron/shared/handoffTranscript.js");
const { acpUpdateToItems } = await import("../dist-electron/cli/acp.js");
const { importAgyLocalDiff, withoutInlineFileBodies } = await import("../dist-electron/cli/acpLocalDiff.js");
const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");

async function loadSource(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText.replaceAll('"@freebuddy/cli-stream"', JSON.stringify(new URL("../packages/cli-stream/dist/index.js", import.meta.url).href));
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const { sanitizeStreamItems } = await loadSource("../src/utils/streamMedia.ts");
const { collectFileEdits, buildFileDiff, mergeStoredFileEdits } = await loadSource("../src/utils/fileDiff.ts");
const { createFileEditContentLoader } = await loadSource("../src/services/cli/fileEditContent.ts");
const context = { conversationId: "conversation", sessionId: "run" };

function setup(testContext, filename = ":memory:") {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  migrate(db);
  setDbForTest(db);
  db.prepare(`INSERT INTO conversations (id, title, agent_id, agent_name, adapter, owner_id, created_at, updated_at)
    VALUES ('conversation', 'test', 'agent', 'Agent', 'devin-acp', 'alice', '0', '0')`).run();
  db.prepare(`INSERT INTO conversation_messages (id, conversation_id, role, status, content, task_id, created_at, updated_at)
    VALUES ('message', 'conversation', 'assistant', 'done', '[]', 'run', '0', '0')`).run();
  testContext.after(() => { setDbForTest(null); if (db.open) db.close(); });
  return db;
}

function update(content, status = "completed", toolCallId = "call") {
  return acpUpdateToItems({ sessionUpdate: "tool_call_update", toolCallId, status, ...(content === undefined ? {} : { content }) });
}

function persist(content, status, toolCallId) {
  return persistFileEditItems(context, update(content, status, toolCallId));
}

test("bounded AGY references persist full bodies before unlinking and load only on demand", { skip: !bindingAvailable }, async t => {
  setup(t);
  const newText = "# 中文文档🙂\\n\n".repeat(100000);
  const fixture = localDiffFixture(t, [{ type: "diff", path: "task.md", oldText: null, newText }]);
  assert.ok(Buffer.byteLength(JSON.stringify(fixture.update)) < 65536);
  const imported = importAgyLocalDiff(fixture.update, "agy-acp");
  assert.equal(imported.imported, true);
  const items = acpUpdateToItems(imported.update, context.sessionId, "agy-acp");
  const emitted = withoutInlineFileBodies(persistFileEditItems(context, items));
  imported.release();
  assert.equal(fs.existsSync(fixture.filename), false);
  assert.ok(Buffer.byteLength(JSON.stringify(emitted)) < 65536);
  assert.equal(JSON.stringify(emitted).includes(newText), false);
  const [reference] = collectFileEdits(emitted);
  assert.ok(reference.blobKey);
  assert.equal(reference.newText, undefined);
  assert.equal(listMessageFileEdits("message").edits[0].blobKey, reference.blobKey);
  let reads = 0;
  const load = createFileEditContentLoader(async (...args) => {
    reads++;
    const chunk = runAsCaller("alice", () => readFileEditBlob(...args));
    assert.ok(Buffer.from(chunk.data, "base64").length <= 65536);
    return chunk;
  });
  assert.equal(reads, 0);
  const loaded = await load(context.conversationId, reference.blobKey);
  assert.ok(reads > 1);
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.content.newText, newText);
});

test("stream and stored metadata include counts for every edit before any body is opened", { skip: !bindingAvailable }, testContext => {
  setup(testContext);
  const changes = [
    { type: "diff", path: "file.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" },
    { type: "diff", path: "file.ts", oldText: "c\n", newText: "e\n" },
    { type: "diff", path: "empty.ts", oldText: null, newText: "" },
    { type: "diff", path: "removed.ts", oldText: "one\ntwo\n", newText: null }
  ];
  const stream = collectFileEdits(persist(changes));
  assert.equal(stream.length, 4);
  assert.deepEqual(stream.map(edit => edit.counts), [
    { added: 2, removed: 1 }, { added: 1, removed: 1 }, { added: 0, removed: 0 }, { added: 0, removed: 2 }
  ]);
  const saved = collectFileEdits(JSON.parse(serializeStreamItemsForPersist(sanitizeStreamItems(persist(changes)))));
  assert.deepEqual(saved.map(edit => edit.counts), stream.map(edit => edit.counts));
  const page = runAsCaller("alice", () => listMessageFileEdits("message"));
  assert.deepEqual(page.edits.map(edit => edit.counts), stream.map(edit => edit.counts));
  assert.ok(page.edits.every(edit => edit.oldText === undefined && edit.newText === undefined && edit.patch === undefined));
});

test("legacy blob schema migrates and summaries are backfilled for indexes and restored references", { skip: !bindingAvailable }, testContext => {
  const db = setup(testContext);
  const refs = collectFileEdits(persist([
    { type: "diff", path: "first.ts", oldText: "before", newText: "after" },
    { type: "diff", path: "second.ts", oldText: "a\nb", newText: "a\nc\nd" }
  ]));
  const payloads = db.prepare("SELECT blob_key, payload FROM file_edit_blobs ORDER BY sequence").all();
  db.exec("ALTER TABLE file_edit_blobs DROP COLUMN counts");
  migrate(db);
  migrate(db);
  assert.equal(db.prepare("SELECT count(*) AS total FROM file_edit_blobs WHERE counts IS NULL").get().total, 2);
  const restored = restoreFileEditReferences(context, [{ ...refs[0], counts: undefined }]);
  assert.deepEqual(restored[0].counts, { added: 1, removed: 1 });
  const page = runAsCaller("alice", () => listMessageFileEdits("message"));
  assert.deepEqual(page.edits.map(edit => edit.counts), [{ added: 1, removed: 1 }, { added: 2, removed: 1 }]);
  assert.equal(db.prepare("SELECT count(*) AS total FROM file_edit_blobs WHERE counts IS NULL").get().total, 0);
  assert.deepEqual(db.prepare("SELECT blob_key, payload FROM file_edit_blobs ORDER BY sequence").all(), payloads);
  assert.deepEqual(listMessageFileEdits("message"), page);
});

test("unavailable summaries remain unknown rather than reporting zero", { skip: !bindingAvailable }, testContext => {
  const db = setup(testContext);
  const refs = collectFileEdits(persist([
    { type: "diff", path: "missing-baseline.ts", action: "update", newText: "after" },
    { type: "diff", path: "large.ts", oldText: "a\n".repeat(1500), newText: "b\n".repeat(1500) }
  ]));
  assert.ok(refs.every(edit => edit.counts === undefined));
  db.exec("UPDATE file_edit_blobs SET counts = NULL");
  const page = listMessageFileEdits("message");
  assert.ok(page.edits.every(edit => edit.counts === undefined));
  assert.ok(db.prepare("SELECT counts FROM file_edit_blobs").all().every(row => row.counts === "null"));
});

test("full ACP diffs survive sanitization, budget eviction, UTF-8 paging and database reopen", { skip: !bindingAvailable }, async testContext => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-diff-"));
  let db;
  let reopened;
  testContext.after(() => {
    setDbForTest(null);
    if (reopened?.open) reopened.close();
    if (db?.open) db.close();
    assert.equal(reopened?.open ?? false, false);
    assert.equal(db?.open ?? false, false);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, "diff.db");
  db = setup(testContext, filename);
  const baseline = 'const value = "中文🙂";\n'.repeat(1800);
  const oldText = baseline + 'const label = "[truncated] data:image/png;base64,AAAA";\n';
  const newText = baseline + 'const label = "updated";\n';
  const emitted = persist([{ type: "diff", path: "file.ts", oldText, newText }]);
  const [reference] = collectFileEdits(sanitizeStreamItems(emitted));
  assert.ok(reference.blobKey);
  assert.deepEqual(reference.counts, { added: 1, removed: 1 });
  assert.equal(reference.oldText, undefined);
  assert.equal(reference.truncated, false);
  assert.equal(JSON.stringify(emitted).includes(baseline), false);
  const snapshot = serializeStreamItemsForPersist([
    ...emitted,
    ...Array.from({ length: 40 }, (_, index) => ({ kind: "tool-call", id: `other-${index}`, tool: "read", output: "x".repeat(12000) }))
  ]);
  assert.equal(snapshot.includes(reference.blobKey), false);
  db.prepare("UPDATE conversation_messages SET content = ? WHERE id = 'message'").run(snapshot);
  setDbForTest(null);
  db.close();
  reopened = new Database(filename);
  reopened.pragma("foreign_keys = ON");
  setDbForTest(reopened);
  migrate(reopened);
  const page = runAsCaller("alice", () => listMessageFileEdits("message"));
  assert.equal(page.edits.length, 1);
  assert.deepEqual(page.edits[0].counts, { added: 1, removed: 1 });
  const merged = mergeStoredFileEdits(collectFileEdits(JSON.parse(snapshot)), page.edits);
  assert.equal(merged[0].blobKey, reference.blobKey);
  let calls = 0;
  const load = createFileEditContentLoader(async (...args) => {
    calls++;
    const chunk = runAsCaller("alice", () => readFileEditBlob(...args));
    assert.ok(Buffer.from(chunk.data, "base64").length <= 65536);
    return chunk;
  });
  const loaded = await load("conversation", reference.blobKey);
  assert.ok(calls > 1);
  assert.equal(loaded.status, "ready");
  assert.deepEqual(loaded.content, { oldText, newText });
  const diff = buildFileDiff({ ...reference, ...loaded.content });
  assert.equal(diff.notice, undefined);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  const previousCalls = calls;
  await load("conversation", reference.blobKey);
  assert.equal(calls, previousCalls);
});

test("multiple files and same-path entries have immutable revisions and replay deduplication", { skip: !bindingAvailable }, async testContext => {
  const db = setup(testContext);
  const changes = [
    { type: "diff", path: "same.ts", oldText: "one", newText: "two" },
    { type: "diff", path: "same.ts", oldText: "two", newText: "three" },
    { type: "diff", path: "another.ts", newText: "created" }
  ];
  const initial = collectFileEdits(persist(changes));
  assert.equal(new Set(initial.map(edit => edit.blobKey)).size, 3);
  persist(changes);
  assert.equal(db.prepare("SELECT count(*) AS count FROM file_edit_blobs").get().count, 3);
  const next = collectFileEdits(persist([{ ...changes[0], newText: "changed again" }]));
  assert.notEqual(next[0].blobKey, initial[0].blobKey);
  assert.deepEqual(listMessageFileEdits("message").edits.map(edit => edit.blobKey), [next[0].blobKey]);
  const load = createFileEditContentLoader(async (...args) => readFileEditBlob(...args));
  assert.equal((await load("conversation", initial[0].blobKey)).content.newText, "two");
  assert.equal((await load("conversation", next[0].blobKey)).content.newText, "changed again");
  persistFileEditItems({ ...context, sessionId: "another-run" }, update(changes));
  assert.equal(listMessageFileEdits("message").edits.length, 1);
});

test("status-only completion, failure and replacement update the independent index", { skip: !bindingAvailable }, testContext => {
  setup(testContext);
  const change = { type: "diff", path: "file.ts", oldText: "a", newText: "b" };
  persist([change], "in_progress");
  assert.equal(listMessageFileEdits("message").edits.length, 0);
  persist(undefined, "completed");
  assert.equal(listMessageFileEdits("message").edits.length, 1);
  persist(undefined, "failed");
  assert.equal(listMessageFileEdits("message").edits.length, 0);
  persist([change], "completed");
  persist([], "completed");
  assert.equal(listMessageFileEdits("message").edits.length, 0);
});

test("initial tool inputs carry references while empty, deleted and patch contents round-trip", { skip: !bindingAvailable }, async testContext => {
  setup(testContext);
  const contents = [
    { type: "diff", path: "empty.ts", newText: "" },
    { type: "diff", path: "deleted.ts", oldText: "removed" },
    { type: "diff", path: "patched.ts", patch: "@@ -1 +1 @@\n-before\n+after" }
  ];
  const content = [{ type: "content", content: { type: "text", text: "Updating files" } }, { type: "diff" }, ...contents];
  const items = acpUpdateToItems({
    sessionUpdate: "tool_call", toolCallId: "initial", status: "completed",
    rawInput: content,
    content
  });
  const [emitted] = persistFileEditItems(context, items);
  const references = collectFileEdits([emitted]);
  assert.equal(references.length, 3);
  assert.deepEqual(emitted.input.slice(2), references.map(edit => ({ type: "diff", path: edit.path, blobKey: edit.blobKey })));
  const load = createFileEditContentLoader(async (...args) => readFileEditBlob(...args));
  for (const [index, edit] of references.entries()) {
    const { type, path: filePath, ...content } = contents[index];
    assert.deepEqual((await load("conversation", edit.blobKey)).content, content);
  }
  assert.deepEqual(references.map(edit => edit.action), ["create", "delete", "update"]);
  assert.equal(listMessageFileEdits("message").edits.length, 3);
});

test("index paging, ownership and conversation deletion apply to full contents", { skip: !bindingAvailable }, testContext => {
  const db = setup(testContext);
  persist(Array.from({ length: 105 }, (_, index) => ({ type: "diff", path: `${index}.ts`, newText: "value" })));
  const first = runAsCaller("alice", () => listMessageFileEdits("message"));
  assert.equal(first.edits.length, 100);
  assert.equal(first.hasMore, true);
  const second = listMessageFileEdits("message", first.nextCursor);
  assert.equal(second.edits.length, 5);
  assert.equal(second.hasMore, false);
  const blobKey = first.edits[0].blobKey;
  assert.throws(() => runAsCaller("bob", () => listMessageFileEdits("message")), /not available/);
  assert.throws(() => runAsCaller("bob", () => readFileEditBlob("conversation", blobKey)), /not available/);
  db.prepare(`INSERT INTO conversations (id, title, agent_id, agent_name, adapter, owner_id, created_at, updated_at)
    VALUES ('other', 'test', 'agent', 'Agent', 'devin-acp', 'alice', '0', '0')`).run();
  assert.equal(readFileEditBlob("other", blobKey), undefined);
  assert.throws(() => readFileEditBlob("conversation", blobKey, -1), /Invalid/);
  db.prepare("DELETE FROM conversations WHERE id = 'conversation'").run();
  assert.equal(db.prepare("SELECT count(*) AS count FROM file_edit_blobs").get().count, 0);
});

test("a failed storage transaction preserves input and never publishes dangling references", { skip: !bindingAvailable }, testContext => {
  const db = setup(testContext);
  db.exec("CREATE TRIGGER fail_diff BEFORE INSERT ON file_edit_blobs BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  const items = update([{ type: "diff", path: "file.ts", oldText: "before", newText: "after" }]);
  const original = JSON.stringify(items);
  assert.throws(() => persistFileEditItems(context, items), /test failure/);
  assert.equal(JSON.stringify(items), original);
  assert.equal(listMessageFileEdits("message").edits.length, 0);
});

test("history detail replay reuses immutable references without duplicating edits or changing the index", { skip: !bindingAvailable }, async testContext => {
  const db = setup(testContext);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-diff-history-"));
  testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baseline = "unchanged line\n".repeat(1500);
  const changes = [
    { type: "diff", path: "same.md", oldText: baseline + "before", newText: baseline + "after" },
    { type: "diff", path: "same.md", oldText: "second before", newText: "second after" }
  ];
  const initial = collectFileEdits(persist(changes));
  const current = collectFileEdits(persist([{ ...changes[0], newText: baseline + "latest" }, changes[1]]));
  const legacy = { type: "diff", path: "same.md", oldText: "legacy before", newText: "legacy after" };
  const logPath = path.join(directory, "run.jsonl");
  fs.writeFileSync(logPath, [
    { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed", content: changes },
    { sessionUpdate: "tool_call_update", toolCallId: "legacy", status: "completed", content: [legacy] }
  ].map(update => JSON.stringify({ type: "stdout", content: JSON.stringify({ method: "session/update", params: { update } }) })).join("\n") + "\n");
  db.prepare(`INSERT INTO cli_tasks (id, agent_id, agent_name, adapter, status, prompt, log_path, owner_id, created_at, updated_at)
    VALUES ('run', 'agent', 'Agent', 'devin-acp', 'done', 'test', ?, 'alice', '0', '0')`).run(logPath);
  const before = db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all();
  const page = await runAsCaller("alice", () => readMessageDetails("message"));
  const restored = collectFileEdits(sanitizeStreamItems(page.items));
  assert.equal(restored[0].blobKey, initial[0].blobKey);
  assert.equal(restored[0].oldText, undefined);
  assert.equal(restored[0].truncated, false);
  const merged = mergeStoredFileEdits(restored, listMessageFileEdits("message").edits);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].oldText, legacy.oldText);
  assert.deepEqual(merged.slice(1).map(edit => edit.blobKey).sort(), current.map(edit => edit.blobKey).sort());
  assert.deepEqual(db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all(), before);
  const wrongRun = restoreFileEditReferences({ ...context, sessionId: "other" }, update(changes));
  assert.equal(collectFileEdits(wrongRun)[0].blobKey, undefined);
  await assert.rejects(runAsCaller("bob", () => readMessageDetails("message")), /not available/);
});

test("restored initial inputs and standalone changes reuse the same keys", { skip: !bindingAvailable }, testContext => {
  setup(testContext);
  const content = [{ type: "diff", path: "file.ts", oldText: "before", newText: "after" }];
  const items = acpUpdateToItems({
    sessionUpdate: "tool_call", toolCallId: "initial", status: "completed",
    rawInput: content,
    content
  });
  items.push({ kind: "file-edit", path: "another.ts", action: "create", newText: "standalone" });
  const saved = persistFileEditItems(context, items);
  assert.deepEqual(restoreFileEditReferences(context, items), saved);
  assert.equal(items[0].input[0].oldText, "before");
});

function loadTurn(edit, messageId = "message") {
  return createFileEditContentLoader(async (_conversationId, key, offset) => readMessageFileEdit(messageId, edit.path, key, offset))
    ("conversation", edit.turnKey);
}

function bodyQueries(db) {
  const queries = [];
  const prepare = db.prepare;
  db.prepare = function(sql) { queries.push(sql); return prepare.call(this, sql); };
  return () => queries.filter(sql => /SELECT payload|substr\(payload|json_extract/.test(sql));
}

test("legacy same-tool Markdown hunks compose without changing stored records", { skip: !bindingAvailable }, async t => {
  const db = setup(t);
  const changes = [
    { type: "diff", path: "docs/api.md", oldText: "| Home | Favorites | 3 |\n| Home | Stream | all |\n",
      newText: "| Home | Favorites | 5 |\n| Home | Stream | all |\n" },
    { type: "diff", path: "other.ts", oldText: "const count = 3;\n", newText: "const count = 5;\n" },
    { type: "diff", path: "docs/api.md", oldText: "| My | Favorites | 4 |\n| My | Likes | 4 |\n",
      newText: "| My | Favorites | 5 |\n| My | Likes | 5 |\n" }
  ];
  const items = update(changes);
  // Reproduce the metadata emitted before repeated ACP hunks were recognized.
  for (const output of items[0].toolOutputs) if (output.kind === "file-edit") delete output.partial;
  persistFileEditItems(context, items);
  const before = db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all();
  const reads = bodyQueries(db);
  const page = listMessageFileEdits("message", 0, true);
  assert.equal(reads().length, 0);
  const markdown = page.edits.find(edit => edit.path === "docs/api.md");
  const loaded = await loadTurn(markdown);
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.content.partial, true);
  const diff = buildFileDiff({ ...markdown, ...loaded.content });
  assert.equal(diff.notice, undefined);
  assert.deepEqual([diff.added, diff.removed], [3, 3]);
  assert.match(loaded.content.patch, /Home \| Favorites \| 5/);
  assert.match(loaded.content.patch, /My \| Likes \| 5/);
  const other = await loadTurn(page.edits.find(edit => edit.path === "other.ts"));
  assert.equal(other.content.partial, false);
  assert.equal(other.content.newText, "const count = 5;\n");
  assert.deepEqual(db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all(), before);
});

test("disconnected complete versions from different tools cannot be recovered as hunks", { skip: !bindingAvailable }, async t => {
  setup(t);
  persist([{ type: "diff", path: "docs/api.md", oldText: "# First\n", newText: "# Changed\n" }], "completed", "first");
  persist([{ type: "diff", path: "docs/api.md", oldText: "# Unrelated\n", newText: "# Other\n" }], "completed", "other");
  const [edit] = listMessageFileEdits("message", 0, true).edits;
  assert.equal(buildFileDiff({ ...edit, ...(await loadTurn(edit)).content }).notice, "missing");
});

test("a full version accompanied by a patch in one tool retains its document baseline", { skip: !bindingAvailable }, async t => {
  setup(t);
  persist([
    { type: "diff", path: "docs/api.md", oldText: "A\nB\n", newText: "A1\nB\n" },
    { type: "diff", path: "docs/api.md", patch: "@@ -1,2 +1,2 @@\n A1\n-B\n+B1\n" }
  ]);
  const [edit] = listMessageFileEdits("message", 0, true).edits;
  const { content } = await loadTurn(edit);
  assert.equal(content.partial, false);
  assert.deepEqual([content.oldText, content.newText], ["A\nB\n", "A1\nB1\n"]);
  assert.equal(buildFileDiff({ ...edit, ...content }).notice, undefined);
});

test("file indexes read no bodies or write summaries; selecting one file computes only its saved records", { skip: !bindingAvailable }, async t => {
  const db = setup(t);
  persist([{ type: "diff", path: "file.ts", oldText: "original\n", newText: "middle\nextra\n" }], "completed", "first");
  persist([{ type: "diff", path: "other.ts", newText: "created\n" }], "completed", "other");
  persist([{ type: "diff", path: "file.ts", oldText: "middle\nextra\n", newText: "final\n" }], "completed", "last");
  db.exec("UPDATE file_edit_blobs SET counts = NULL");
  const before = db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all();
  const reads = bodyQueries(db);
  const page = runAsCaller("alice", () => listMessageFileEdits("message", 0, true));
  assert.deepEqual(page.edits.map(edit => edit.path), ["file.ts", "other.ts"]);
  assert.equal(reads().length, 0);
  assert.ok(page.edits.every(edit => edit.turnKey && !edit.blobKey && !edit.counts && edit.oldText === undefined));
  assert.deepEqual(page.coveredPaths, ["file.ts", "other.ts"]);
  const loaded = await loadTurn(page.edits[0]);
  assert.deepEqual(loaded.content, { source: "records", oldText: "original\n", newText: "final\n", action: "update", partial: false });
  assert.equal(reads().length, 2);
  assert.deepEqual(db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all(), before);
  await loadTurn(page.edits[0]);
  assert.equal(reads().length, 2);
  assert.deepEqual(db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all(), before);
  const old = page.edits[0];
  persist([{ type: "diff", path: "file.ts", oldText: "middle\nextra\n", newText: "new final\n" }], "completed", "last");
  const next = listMessageFileEdits("message", 0, true).edits[0];
  assert.notEqual(next.turnKey, old.turnKey);
  assert.equal((await loadTurn(old)).content.newText, "final\n");
  assert.equal((await loadTurn(next)).content.newText, "new final\n");
});

test("reverts and transient files become unchanged only when opened; EOF changes and new empty files remain", { skip: !bindingAvailable }, async t => {
  setup(t);
  persist([{ type: "diff", path: "reverted.ts", oldText: "original", newText: "middle" }], "completed", "first");
  persist([{ type: "diff", path: "reverted.ts", oldText: "middle", newText: "original" }], "completed", "last");
  persist([{ type: "diff", path: "temporary.ts", newText: "created" }], "completed", "create");
  persist([{ type: "diff", path: "temporary.ts", oldText: "created", newText: null }], "completed", "delete");
  persist([{ type: "diff", path: "newline.ts", oldText: "same", newText: "same\n" },
    { type: "diff", path: "empty.ts", newText: "" }], "completed", "eof");
  const page = listMessageFileEdits("message", 0, true);
  assert.equal(page.edits.length, 4);
  assert.equal((await loadTurn(page.edits[0])).content.unchanged, true);
  assert.equal((await loadTurn(page.edits[1])).content.unchanged, true);
  assert.equal((await loadTurn(page.edits[2])).content.unchanged, undefined);
  assert.equal((await loadTurn(page.edits[3])).content.unchanged, undefined);
});

test("file index paging groups interleaved modifications without calculating their contents", { skip: !bindingAvailable }, t => {
  const db = setup(t);
  const initial = Array.from({ length: 105 }, (_, index) => ({ type: "diff", path: `${index}.ts`, oldText: "before", newText: "middle" }));
  persist(initial, "completed", "first");
  persist(initial.map(change => ({ ...change, oldText: "middle", newText: "final" })), "completed", "last");
  const reads = bodyQueries(db);
  const first = listMessageFileEdits("message", 0, true);
  const second = listMessageFileEdits("message", first.nextCursor, true);
  assert.equal(first.edits.length, 100);
  assert.equal(second.edits.length, 5);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.coveredPaths, ...second.coveredPaths]).size, 105);
  assert.equal(reads().length, 0);
});

test("turn reads enforce completion, file identity, source version, task scope and ownership, including cached reads", { skip: !bindingAvailable }, async t => {
  const db = setup(t);
  persist([{ type: "diff", path: "file.ts", oldText: "before", newText: "after" }]);
  persistFileEditItems({ ...context, sessionId: "other-run" }, update([{ type: "diff", path: "other.ts", newText: "other" }], "completed", "other"));
  const [edit] = listMessageFileEdits("message", 0, true).edits;
  assert.equal(readMessageFileEdit("message", "other.ts", edit.turnKey), undefined);
  assert.equal(readMessageFileEdit("message", edit.path, "a".repeat(64)), undefined);
  for (const status of ["starting", "running"]) {
    db.prepare("UPDATE conversation_messages SET status = ? WHERE id = 'message'").run(status);
    assert.equal(listMessageFileEdits("message", 0, true).edits.length, 0);
    assert.equal(readMessageFileEdit("message", edit.path, edit.turnKey), undefined);
  }
  db.exec("UPDATE conversation_messages SET status = 'done' WHERE id = 'message'");
  assert.equal((await loadTurn(edit)).status, "ready");
  assert.throws(() => runAsCaller("bob", () => readMessageFileEdit("message", edit.path, edit.turnKey)), /not available/);
  assert.throws(() => runAsCaller("bob", () => listMessageFileEdits("message", 0, true)), /not available/);
  assert.throws(() => readMessageFileEdit("message", edit.path, edit.turnKey, -1), /Invalid/);
  db.exec("UPDATE conversation_messages SET task_id = 'other-run' WHERE id = 'message'");
  assert.equal(readMessageFileEdit("message", edit.path, edit.turnKey), undefined);
  db.prepare("DELETE FROM conversations WHERE id = 'conversation'").run();
  assert.throws(() => readMessageFileEdit("message", edit.path, edit.turnKey), /not available/);
});

test("oversized selected files return a bounded size notice without reading their bodies", { skip: !bindingAvailable }, async t => {
  const db = setup(t);
  persist([{ type: "diff", path: "large.ts", newText: "small" }]);
  db.prepare("UPDATE file_edit_blobs SET payload = ?").run(Buffer.alloc(8 * 1024 * 1024 + 1));
  const [edit] = listMessageFileEdits("message", 0, true).edits;
  const reads = bodyQueries(db);
  assert.equal((await loadTurn(edit)).status, "large");
  assert.equal(reads().length, 0);
});

test("selected AGY stored patches cancel intermediate changes and retain original file line numbers", { skip: !bindingAvailable }, async t => {
  const db = setup(t);
  for (let index = 0; index < agyTurnChanges.length; index++) persist([agyTurnChanges[index]], "completed", `edit-${index}`);
  const before = db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all();
  const [edit] = listMessageFileEdits("message", 0, true).edits;
  const diff = buildFileDiff({ ...edit, ...(await loadTurn(edit)).content });
  assert.equal(diff.notice, undefined);
  assert.deepEqual([diff.added, diff.removed], [3, 3]);
  assert.deepEqual(diff.rows.filter(row => row.kind === "delete").map(row => row.oldLine), [1, 3, 7]);
  assert.deepEqual(db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all(), before);
});

test("new AGY, CodeBuddy and Claude events remain compatible with on-click composition", { skip: !bindingAvailable }, async t => {
  for (const adapter of ["agy", "codebuddy", "claude"]) {
    await t.test(adapter, async t => {
      setup(t);
      for (let index = 0; index < 3; index++) {
        const updates = adapter === "agy" ? [agyTurnUpdate(index)] : adapter === "codebuddy"
          ? [codebuddyTurnUpdate(index), codebuddyTurnUpdate(index, "completed")] : claudeTurnUpdates(index);
        for (const update of updates) persistFileEditItems(context, acpUpdateToItems(update));
      }
      const [edit] = listMessageFileEdits("message", 0, true).edits;
      assert.equal(edit.counts, undefined);
      const loaded = await loadTurn(edit);
      const diff = buildFileDiff({ ...edit, ...loaded.content });
      assert.equal(diff.notice, undefined);
      assert.deepEqual([diff.added, diff.removed], [3, 3]);
      if (adapter === "claude") assert.deepEqual([loaded.content.oldText, loaded.content.newText], [claudeTurnBefore, claudeTurnAfter]);
      if (adapter === "codebuddy") assert.equal(loaded.content.partial, true);
    });
  }
});

function legacyClaudeLog(t, db, indices = [0, 1, 2], transform = update => update) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-claude-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, "run.jsonl");
  const updates = indices.flatMap(index => claudeTurnUpdates(index));
  for (const update of updates) persistFileEditItems(context, acpUpdateToItems({ ...update, _meta: undefined }));
  fs.writeFileSync(logPath, updates.map(transform).map(update => JSON.stringify({ type: "stdout",
    content: JSON.stringify({ method: "session/update", params: { update } }) })).join("\n") + "\n");
  db.prepare(`INSERT INTO cli_tasks (id, agent_id, agent_name, adapter, status, prompt, log_path, owner_id, created_at, updated_at)
    VALUES ('run', 'agent', 'Agent', 'claude-agent-acp', 'done', 'test', ?, 'alice', '0', '0')`).run(logPath);
  return logPath;
}

test("Claude historical hunks, including synthetic EOF text, recover only on opening the selected file", { skip: !bindingAvailable }, async t => {
  for (const indices of [[0, 1, 2], [2]]) {
    await t.test(String(indices), async t => {
      const db = setup(t);
      const logPath = legacyClaudeLog(t, db, indices);
      const before = db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all();
      const [edit] = listMessageFileEdits("message", 0, true).edits;
      const { content } = await loadTurn(edit);
      assert.equal(content.newText, claudeTurnAfter);
      assert.equal(content.newText.includes("No newline at end of file"), false);
      const diff = buildFileDiff({ ...edit, ...content });
      assert.deepEqual([diff.added, diff.removed], [indices.length, indices.length]);
      if (indices.length === 3) assert.equal(content.oldText, claudeTurnBefore);
      fs.unlinkSync(logPath);
      assert.equal((await loadTurn(edit)).content.newText, claudeTurnAfter);
      assert.deepEqual(db.prepare("SELECT * FROM file_edit_blobs ORDER BY sequence").all(), before);
    });
  }
});

for (const mismatch of ["tool", "path", "body", "missing", "oversized"]) {
  test(`Claude log recovery cannot replace uncorroborated stored sources: ${mismatch}`, { skip: !bindingAvailable }, async t => {
    const db = setup(t);
    const logPath = legacyClaudeLog(t, db, [0, 1, 2], update => {
      const copy = structuredClone(update);
      if (mismatch === "tool") copy.toolCallId += "-unrelated";
      if (mismatch === "path" && copy._meta.claudeCode.toolResponse) copy._meta.claudeCode.toolResponse.filePath = "other.md";
      if (mismatch === "body" && copy._meta.claudeCode.toolResponse) copy.content[0].oldText += "different source";
      return copy;
    });
    if (mismatch === "missing") fs.unlinkSync(logPath);
    if (mismatch === "oversized") fs.truncateSync(logPath, 8 * 1024 * 1024 + 1);
    const [edit] = listMessageFileEdits("message", 0, true).edits;
    assert.equal(buildFileDiff({ ...edit, ...(await loadTurn(edit)).content }).notice, "missing");
  });
}

test("legacy CodeBuddy inactive previews recover on opening without reactivating original rows", { skip: !bindingAvailable }, async t => {
  const db = setup(t);
  const messages = [];
  for (let index = 0; index < 3; index++) {
    const [preview] = acpUpdateToItems(codebuddyTurnUpdate(index));
    preview.toolOutputs[0].partial = false;
    persistFileEditItems(context, [preview]);
    const [success] = acpUpdateToItems(codebuddyTurnUpdate(index, "completed"));
    messages.push({ ...preview, ...success });
  }
  db.exec("UPDATE file_edit_blobs SET active = 0, status = 'completed'");
  db.prepare("UPDATE conversation_messages SET content = ? WHERE id = 'message'").run(JSON.stringify(messages));
  const [edit] = listMessageFileEdits("message", 0, true).edits;
  const { content } = await loadTurn(edit);
  const diff = buildFileDiff({ ...edit, ...content });
  assert.equal(content.partial, true);
  assert.equal(diff.notice, undefined);
  assert.deepEqual([diff.added, diff.removed], [3, 3]);
  assert.equal(db.prepare("SELECT count(*) AS total FROM file_edit_blobs WHERE active = 1").get().total, 0);
});

test("handoff snapshots contain bounded owned diff text and survive deletion of the source", { skip: !bindingAvailable }, testContext => {
  const db = setup(testContext);
  const [edit] = collectFileEdits(persist([{ type: "diff", path: "file.ts", oldText: "before", newText: "after marker data:image/png;base64,AAAA" }]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-diff-snapshot-"));
  testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const message = { id: "message", conversationId: "conversation", role: "assistant", status: "done", content: JSON.stringify([{ kind: "tool-call", toolOutputs: [edit] }]), createdAt: "0" };
  const original = message.content;
  const snapshot = runAsCaller("alice", () => createHandoffTranscriptSnapshot(directory, "share", [message], readFileEditSnapshot));
  const [loaded] = readHandoffTranscriptSnapshot(directory, snapshot);
  assert.equal(loaded.content[0].toolOutputs[0].oldText, "before");
  assert.match(loaded.content[0].toolOutputs[0].newText, /after marker/);
  assert.equal(JSON.stringify(loaded).includes("AAAA"), false);
  assert.equal(loaded.content[0].toolOutputs[0].blobKey, undefined);
  assert.equal(message.content, original);
  assert.equal(snapshot.truncated, false);
  assert.throws(() => runAsCaller("bob", () => readFileEditSnapshot("conversation", edit.blobKey, 16_000)), /not available/);
  db.prepare(`INSERT INTO conversations (id, title, agent_id, agent_name, adapter, owner_id, created_at, updated_at)
    VALUES ('other', 'test', 'agent', 'Agent', 'devin-acp', 'alice', '0', '0')`).run();
  assert.equal(readFileEditSnapshot("other", edit.blobKey, 16_000), undefined);
  const [large] = collectFileEdits(persist([{ type: "diff", path: "large.ts", newText: "🙂".repeat(50_000) }], "completed", "large"));
  const excerpt = readFileEditSnapshot("conversation", large.blobKey, 101);
  assert.equal(excerpt.truncated, true);
  assert.equal(excerpt.newText, "🙂".repeat(50) + "\n[truncated]");
  db.prepare("DELETE FROM conversations WHERE id = 'conversation'").run();
  assert.deepEqual(readHandoffTranscriptSnapshot(directory, snapshot), [loaded]);
});

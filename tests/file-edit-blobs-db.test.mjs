import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { serializeStreamItemsForPersist } from "@freebuddy/cli-stream";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
const { persistFileEditItems, listMessageFileEdits, readFileEditBlob, restoreFileEditReferences, readFileEditSnapshot } = await import("../dist-electron/cli/fileEditBlobs.js");
const { readMessageDetails } = await import("../dist-electron/cli/messageDetails.js");
const { createHandoffTranscriptSnapshot, readHandoffTranscriptSnapshot } = await import("../dist-electron/shared/handoffTranscript.js");
const { acpUpdateToItems } = await import("../dist-electron/cli/acp.js");
const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");

async function loadSource(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
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

test("full ACP diffs survive sanitization, budget eviction, UTF-8 paging and database reopen", { skip: !bindingAvailable }, async testContext => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-diff-"));
  testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "diff.db");
  const db = setup(testContext, filename);
  const baseline = 'const value = "中文🙂";\n'.repeat(1800);
  const oldText = baseline + 'const label = "[truncated] data:image/png;base64,AAAA";\n';
  const newText = baseline + 'const label = "updated";\n';
  const emitted = persist([{ type: "diff", path: "file.ts", oldText, newText }]);
  const [reference] = collectFileEdits(sanitizeStreamItems(emitted));
  assert.ok(reference.blobKey);
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
  const reopened = new Database(filename);
  testContext.after(() => reopened.close());
  reopened.pragma("foreign_keys = ON");
  setDbForTest(reopened);
  migrate(reopened);
  const page = runAsCaller("alice", () => listMessageFileEdits("message"));
  assert.equal(page.edits.length, 1);
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
  const items = acpUpdateToItems({
    sessionUpdate: "tool_call", toolCallId: "initial", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Updating files" } }, { type: "diff" }, ...contents]
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
  const items = acpUpdateToItems({
    sessionUpdate: "tool_call", toolCallId: "initial", status: "completed",
    content: [{ type: "diff", path: "file.ts", oldText: "before", newText: "after" }]
  });
  items.push({ kind: "file-edit", path: "another.ts", action: "create", newText: "standalone" });
  const saved = persistFileEditItems(context, items);
  assert.deepEqual(restoreFileEditReferences(context, items), saved);
  assert.equal(items[0].input[0].oldText, "before");
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

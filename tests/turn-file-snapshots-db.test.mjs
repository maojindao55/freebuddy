import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildFileDiff } from "@freebuddy/cli-stream";

let Database;
let bindingAvailable = true;
try { Database = (await import("better-sqlite3")).default; new Database(":memory:").close(); }
catch { bindingAvailable = false; }
const { migrate, setDbForTest, recoverInterruptedFileCaptures } = await import("../dist-electron/cli/db.js");
const { prepareTurnFileCapture, finalizeTurnFileCapture, snapshotPathIdentity } = await import("../dist-electron/cli/turnFileSnapshots.js");
const { persistFileEditItems, listMessageFileEdits, readMessageFileEdit, readTurnFileSnapshotForHandoff } = await import("../dist-electron/cli/fileEditBlobs.js");
const { createHandoffTranscriptSnapshot, readHandoffTranscriptSnapshot } = await import("../dist-electron/shared/handoffTranscript.js");
const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");

function setup(t, filename = ":memory:") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-file-versions-"));
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  migrate(db);
  setDbForTest(db);
  db.prepare(`INSERT INTO conversations(id, title, agent_id, agent_name, adapter, owner_id, created_at, updated_at)
    VALUES ('conversation', 'test', 'agent', 'Agent', 'qoder-acp', 'alice', '0', '0')`).run();
  message(db, "run", "message");
  t.after(() => { setDbForTest(null); if (db.open) db.close(); cleanWorkspace(root); });
  return { root, db, file: name => path.join(root, name), prepare: (limits, taskId = "run", roots = [root]) =>
    runAsCaller("alice", () => prepareTurnFileCapture({ conversationId: "conversation", taskId, roots, limits: { milliseconds: 10000, ...limits } })) };
}
function cleanWorkspace(root) {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("freebuddy-file-versions-"));
  const writableFiles = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) writableFiles(file);
      else fs.chmodSync(file, 0o666); // Git objects are read-only on Windows.
    }
  };
  writableFiles(resolved);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
function message(db, taskId, id) {
  db.prepare(`INSERT INTO conversation_messages(id, conversation_id, role, status, content, task_id, created_at, updated_at)
    VALUES (?, 'conversation', 'assistant', 'done', '[]', ?, '0', '0')`).run(id, taskId);
}
function index(id = "message") {
  const edits = [], coveredPaths = [];
  let cursor = 0, page;
  do {
    page = runAsCaller("alice", () => listMessageFileEdits(id, cursor, true));
    edits.push(...page.edits); coveredPaths.push(...page.coveredPaths);
    assert.ok(!page.hasMore || page.nextCursor > cursor);
    cursor = page.nextCursor;
  } while (page.hasMore);
  return { edits, coveredPaths, capture: page.capture };
}
function read(edit, id = "message") {
  let offset = 0, body = "", page;
  do {
    page = runAsCaller("alice", () => readMessageFileEdit(id, edit.path, edit.turnKey, offset));
    assert.ok(page);
    assert.ok(Buffer.from(page.data, "base64").length <= 65536);
    body += Buffer.from(page.data, "base64").toString("utf8"); offset = page.nextOffset;
  } while (page.hasMore);
  return JSON.parse(body);
}
const saved = (t, fn) => test(t, { skip: !bindingAvailable }, fn);

saved("failed batch persistence preserves sealed pairs and releases unsealed baselines", async t => {
  const env = setup(t);
  for (let index = 0; index < 35; index++) fs.writeFileSync(env.file(`${String(index).padStart(2, "0")}.md`), `before ${index}\n`);
  const capture = await env.prepare();
  fs.writeFileSync(env.file("00.md"), "after 0\n"); fs.writeFileSync(env.file("34.md"), "after 34\n");
  const prepare = env.db.prepare.bind(env.db);
  let writes = 0;
  env.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes("INSERT INTO turn_file_versions") && sql.includes("after_version")) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { if (++writes === 33) throw new Error("fixture batch write failed"); return run(...args); };
    }
    return statement;
  };
  try { await finalizeTurnFileCapture(capture); }
  finally { env.db.prepare = prepare; }
  const run = env.db.prepare("SELECT state, complete, reason FROM turn_file_capture_runs WHERE task_id = 'run'").get();
  assert.equal(run.state, "incomplete"); assert.equal(run.complete, 0); assert.match(run.reason, /fixture batch write failed/);
  const unsealed = env.db.prepare("SELECT before_blob FROM turn_file_versions WHERE task_id = 'run' AND after_version IS NULL").all();
  assert.equal(unsealed.length, 3); assert.ok(unsealed.every(row => row.before_blob === null));
  const page = index(); assert.equal(page.edits.length, 1); assert.equal(path.basename(page.edits[0].path), "00.md");
  assert.equal(read(page.edits[0]).oldText, "before 0\n"); assert.equal(read(page.edits[0]).newText, "after 0\n");
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM file_version_blobs").get().n, 2);
});

for (const gitProject of [false, true]) saved(`new files in existing empty directories retain a complete creation baseline (${gitProject ? "Git" : "non-Git"})`, async t => {
  const env = setup(t);
  if (gitProject) execFileSync("git", ["init", "--quiet"], { cwd: env.root, windowsHide: true });
  fs.mkdirSync(env.file("src/generated"), { recursive: true });
  const capture = await env.prepare();
  fs.writeFileSync(env.file("src/new.md"), "# new document\n");
  fs.writeFileSync(env.file("src/generated/empty.md"), "");
  await finalizeTurnFileCapture(capture);
  const page = index();
  assert.equal(page.capture.complete, true);
  assert.deepEqual(page.edits.map(edit => [path.basename(edit.path), edit.action]), [["empty.md", "create"], ["new.md", "create"]]);
  for (const edit of page.edits) {
    const content = read(edit);
    assert.equal(content.oldText, "");
    assert.equal(content.newText, edit.path.endsWith("new.md") ? "# new document\n" : "");
    assert.equal(content.notice, undefined);
  }
});

saved("saved workspace aliases deduplicate changes, deletions and reverts after the symlink disappears", async t => {
  const env = setup(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-other-worktree-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const alias = path.join(directory, "workspace");
  fs.symlinkSync(env.root, alias, process.platform === "win32" ? "junction" : "dir");
  for (const name of ["changed.md", "deleted.md", "reverted.md"]) fs.writeFileSync(env.file(name), "before\n");
  const capture = await env.prepare(undefined, "run", [env.root, alias]);
  fs.writeFileSync(env.file("changed.md"), "after\n");
  fs.unlinkSync(env.file("deleted.md"));
  persistFileEditItems({ conversationId: "conversation", sessionId: "run" }, [
    { kind: "file-edit", path: path.join(alias, "changed.md"), action: "update", status: "completed", oldText: "before\n", newText: "after\n" },
    { kind: "file-edit", path: path.join(alias, "deleted.md"), action: "delete", status: "completed", oldText: "before\n" },
    { kind: "file-edit", path: path.join(alias, "reverted.md"), action: "update", status: "completed", oldText: "before\n", newText: "temporary\n" },
    { kind: "file-edit", path: path.join(alias, "reverted.md"), action: "update", status: "completed", oldText: "temporary\n", newText: "before\n" }
  ]);
  await finalizeTurnFileCapture(capture);
  fs.unlinkSync(alias);
  const page = index();
  assert.equal(page.capture.complete, true);
  assert.deepEqual(page.edits.map(edit => [path.basename(edit.path), edit.source, edit.action]), [["changed.md", "snapshot", "update"], ["deleted.md", "snapshot", "delete"]]);
  for (const name of ["changed.md", "deleted.md", "reverted.md"]) assert.ok(page.coveredPaths.includes(path.join(alias, name)));
  assert.equal(read(page.edits[0]).newText, "after\n");
  assert.equal(read(page.edits[1]).newText, "");
  // Force a fresh metadata index: historical identity cannot depend on realpath.
  env.db.prepare("UPDATE conversation_messages SET content = ? WHERE id = 'message'").run(JSON.stringify([{ kind: "text", content: "saved history" }]));
  assert.deepEqual(index().edits, page.edits);
});

for (const phase of ["before", "after", "ignore"]) saved(`special files cannot block ${phase === "ignore" ? "ignore scanning" : `${phase}-turn capture`}`, t => {
  if (process.platform === "win32") { t.skip("POSIX FIFO"); return; }
  const env = setup(t);
  const result = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/turn-file-snapshots-special-files.mjs", import.meta.url)), env.root, phase], {
    timeout: 5000, killSignal: "SIGKILL", encoding: "utf8", env: process.env, windowsHide: true
  });
  assert.deepEqual(JSON.parse(result), { state: "incomplete", complete: false });
});

saved("three disjoint direct writes use real lines 3/5/7 and freeze historical versions", async t => {
  const env = setup(t);
  const before = "# 测试文档\n\n第一行：内容已更改。\n\n第二行：这是第二次追加的内容。\n\n新增行：这是新添加的一行。\n";
  fs.writeFileSync(env.file("test.md"), before);
  const capture = await env.prepare();
  let after = before.replace("第一行：内容已更改。", "第一行：第一次修改完成（1/3）。");
  fs.writeFileSync(env.file("test.md"), after);
  after = after.replace("第二行：这是第二次追加的内容。", "第二行：第二次修改完成（2/3）。");
  fs.writeFileSync(env.file("test.md"), after);
  after = after.replace("新增行：这是新添加的一行。", "新增行：第三次修改完成（3/3）。");
  fs.writeFileSync(env.file("test.md"), after);
  await finalizeTurnFileCapture(capture);
  const [edit] = index().edits;
  assert.equal(edit.source, "snapshot");
  assert.equal(edit.oldText, undefined);
  const content = read(edit);
  assert.equal(content.oldText, before); assert.equal(content.newText, after); assert.equal(content.partial, false);
  const diff = buildFileDiff({ ...edit, ...content });
  assert.deepEqual(diff.rows.filter(row => row.kind === "delete").map(row => row.oldLine), [3, 5, 7]);
  assert.deepEqual(diff.rows.filter(row => row.kind === "add").map(row => row.newLine), [3, 5, 7]);
  assert.equal(diff.added, 3); assert.equal(diff.removed, 3);
  // The next turn and today's file cannot rewrite this frozen pair.
  message(env.db, "next", "next-message");
  const next = await env.prepare(undefined, "next");
  fs.writeFileSync(env.file("test.md"), "later version");
  await finalizeTurnFileCapture(next);
  assert.equal(read(edit).newText, after);
  assert.equal(read(index("next-message").edits[0], "next-message").oldText, after);
});

saved("net-zero edits and transient files are excluded before indexing; empty creation and deletion survive", async t => {
  const env = setup(t);
  fs.writeFileSync(env.file("revert.md"), "original");
  fs.writeFileSync(env.file("deleted.md"), "");
  fs.writeFileSync(env.file("recreated.md"), "same");
  const capture = await env.prepare();
  fs.writeFileSync(env.file("revert.md"), "temporary"); fs.writeFileSync(env.file("revert.md"), "original");
  fs.writeFileSync(env.file("transient.md"), "temporary"); fs.unlinkSync(env.file("transient.md"));
  fs.writeFileSync(env.file("empty.md"), ""); fs.unlinkSync(env.file("deleted.md"));
  fs.unlinkSync(env.file("recreated.md")); fs.writeFileSync(env.file("recreated.md"), "same");
  persistFileEditItems({ conversationId: "conversation", sessionId: "run" }, [{ kind: "file-edit", path: "revert.md", action: "update", status: "completed", oldText: "original", newText: "temporary" }]);
  await finalizeTurnFileCapture(capture);
  const page = index();
  assert.deepEqual(page.edits.map(edit => [path.basename(edit.path), edit.action]), [["deleted.md", "delete"], ["empty.md", "create"]]);
  assert.ok(page.coveredPaths.includes("revert.md"));
  for (const edit of page.edits) { assert.equal(read(edit).oldText, ""); assert.equal(read(edit).newText, ""); }
  assert.equal(page.capture.complete, true);
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM file_version_blobs").get().n, 1);
});

saved("dirty Git and nonignored untracked files compare working files, not the index", async t => {
  const env = setup(t);
  execFileSync("git", ["init", "--quiet"], { cwd: env.root, windowsHide: true });
  fs.writeFileSync(env.file("tracked.md"), "index"); execFileSync("git", ["add", "tracked.md"], { cwd: env.root, windowsHide: true });
  fs.writeFileSync(env.file("tracked.md"), "dirty baseline");
  fs.writeFileSync(env.file("untracked.md"), "untracked baseline");
  fs.writeFileSync(env.file(".gitignore"), "ignored/\n"); fs.mkdirSync(env.file("ignored")); fs.writeFileSync(env.file("ignored/hidden.md"), "secret");
  const beforeIndex = fs.readFileSync(env.file(".git/index"));
  const capture = await env.prepare();
  fs.writeFileSync(env.file("tracked.md"), "final"); fs.writeFileSync(env.file("untracked.md"), "final");
  fs.writeFileSync(env.file("ignored/hidden.md"), "changed outside capture");
  await finalizeTurnFileCapture(capture);
  const edits = index().edits;
  assert.equal(edits.length, 2);
  assert.equal(read(edits.find(edit => edit.path.endsWith("tracked.md") && !edit.path.endsWith("untracked.md"))).oldText, "dirty baseline");
  assert.equal(read(edits.find(edit => edit.path.endsWith("untracked.md"))).oldText, "untracked baseline");
  assert.deepEqual(fs.readFileSync(env.file(".git/index")), beforeIndex);
});

saved("non-Git nested ignores and dependency exclusion do not fabricate baselines", async t => {
  const env = setup(t);
  fs.writeFileSync(env.file(".gitignore"), "ignored.md\n"); fs.writeFileSync(env.file("ignored.md"), "original");
  fs.mkdirSync(env.file("node_modules")); fs.writeFileSync(env.file("node_modules/dependency"), "original");
  fs.mkdirSync(env.file("nested")); fs.writeFileSync(env.file("nested/.gitignore"), "local.md\n"); fs.writeFileSync(env.file("nested/local.md"), "original");
  const capture = await env.prepare();
  fs.writeFileSync(env.file("shell.md"), "created by shell");
  fs.writeFileSync(env.file("ignored.md"), "changed"); fs.writeFileSync(env.file("nested/local.md"), "changed");
  await finalizeTurnFileCapture(capture);
  assert.deepEqual(index().edits.map(edit => path.basename(edit.path)), ["shell.md"]);
  assert.equal(read(index().edits[0]).oldText, "");
});

for (const phase of ["both", "before", "after"]) saved(`read-only turns with exhausted ${phase} body budgets do not list unknown files as changes`, async t => {
  const env = setup(t);
  for (let i = 0; i < 40; i++) fs.writeFileSync(env.file(`${i}.ts`), "unchanged contents\n");
  const capture = await env.prepare({ totalBytes: phase === "after" ? 64 * 1024 : 0 });
  capture.limits.totalBytes = phase === "before" ? 64 * 1024 : 0;
  await finalizeTurnFileCapture(capture);
  const page = index();
  assert.equal(page.capture.complete, false);
  assert.deepEqual(page.edits, []);
  assert.deepEqual(page.coveredPaths, []); // Unknown is not evidence of an unchanged file either.
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM turn_file_versions WHERE changed = 1").get().n, 0);
});

saved("read-only turns with an ending scan timeout do not list captured baselines as changes", async t => {
  const env = setup(t);
  fs.writeFileSync(env.file("file.ts"), "unchanged contents");
  const capture = await env.prepare();
  assert.equal(capture.complete, true);
  capture.limits.milliseconds = 0;
  await finalizeTurnFileCapture(capture);
  const page = index();
  assert.equal(page.capture.complete, false);
  assert.deepEqual(page.edits, []);
  assert.deepEqual(page.coveredPaths, []);
});

saved("historical captures cannot expose unknown pairs marked changed by older versions", async t => {
  const env = setup(t);
  fs.writeFileSync(env.file("file.ts"), "unchanged contents");
  const capture = await env.prepare({ totalBytes: 0 });
  await finalizeTurnFileCapture(capture);
  env.db.prepare("UPDATE turn_file_versions SET changed = 1 WHERE task_id = 'run'").run();
  const page = index();
  assert.deepEqual(page.edits, []);
  assert.deepEqual(page.coveredPaths, []);
});

saved("incomplete enumeration cannot assert changes for newly discovered files", async t => {
  const env = setup(t);
  fs.writeFileSync(env.file("existing.md"), "before");
  const capture = await env.prepare({ entries: 0 });
  capture.limits.entries = 50_000;
  fs.writeFileSync(env.file("new.md"), "after");
  await finalizeTurnFileCapture(capture);
  const page = index();
  assert.equal(page.capture.complete, false);
  assert.deepEqual(page.edits, []);
  assert.deepEqual(page.coveredPaths, []);
  const versions = env.db.prepare("SELECT before_version FROM turn_file_versions WHERE task_id = 'run'").all();
  assert.equal(versions.length, 2);
  assert.ok(versions.every(row => JSON.parse(row.before_version).state === "unavailable"));
});

saved("changing ignore rules cannot turn an existing ignored file into a new file", async t => {
  const env = setup(t);
  fs.writeFileSync(env.file(".gitignore"), "hidden.md\n"); fs.writeFileSync(env.file("hidden.md"), "existing ignored contents");
  const capture = await env.prepare();
  fs.writeFileSync(env.file(".gitignore"), ""); fs.writeFileSync(env.file("hidden.md"), "modified");
  await finalizeTurnFileCapture(capture);
  const page = index();
  assert.equal(page.capture.complete, false);
  assert.deepEqual(page.edits.map(edit => path.basename(edit.path)), [".gitignore"]);
  assert.equal(page.coveredPaths.includes(env.file("hidden.md")), false);
});

saved("binary and body budgets report unknown counts; unchanged binary hashes can be omitted", async t => {
  const env = setup(t);
  fs.writeFileSync(env.file("binary"), Buffer.from([0, 1])); fs.writeFileSync(env.file("same-binary"), Buffer.from([0, 2]));
  fs.writeFileSync(env.file("large"), "x".repeat(80));
  fs.writeFileSync(env.file("same-large"), "x".repeat(80));
  const capture = await env.prepare({ fileBytes: 32 });
  fs.writeFileSync(env.file("binary"), Buffer.from([0, 3])); fs.writeFileSync(env.file("large"), "y".repeat(81));
  await finalizeTurnFileCapture(capture);
  const page = index();
  assert.equal(page.capture.complete, false);
  assert.deepEqual(page.edits.map(edit => path.basename(edit.path)), ["binary", "large"]);
  assert.equal(read(page.edits[0]).notice, "binary"); assert.equal(read(page.edits[1]).notice, "large");
  assert.equal(buildFileDiff({ ...page.edits[0], ...read(page.edits[0]) }).notice, "binary");
});

saved("total body and elapsed budgets preserve an incomplete state instead of zero changes", async t => {
  const env = setup(t); fs.writeFileSync(env.file("a.md"), "12345"); fs.writeFileSync(env.file("b.md"), "67890");
  const capture = await env.prepare({ totalBytes: 5 }); fs.writeFileSync(env.file("b.md"), "final contents");
  await finalizeTurnFileCapture(capture);
  assert.equal(index().capture.complete, false); assert.ok(index().edits.some(edit => read(edit).notice === "large"));
  message(env.db, "timeout", "timeout-message");
  const timedOut = await env.prepare({ milliseconds: 0 }, "timeout"); await finalizeTurnFileCapture(timedOut);
  assert.equal(index("timeout-message").capture.complete, false);
});

saved("nested ignore negation allows a captured file and literal truncation text remains complete", async t => {
  const env = setup(t); fs.mkdirSync(env.file("nested"));
  fs.writeFileSync(env.file(".gitignore"), "*.md\n"); fs.writeFileSync(env.file("nested/.gitignore"), "!keep.md\n");
  fs.writeFileSync(env.file("nested/keep.md"), "# before\n[truncated]\n<truncated 12 bytes>");
  const capture = await env.prepare(); fs.appendFileSync(env.file("nested/keep.md"), "\nchanged"); await finalizeTurnFileCapture(capture);
  const [edit] = index().edits;
  assert.equal(path.basename(edit.path), "keep.md"); assert.equal(buildFileDiff({ ...edit, ...read(edit) }).notice, undefined);
});

saved("Windows directory junctions cannot expose files outside workspace roots", async t => {
  if (process.platform !== "win32") { t.skip("Windows directory junction"); return; }
  const env = setup(t); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-junction-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(env.file("inside")); fs.writeFileSync(env.file("inside/file.md"), "before"); fs.writeFileSync(path.join(outside, "file.md"), "outside secret");
  const capture = await env.prepare(); fs.unlinkSync(env.file("inside/file.md")); fs.rmdirSync(env.file("inside"));
  fs.symlinkSync(outside, env.file("inside"), "junction"); await finalizeTurnFileCapture(capture);
  assert.equal(index().capture.complete, false);
  assert.deepEqual(index().edits, []);
  const row = env.db.prepare("SELECT after_version, after_blob FROM turn_file_versions WHERE path = ?").get(env.file("inside/file.md"));
  assert.equal(JSON.parse(row.after_version).state, "unavailable");
  assert.equal(row.after_blob, null);
});

saved("BOM, CRLF and EOF bytes survive storage and empty files distinguish existence", async t => {
  const env = setup(t);
  const before = "\ufeff# doc\r\n\r\nline\r\n"; const after = "\ufeff# doc\r\n\r\nchanged";
  fs.writeFileSync(env.file("doc.md"), before);
  const capture = await env.prepare(); fs.writeFileSync(env.file("doc.md"), after); await finalizeTurnFileCapture(capture);
  const content = read(index().edits[0]);
  assert.deepEqual(Buffer.from(content.oldText), Buffer.from(before)); assert.deepEqual(Buffer.from(content.newText), Buffer.from(after));
  assert.ok(buildFileDiff({ ...index().edits[0], ...content }).rows.some(row => row.kind === "meta" && row.text.includes("EOF")));
});

saved("metadata index does not read blobs; paging includes unchanged coverage and immutable file lists", async t => {
  const queries = [];
  const env = setup(t);
  for (let i = 0; i < 105; i++) fs.writeFileSync(env.file(`${String(i).padStart(3, "0")}.md`), "before");
  const capture = await env.prepare(); fs.writeFileSync(env.file("001.md"), "after"); await finalizeTurnFileCapture(capture);
  const original = env.db.prepare.bind(env.db);
  env.db.prepare = sql => { queries.push(sql); return original(sql); };
  const page = index();
  assert.equal(page.edits.length, 1); assert.equal(page.coveredPaths.length, 105);
  assert.equal(queries.some(sql => /SELECT[^;]*payload/i.test(sql)), false);
  const frozen = JSON.stringify(page.edits);
  read(page.edits[0]); assert.equal(JSON.stringify(index().edits), frozen);
});

saved("overlapping workspaces are flagged while independent worktrees are separate", async t => {
  const env = setup(t); fs.writeFileSync(env.file("file"), "before");
  message(env.db, "second", "second-message"); message(env.db, "separate", "separate-message");
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-other-worktree-"));
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  const first = await env.prepare(); const second = await env.prepare(undefined, "second"); const separate = await env.prepare(undefined, "separate", [sibling]);
  fs.writeFileSync(env.file("file"), "after");
  await finalizeTurnFileCapture(first); await finalizeTurnFileCapture(second); await finalizeTurnFileCapture(separate);
  assert.equal(index().capture.overlapping, true); assert.equal(index("second-message").capture.overlapping, true);
  assert.equal(index("separate-message").capture.overlapping, false);
});

saved("ownership checks apply to cached pairs and deletion releases shared immutable blobs", async t => {
  const env = setup(t); fs.writeFileSync(env.file("file"), "before");
  const first = await env.prepare(); fs.writeFileSync(env.file("file"), "after"); await finalizeTurnFileCapture(first);
  const edit = index().edits[0]; read(edit);
  assert.throws(() => runAsCaller("bob", () => readMessageFileEdit("message", edit.path, edit.turnKey)), /not available/);
  assert.equal(runAsCaller("alice", () => readMessageFileEdit("message", edit.path, "0".repeat(64))), undefined);
  assert.equal(runAsCaller("alice", () => readMessageFileEdit("message", env.file("elsewhere"), edit.turnKey)), undefined);
  message(env.db, "next", "next-message"); const next = await env.prepare(undefined, "next");
  fs.writeFileSync(env.file("file"), "third"); await finalizeTurnFileCapture(next);
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM file_version_blobs").get().n, 3);
  env.db.prepare("DELETE FROM turn_file_capture_runs WHERE task_id = 'run'").run();
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM file_version_blobs").get().n, 2);
  assert.equal(read(index("next-message").edits[0], "next-message").oldText, "after");
  env.db.prepare("DELETE FROM conversations WHERE id = 'conversation'").run();
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM file_version_blobs").get().n, 0);
  assert.throws(() => read(edit), /not available/);
});

saved("restart uses persisted pairs and interrupted capture never reads a new endpoint", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-version-db-"));
  let reopened;
  t.after(() => { setDbForTest(null); if (reopened?.open) reopened.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const env = setup(t, path.join(temp, "versions.db")); fs.writeFileSync(env.file("file"), "before");
  const capture = await env.prepare(); fs.writeFileSync(env.file("file"), "after"); await finalizeTurnFileCapture(capture);
  const edit = index().edits[0];
  message(env.db, "interrupted", "interrupted-message"); await env.prepare(undefined, "interrupted");
  env.db.prepare("UPDATE turn_file_versions SET after_version = before_version, after_blob = before_blob, changed = 1 WHERE task_id = 'interrupted'").run();
  env.db.prepare("UPDATE turn_file_capture_runs SET state = 'finalizing' WHERE task_id = 'interrupted'").run();
  env.db.close();
  reopened = new Database(path.join(temp, "versions.db")); reopened.pragma("foreign_keys = ON"); migrate(reopened); recoverInterruptedFileCaptures(reopened); setDbForTest(reopened);
  fs.writeFileSync(env.file("file"), "today");
  assert.equal(read(edit).newText, "after");
  const interrupted = index("interrupted-message"); assert.equal(interrupted.capture.complete, false); assert.equal(interrupted.capture.state, "incomplete"); assert.equal(interrupted.edits.length, 0);
});

saved("legacy records remain the fallback when a body was not captured", async t => {
  const env = setup(t); fs.writeFileSync(env.file("file.md"), "before");
  const capture = await env.prepare({ fileBytes: 1 }); fs.writeFileSync(env.file("file.md"), "after!");
  persistFileEditItems({ conversationId: "conversation", sessionId: "run" }, [{ kind: "file-edit", path: "file.md", action: "update", status: "completed", oldText: "before", newText: "after!", partial: true }]);
  await finalizeTurnFileCapture(capture);
  const page = index(); assert.equal(page.edits.length, 1); assert.equal(page.edits[0].source, "records"); assert.equal(read(page.edits[0]).partial, true);
  assert.equal(read(page.edits[0]).oldText, "before"); assert.equal(read(page.edits[0]).newText, "after!");
  assert.equal(env.db.prepare("SELECT changed FROM turn_file_versions WHERE task_id = 'run'").get().changed, 0);
});

saved("handoff keeps independent saved versions after the source conversation is deleted", async t => {
  const env = setup(t); fs.writeFileSync(env.file("file.md"), "before");
  const capture = await env.prepare(); fs.writeFileSync(env.file("file.md"), "after"); await finalizeTurnFileCapture(capture);
  const exported = runAsCaller("alice", () => createHandoffTranscriptSnapshot(env.root, "conversation", [{
    id: "message", conversationId: "conversation", role: "assistant", status: "done", content: "[]", taskId: "run", createdAt: "0"
  }], undefined, readTurnFileSnapshotForHandoff));
  env.db.prepare("DELETE FROM conversations WHERE id = 'conversation'").run();
  const transcript = readHandoffTranscriptSnapshot(env.root, exported);
  const text = JSON.stringify(transcript);
  assert.ok(text.includes("before")); assert.ok(text.includes("after")); assert.equal(text.includes("turnKey"), false);
});

saved("symlinks outside roots are excluded and replaced symlinks cannot leak content", async t => {
  const env = setup(t); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret"), "outside secret"); fs.writeFileSync(env.file("file"), "inside");
  const capture = await env.prepare(); fs.unlinkSync(env.file("file"));
  try { fs.symlinkSync(path.join(outside, "secret"), env.file("file")); }
  catch (error) { if (error.code === "EPERM") { t.skip("Windows symlinks require developer mode"); await finalizeTurnFileCapture(capture); return; } throw error; }
  await finalizeTurnFileCapture(capture);
  assert.equal(index().capture.complete, false);
  assert.deepEqual(index().edits, []);
  const row = env.db.prepare("SELECT after_version, after_blob FROM turn_file_versions WHERE task_id = 'run'").get();
  assert.equal(JSON.parse(row.after_version).state, "unavailable"); assert.equal(row.after_blob, null);
});

saved("Windows case and slash variants identify the same file", async t => {
  if (process.platform !== "win32") { t.skip("Windows path identity"); return; }
  const env = setup(t); fs.writeFileSync(env.file("File.md"), "before");
  const capture = await env.prepare(); fs.writeFileSync(env.file("File.md"), "after");
  const alias = env.file("File.md").toUpperCase().replaceAll("\\", "/");
  persistFileEditItems({ conversationId: "conversation", sessionId: "run" }, [{ kind: "file-edit", path: alias, action: "update", status: "completed", oldText: "before", newText: "after" }]);
  await finalizeTurnFileCapture(capture);
  assert.equal(index().edits.length, 1); assert.ok(index().coveredPaths.includes(alias));
  assert.equal(snapshotPathIdentity(alias), snapshotPathIdentity(env.file("File.md")));
});

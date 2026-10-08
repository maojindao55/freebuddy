import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { importAgyLocalDiff, withoutInlineFileBodies } from "../dist-electron/cli/acpLocalDiff.js";
import { acpUpdateToItems } from "../dist-electron/cli/acp.js";
import { localDiffFixture } from "./fixtures/agy-local-diff.mjs";

test("AGY local references import exact Unicode diffs and release only after persistence", t => {
  const diffs = [{ type: "diff", path: "task.md", oldText: null, newText: "# 中文🙂\\n\n".repeat(100000) },
    { type: "diff", path: "app.ts", oldText: "before", newText: "after" }];
  const fixture = localDiffFixture(t, diffs);
  const imported = importAgyLocalDiff(fixture.update, "agy-acp");
  assert.equal(imported.imported, true);
  assert.deepEqual(imported.update.content, diffs);
  assert.ok(fs.existsSync(fixture.filename));
  imported.release(); imported.release();
  assert.equal(fs.existsSync(fixture.filename), false);
});

test("other adapters cannot consume or delete AGY artifacts", t => {
  const fixture = localDiffFixture(t, [{ type: "diff", path: "task.md", newText: "content" }]);
  const imported = importAgyLocalDiff(fixture.update, "other-acp");
  assert.equal(imported.imported, false);
  assert.equal(imported.update, fixture.update);
  imported.release();
  assert.ok(fs.existsSync(fixture.filename));
});

for (const reason of ["checksum", "size", "too large", "outside namespace", "schema", "version", "target path", "missing"])
  test(`invalid local diff has bounded, explicit failure: ${reason}`, t => {
    const fixture = localDiffFixture(t, [{ type: "diff", path: "task.md", newText: reason === "schema" ? 42 : "content" }],
      { ...(reason === "outside namespace" ? { prefix: "unrelated-" } : {}), ...(reason === "version" ? { body: { version: 2 } } : {}) });
    if (reason === "checksum") fs.writeFileSync(fixture.filename, "x".repeat(fixture.payload.length));
    if (reason === "size") fixture.descriptor.bytes++;
    if (reason === "too large") fixture.descriptor.bytes = 8 * 1024 * 1024 + 1;
    if (reason === "target path") fixture.update.content[0].path = "other.md";
    if (reason === "missing") fs.unlinkSync(fixture.filename);
    const imported = importAgyLocalDiff(fixture.update, "agy-acp");
    assert.equal(imported.imported, false);
    assert.equal(imported.update.content[0]._meta.freebuddy.truncated, true);
    assert.ok(JSON.stringify(imported.update).length < 1024);
    imported.release();
    if (reason !== "missing") assert.ok(fs.existsSync(fixture.filename));
  });

test("symbolic-link artifacts and directories are rejected", { skip: process.platform === "win32" }, t => {
  const fixture = localDiffFixture(t, [{ type: "diff", path: "task.md", newText: "content" }]);
  const target = path.join(fixture.directory, "target.json");
  fs.renameSync(fixture.filename, target);
  fs.symlinkSync(target, fixture.filename);
  assert.equal(importAgyLocalDiff(fixture.update, "agy-acp").imported, false);
  fs.unlinkSync(fixture.filename);
  fs.renameSync(target, fixture.filename);
  const link = fixture.directory + "-link";
  fs.symlinkSync(fixture.directory, link);
  t.after(() => fs.unlinkSync(link));
  fixture.descriptor.path = path.join(link, path.basename(fixture.filename));
  assert.equal(importAgyLocalDiff(fixture.update, "agy-acp").imported, false);
});

test("truncation metadata preserves the action and suppresses invented complete diffs", () => {
  const items = acpUpdateToItems({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed",
    content: [{ type: "diff", path: "task.md", oldText: "", newText: "<truncated 100000 bytes>",
      _meta: { freebuddy: { action: "create", truncated: true } } }] });
  const edit = items[0].toolOutputs.find(item => item.kind === "file-edit");
  assert.equal(edit.action, "create");
  assert.equal(edit.truncated, true);
});

test("storage failures strip imported bodies while persisted blob references stay usable", () => {
  const body = "中文🙂".repeat(100000);
  const items = [{ kind: "tool-call", id: "t", input: [{ type: "diff", newText: body }], toolOutputs: [
    { kind: "file-edit", path: "task.md", action: "create", newText: body },
    { kind: "file-edit", path: "saved.md", action: "update", blobKey: "blob", counts: { added: 1, removed: 2 } }
  ] }];
  const stripped = withoutInlineFileBodies(items);
  assert.ok(JSON.stringify(stripped).length < 1024);
  assert.equal(stripped[0].input, undefined);
  assert.equal(stripped[0].toolOutputs[0].truncated, true);
  assert.deepEqual(stripped[0].toolOutputs[1].counts, { added: 1, removed: 2 });
  assert.equal(stripped[0].toolOutputs[1].blobKey, "blob");
});

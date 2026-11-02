import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { importAgyLocalDiff, withoutInlineFileBodies } from "../dist-electron/cli/acpLocalDiff.js";
import { acpUpdateToItems } from "../dist-electron/cli/acp.js";
import { aggregateFileEdits, buildFileDiff } from "@freebuddy/cli-stream";
import { localDiffFixture } from "./fixtures/agy-local-diff.mjs";
import { claudeTurnUpdates } from "./fixtures/claude-turn-diff.mjs";

test("ACP composes repeated same-file table fragments without treating them as complete documents", () => {
  const path = "/workspace/docs/car_media_api.md";
  const first = [
    "| 4 | 首页 | `/2/car/home/follow_update/stream` | 作者型 | 常看的人更新-查看更多 |",
    "| 5 | 首页 | `/2/car/home/my_fav/card` | 卡片 | 我的收藏，首屏 3 条 |",
    "| 6 | 首页 | `/2/car/home/my_fav/stream` | 流式 | 我的收藏-查看更多，支持 filter |",
    ""
  ].join("\n");
  const second = [
    "| 17 | 我的 | `/2/car/my/follow/stream` | 作者型 | 我的关注-查看更多 |",
    "| 18 | 我的 | `/2/car/my/fav/card` | 卡片 | 我的收藏，首屏 4 条 |",
    "| 19 | 我的 | `/2/car/my/fav/stream` | 流式 | 我的收藏-查看更多，支持 filter |",
    "| 20 | 我的 | `/2/car/my/like/card` | 卡片 | 我的点赞，首屏 4 条 |",
    "| 21 | 我的 | `/2/car/my/like/stream` | 流式 | 我的点赞-查看更多，支持 filter |",
    ""
  ].join("\n");
  const [call] = acpUpdateToItems({ sessionUpdate: "tool_call", toolCallId: "multi-hunk", kind: "edit", status: "in_progress",
    content: [
      { type: "diff", path: "/workspace/controllers/carmock_test.go", oldText: "count := 3\n", newText: "count := 5\n" },
      { type: "diff", path, oldText: first, newText: first.replace("首屏 3 条", "首屏 5 条"), _meta: { kind: "update" } },
      { type: "diff", path, oldText: second, newText: second.replaceAll("首屏 4 条", "首屏 5 条"), _meta: { kind: "update" } },
      { type: "diff", path: "/workspace/modules/builder_test.go", oldText: "count := 4\n", newText: "count := 5\n" }
    ] });
  assert.deepEqual(call.toolOutputs.map(edit => edit.partial), [undefined, true, true, undefined]);
  const summary = aggregateFileEdits(call.toolOutputs).find(edit => edit.path === path);
  const diff = buildFileDiff(summary);
  assert.equal(summary.partial, true);
  assert.equal(summary.oldText, undefined);
  assert.equal(summary.newText, undefined);
  assert.equal(diff.notice, undefined);
  assert.deepEqual([diff.added, diff.removed], [3, 3]);
  assert.equal(diff.rows.filter(row => row.kind === "add").length, 3);
});

test("repeated-path snippet inference preserves create/delete actions and explicit full recovery", () => {
  const [call] = acpUpdateToItems({ sessionUpdate: "tool_call", toolCallId: "replace-file", kind: "edit", status: "completed",
    content: [
      { type: "diff", path: "replace.md", oldText: "before", _meta: { freebuddy: { action: "delete" } } },
      { type: "diff", path: "replace.md", newText: "after", _meta: { freebuddy: { action: "create" } } },
      { type: "diff", path: "replace.md", oldText: "after", newText: "final" }
    ] });
  assert.deepEqual(call.toolOutputs.map(edit => [edit.action, edit.partial]), [
    ["delete", undefined], ["create", undefined], ["update", undefined]
  ]);

  const recovered = structuredClone(claudeTurnUpdates(0)[2]);
  recovered.content.push(structuredClone(recovered.content.find(entry => entry.type === "diff")));
  const [complete] = acpUpdateToItems(recovered);
  assert.equal(complete.toolOutputs.filter(edit => edit.kind === "file-edit").length, 2);
  for (const edit of complete.toolOutputs.filter(edit => edit.kind === "file-edit")) {
    assert.equal(edit.partial, undefined);
    assert.equal(edit.oldText, recovered._meta.claudeCode.toolResponse.originalFile);
  }
});

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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { getParser, serializeStreamItemsForPersist } from "@freebuddy/cli-stream";

const output = ts.transpileModule(fs.readFileSync(new URL("../src/utils/fileDiff.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText.replaceAll('"@freebuddy/cli-stream"', JSON.stringify(new URL("../packages/cli-stream/dist/index.js", import.meta.url).href));
const { buildFileDiff, collectFileEdits, foldDiffRows, inlineHighlights, groupFileEditRecords, isMarkdownFile, markdownVersions } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const edit = (fields) => ({ kind: "file-edit", path: "src/a.ts", action: "update", ...fields });

test("native transcript truncation cannot become a two-line diff even after blob hydration", () => {
  const newText = '"# Tasks\\n\\n- [ ] Check parameters\\n\n<truncated 1127 bytes>';
  for (const blobKey of [undefined, "saved"]) {
    const diff = buildFileDiff(edit({ action: "create", newText, blobKey }));
    assert.equal(diff.notice, "truncated");
    assert.equal(diff.added, 0);
    assert.equal(diff.rows.length, 0);
  }
  assert.equal(buildFileDiff(edit({ oldText: "before\r\n<truncated 3 lines>\r\n", newText: "after" })).notice, "truncated");
  assert.equal(buildFileDiff(edit({ action: "create", newText: "Explain <truncated 12 bytes> here.\n" })).notice, undefined);
  assert.equal(buildFileDiff(edit({ action: "create", newText: "```\n<truncated 12 bytes>\n```\n" })).notice, undefined);
});

test("Markdown previews use captured versions and refuse snippets, patches, and truncated text", () => {
  const markdown = edit({ path: "docs/task.MD", oldText: "# Before", newText: "# After" });
  assert.equal(isMarkdownFile(markdown.path), true);
  assert.equal(isMarkdownFile("task.markdown"), true);
  assert.equal(isMarkdownFile("task.md.ts"), false);
  assert.deepEqual(markdownVersions(markdown), { before: "# Before", after: "# After" });
  assert.deepEqual(markdownVersions({ ...markdown, action: "create", oldText: undefined, newText: "" }), { after: "" });
  assert.deepEqual(markdownVersions({ ...markdown, action: "delete", newText: undefined }), { before: "# Before" });
  assert.deepEqual(markdownVersions({ ...markdown, partial: true }), {});
  assert.deepEqual(markdownVersions({ ...markdown, truncated: true }), {});
  assert.deepEqual(markdownVersions({ ...markdown, newText: '"# After\\n\n<truncated 20 bytes>', blobKey: "saved" }), {});
  assert.deepEqual(markdownVersions(edit({ path: "task.md", patch: "@@ -1 +1 @@\n-before\n+after\n" })), {});
  assert.deepEqual(markdownVersions({ ...markdown, path: "code.ts" }), {});
});

test("file-local history retains original indices across interleaved files and duplicate names", () => {
  const edits = ["docs/task.md", "src/a.ts", "docs/task.md", "other/task.md"].map(path => edit({ path }));
  assert.deepEqual(groupFileEditRecords(edits), [
    { path: "docs/task.md", indices: [0, 2] },
    { path: "src/a.ts", indices: [1] },
    { path: "other/task.md", indices: [3] }
  ]);
});

test("diff preserves context, exact line numbers, and added/removed counts", () => {
  const diff = buildFileDiff(edit({ oldText: "first\nold\nlast\n", newText: "first\nnew\nextra\nlast\n" }));
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.deepEqual(diff.rows.map((r) => [r.kind, r.oldLine, r.newLine]), [
    ["context", 1, 1], ["delete", 2, undefined], ["add", undefined, 2], ["add", undefined, 3], ["context", 3, 4]
  ]);
});

test("new and deleted files use empty baselines, but missing content does not", () => {
  assert.equal(buildFileDiff(edit({ action: "create", newText: "a\nb\n" })).added, 2);
  assert.equal(buildFileDiff(edit({ action: "delete", oldText: "a\n" })).removed, 1);
  assert.equal(buildFileDiff(edit({ newText: "a" })).notice, "missing");
  assert.equal(buildFileDiff(edit({ action: "create", newText: "" })).rows.length, 0);
});

test("unified patches use hunk offsets and preserve plus/minus lines", () => {
  const diff = buildFileDiff(edit({ patch: "--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +20,2 @@\n---old\n+++new\n same\n" }));
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.deepEqual(diff.rows.find((r) => r.kind === "delete"), { kind: "delete", text: "--old", oldLine: 10 });
  assert.equal(diff.rows.find((r) => r.kind === "add").newLine, 20);
  assert.equal(buildFileDiff(edit({ patch: "*** Begin Patch\n*** End Patch" })).notice, "raw");
});

test("truncation and excessive diff work are explicit, never fabricated", () => {
  assert.equal(buildFileDiff(edit({ oldText: "a", newText: "b", truncated: true })).notice, "truncated");
  assert.equal(buildFileDiff(edit({ patch: "abc\n…[truncated]" })).notice, "truncated");
  assert.equal(buildFileDiff(edit({ oldText: "a\n".repeat(1500), newText: "b\n".repeat(1500) })).notice, "large");
});

test("EOF newline changes remain visible and unchanged runs can be expanded", () => {
  const diff = buildFileDiff(edit({ oldText: "a", newText: "a\n" }));
  assert.ok(diff.rows.some((r) => r.kind === "meta"));
  const unchanged = Array.from({ length: 20 }, (_, i) => ({ kind: "context", text: String(i) }));
  const folded = foldDiffRows(unchanged);
  assert.equal(folded.length, 7);
  assert.deepEqual(folded[3], { kind: "fold", start: 3, count: 14 });
  assert.equal(unchanged.length, 20);
});

test("edge folds keep context only next to changes and expanded folds stay open", () => {
  const ctx = (n) => Array.from({ length: n }, (_, i) => ({ kind: "context", text: `c${i}` }));
  const rows = [...ctx(10), { kind: "add", text: "x" }, ...ctx(10)];
  const folded = foldDiffRows(rows);
  assert.deepEqual(folded[0], { kind: "fold", start: 0, count: 7 });
  assert.deepEqual(folded.at(-1), { kind: "fold", start: 14, count: 7 });
  assert.equal(folded.length, 9);
  assert.equal(foldDiffRows(rows, new Set([0])).length, 15);
});

test("replaced lines highlight only the changed words", () => {
  const diff = buildFileDiff(edit({ oldText: "const foo = 1;\n", newText: "const foobar = 1;\n" }));
  const marks = inlineHighlights(diff.rows);
  const [del, add] = diff.rows;
  assert.deepEqual(marks.get(del), [6, 9]);
  assert.deepEqual(marks.get(add), [6, 12]);
  assert.equal(inlineHighlights(buildFileDiff(edit({ oldText: "a\nb\n", newText: "x y z\n" })).rows).size, 0);
  assert.equal(inlineHighlights(buildFileDiff(edit({ oldText: "  foo\n", newText: "  bar\n" })).rows).size, 0);
});

test("persisted file edits explicitly mark shortened content", () => {
  const saved = JSON.parse(serializeStreamItemsForPersist([edit({ oldText: "x".repeat(20_000), newText: "y" })]));
  const change = saved.find((item) => item.kind === "file-edit");
  assert.equal(change.truncated, true);
  assert.equal(buildFileDiff(change).notice, "truncated");
});

test("nested ACP diffs are collected while failed and pending tools are excluded", () => {
  const changes = collectFileEdits([
    { kind: "tool-call", id: "ok", tool: "edit", status: "completed", toolOutputs: [edit({ newText: "x" })] },
    { kind: "tool-call", id: "bad", tool: "edit", status: "failed", toolOutputs: [edit({})] },
    { kind: "tool-call", id: "pending", tool: "edit", status: "pending", toolOutputs: [edit({})] },
    edit({ status: "pending" }), edit({ status: "failed" })
  ]);
  assert.equal(changes.length, 1);
});

test("Claude Edit shows successful snippets without claiming complete file content", () => {
  const call = { kind: "tool-call", tool: "Edit", id: "edit-1", input: { file_path: "a.ts", old_string: "before", new_string: "after" } };
  assert.equal(collectFileEdits([call]).length, 0);
  assert.equal(collectFileEdits([call, { kind: "tool-result", id: "edit-1", isError: true }]).length, 0);
  const [change] = collectFileEdits([call, { kind: "tool-result", id: "edit-1", content: "ok" }]);
  assert.equal(change.partial, true);
  assert.equal(change.oldText, "before");
});

test("Codex completed file changes reach the diff model; failed changes stay excluded", () => {
  const parser = getParser("codex-json");
  const event = { type: "item.completed", item: { type: "file_change", status: "completed", changes: [{ path: "a.ts", kind: "add" }] } };
  const items = parser.parseStdoutLine(JSON.stringify(event), {});
  assert.equal(items[0].action, "create");
  assert.equal(collectFileEdits(items).length, 1);
  event.item.status = "failed";
  assert.equal(collectFileEdits(parser.parseStdoutLine(JSON.stringify(event), {})).length, 0);
});

test("Antigravity replace_file_content extracts unified diff patch from tool output even with text toolOutputs", () => {
  const patchContent = "@@ -10,3 +10,4 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;";
  const outputText = `The following changes were made by the replace_file_content tool to: /src/app.ts.\n[diff_block_start]\n${patchContent}\n[diff_block_end]\nUnchanged lines...`;
  const call = {
    kind: "tool-call",
    id: "tool-1",
    tool: "replace_file_content",
    status: "completed",
    input: { TargetFile: "/src/app.ts", TargetContent: "const a = 1;", ReplacementContent: "const a = 2;\nconst b = 3;" },
    toolOutputs: [{ kind: "text", role: "assistant", content: outputText }]
  };
  const edits = collectFileEdits([call]);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].path, "/src/app.ts");
  assert.equal(edits[0].action, "update");
  assert.equal(edits[0].patch, patchContent);

  const diff = buildFileDiff(edits[0]);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
});

test("Antigravity replace_file_content falls back to snippet parameters without patch", () => {
  const call = {
    kind: "tool-call",
    id: "tool-2",
    tool: "replace_file_content",
    status: "completed",
    input: { TargetFile: "/src/app.ts", TargetContent: "const a = 1;\n", ReplacementContent: "const a = 2;\n" }
  };
  const [editItem] = collectFileEdits([call]);
  assert.equal(editItem.path, "/src/app.ts");
  assert.equal(editItem.oldText, "const a = 1;\n");
  assert.equal(editItem.newText, "const a = 2;\n");
  assert.equal(editItem.partial, true);

  const diff = buildFileDiff(editItem);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});

test("Antigravity write_to_file handles creation and overwrite", () => {
  const createCall = {
    kind: "tool-call",
    id: "tool-create",
    tool: "write_to_file",
    status: "completed",
    input: { TargetFile: "/src/new.ts", CodeContent: "export const x = 1;\n" }
  };
  const [created] = collectFileEdits([createCall]);
  assert.equal(created.action, "create");
  assert.equal(created.newText, "export const x = 1;\n");
  assert.equal(buildFileDiff(created).added, 1);

  const overwriteCall = {
    kind: "tool-call",
    id: "tool-update",
    tool: "write_to_file",
    status: "completed",
    input: { TargetFile: "/src/existing.ts", CodeContent: "export const x = 2;\n", Overwrite: true }
  };
  const [overwritten] = collectFileEdits([overwriteCall]);
  assert.equal(overwritten.action, "update");
  assert.equal(overwritten.newText, "export const x = 2;\n");
});

test("Antigravity multi_replace_file_content extracts multiple edits", () => {
  const call = {
    kind: "tool-call",
    id: "tool-multi",
    tool: "multi_replace_file_content",
    status: "completed",
    input: {
      TargetFile: "/src/app.ts",
      Replacements: [
        { TargetContent: "foo", ReplacementContent: "bar" },
        { TargetContent: "baz", ReplacementContent: "qux" }
      ]
    }
  };
  const edits = collectFileEdits([call]);
  assert.equal(edits.length, 2);
  assert.equal(edits[0].oldText, "foo");
  assert.equal(edits[0].newText, "bar");
  assert.equal(edits[1].oldText, "baz");
  assert.equal(edits[1].newText, "qux");
});

test("collectFileEdits supersedes hollow nested toolOutputs edits when tool-call has output diff block", () => {
  const patchContent = "@@ -1,3 +1,3 @@\n-Hello World\n+Hello FreeBuddy\n Line 2\n-Line 3";
  const call = {
    kind: "tool-call",
    id: "tool-9",
    tool: "replace_file_content",
    status: "completed",
    toolOutputs: [
      {
        kind: "file-edit",
        path: "/Users/hongbin9/www/freebuddy-main/test-diff.txt",
        action: "update"
      }
    ],
    output: `The following changes were made by the replace_file_content tool to: /Users/hongbin9/www/freebuddy-main/test-diff.txt
[diff_block_start]
${patchContent}
[diff_block_end]
`
  };

  const edits = collectFileEdits([call]);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].path, "/Users/hongbin9/www/freebuddy-main/test-diff.txt");
  assert.equal(edits[0].patch, patchContent);

  const diff = buildFileDiff(edits[0]);
  assert.equal(diff.notice, undefined);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 2);
});

const { relativePath, pickerLabels } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("relativePath strips the longest matching workspace root", () => {
  const file = "/Users/me/www/app/src/types/a.d.ts";
  assert.equal(relativePath(file, ["/Users/me/www/app"]), "src/types/a.d.ts");
  assert.equal(relativePath(file, ["/Users/me/www/app/"]), "src/types/a.d.ts");
  assert.equal(relativePath(file, ["/Users/me", "/Users/me/www/app", undefined]), "src/types/a.d.ts");
  assert.equal(relativePath(file, ["/users/ME/www/APP"]), "src/types/a.d.ts");
});

test("relativePath keeps paths outside every root and avoids partial segment matches", () => {
  assert.equal(relativePath("/etc/hosts", ["/Users/me/www/app"]), "/etc/hosts");
  assert.equal(relativePath("/Users/me/www/app-old/x.ts", ["/Users/me/www/app"]), "/Users/me/www/app-old/x.ts");
  assert.equal(relativePath("src/a.ts", ["/Users/me/www/app"]), "src/a.ts");
  assert.equal(relativePath("C:\\repo\\src\\a.ts", ["C:\\repo"]), "src/a.ts");
});

test("pickerLabels shows file name only and adds directory for name clashes", () => {
  const root = "/r";
  assert.deepEqual(
    pickerLabels(["/r/src/a.ts", "/r/src/b.ts", "/r/src/a.ts"], [root]),
    ["a.ts", "b.ts", "a.ts"]
  );
  assert.deepEqual(
    pickerLabels(["/r/src/index.ts", "/r/lib/index.ts", "/r/README.md"], [root]),
    ["index.ts — src", "index.ts — lib", "README.md"]
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { aggregateFileEdits, applyFileEditPatch, buildFileDiff } from "@freebuddy/cli-stream";
import { agyTurnChanges } from "./fixtures/agy-turn-diff.mjs";
import { codebuddyTurnChanges } from "./fixtures/codebuddy-turn-diff.mjs";

const edit = fields => ({ kind: "file-edit", path: "src/a.ts", action: "update", ...fields });
const counts = item => {
  const diff = buildFileDiff(item);
  assert.equal(diff.notice, undefined);
  return { added: diff.added, removed: diff.removed };
};

test("patch application validates EOF markers against captured complete documents", () => {
  const keepMissing = "@@ -2,1 +2,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file";
  assert.equal(applyFileEditPatch("header\nold", keepMissing), "header\nnew");
  assert.equal(applyFileEditPatch("header\nnew", keepMissing, true), "header\nold");
  assert.equal(applyFileEditPatch("header\nold\n", keepMissing), undefined);
  assert.equal(applyFileEditPatch("header\nold\nother", keepMissing), undefined);
  assert.equal(applyFileEditPatch("old\nother\n", "@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file"), undefined);
  assert.equal(applyFileEditPatch("old\n", "@@ -1,1 +2,1 @@\n-old\n+new"), undefined);
  assert.equal(applyFileEditPatch("old", "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new"), "new\n");
  assert.equal(applyFileEditPatch("old\n", "@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file"), "new");
});

test("a turn has one diff per file from its first baseline to its final content", () => {
  const summaries = aggregateFileEdits([
    edit({ oldText: "a\nb\n", newText: "a\nc\n" }),
    edit({ path: "other.ts", action: "create", newText: "other\n" }),
    edit({ oldText: "a\nc\n", newText: "a\nd\nextra\n" }),
    edit({ oldText: "a\nd\nextra\n", newText: "a\nfinal\n" })
  ]);
  assert.deepEqual(summaries.map(item => item.path), ["src/a.ts", "other.ts"]);
  assert.equal(summaries[0].oldText, "a\nb\n");
  assert.equal(summaries[0].newText, "a\nfinal\n");
  assert.deepEqual(counts(summaries[0]), { added: 1, removed: 1 });
});

test("reverted edits and files created then deleted leave no net diff", () => {
  assert.deepEqual(aggregateFileEdits([
    edit({ oldText: "before", newText: "temporary" }),
    edit({ oldText: "temporary", newText: "before" }),
    edit({ path: "temporary.ts", action: "create", newText: "created" }),
    edit({ path: "temporary.ts", action: "delete", oldText: "created" })
  ]), []);
  assert.deepEqual(aggregateFileEdits([edit({ oldText: "same", newText: "same" })]), []);
});

test("creation, deletion, and recreation retain the turn's original file existence", () => {
  const [created] = aggregateFileEdits([
    edit({ action: "create", newText: "initial\n" }),
    edit({ oldText: "initial\n", newText: "final\nextra\n" })
  ]);
  assert.equal(created.action, "create");
  assert.deepEqual(counts(created), { added: 2, removed: 0 });
  const [deleted] = aggregateFileEdits([
    edit({ oldText: "original\n", newText: "intermediate\nextra\n" }),
    edit({ action: "delete", oldText: "intermediate\nextra\n" })
  ]);
  assert.equal(deleted.action, "delete");
  assert.deepEqual(counts(deleted), { added: 0, removed: 1 });
  const [recreated] = aggregateFileEdits([
    edit({ action: "delete", oldText: "original\n" }),
    edit({ action: "create", newText: "replacement\n" })
  ]);
  assert.equal(recreated.action, "update");
  assert.deepEqual(counts(recreated), { added: 1, removed: 1 });
  assert.equal(aggregateFileEdits([edit({ action: "create", newText: "" })]).length, 1);
});

test("captured full documents compose with snippets before and after the snapshot", () => {
  const [summary] = aggregateFileEdits([
    edit({ partial: true, oldText: "old", newText: "middle" }),
    edit({ oldText: "header\nmiddle\nfooter\n", newText: "header\nnext\nfooter\n" }),
    edit({ partial: true, oldText: "next", newText: "final" })
  ]);
  assert.equal(summary.oldText, "header\nold\nfooter\n");
  assert.equal(summary.newText, "header\nfinal\nfooter\n");
  assert.equal(summary.partial, undefined);
  assert.deepEqual(counts(summary), { added: 1, removed: 1 });
});

test("patches on either side of a snapshot reconstruct both complete versions", () => {
  const [summary] = aggregateFileEdits([
    edit({ patch: "@@ -2,1 +2,1 @@\n-old\n+middle\n" }),
    edit({ oldText: "header\nmiddle\n", newText: "header\nnext\n" }),
    edit({ patch: "@@ -2,1 +2,2 @@\n-next\n+final\n+extra\n" })
  ]);
  assert.equal(summary.oldText, "header\nold\n");
  assert.equal(summary.newText, "header\nfinal\nextra\n");
  assert.deepEqual(counts(summary), { added: 2, removed: 1 });
});

test("patch-only edits cancel intermediate changes and preserve file line offsets", () => {
  const [summary] = aggregateFileEdits([
    edit({ patch: "@@ -10,1 +10,2 @@\n-original\n+temporary\n+extra\n" }),
    edit({ patch: "@@ -10,2 +10,1 @@\n-temporary\n-extra\n+final\n" }),
    edit({ patch: "@@ -30,1 +30,1 @@\n-second old\n+second final\n" })
  ]);
  assert.deepEqual(counts(summary), { added: 2, removed: 2 });
  const diff = buildFileDiff(summary);
  assert.deepEqual(diff.rows.filter(row => row.kind === "delete").map(row => [row.text, row.oldLine]), [["original", 10], ["second old", 30]]);
  assert.deepEqual(diff.rows.filter(row => row.kind === "add").map(row => [row.text, row.newLine]), [["final", 10], ["second final", 30]]);
  assert.equal(summary.patch.includes("temporary"), false);
  assert.equal(summary.oldText, undefined);
});

test("patch insertions move later line offsets while repeated edits still reduce to one net change", () => {
  const [summary] = aggregateFileEdits([
    edit({ patch: "@@ -0,0 +1,2 @@\n+insert one\n+insert two\n" }),
    edit({ patch: "@@ -12,1 +12,1 @@\n-old\n+middle\n" }),
    edit({ patch: "@@ -12,1 +12,1 @@\n-middle\n+final\n" })
  ]);
  assert.deepEqual(counts(summary), { added: 3, removed: 1 });
  assert.equal(buildFileDiff(summary).rows.find(row => row.kind === "delete").oldLine, 10);
  assert.equal(buildFileDiff(summary).rows.find(row => row.text === "final").newLine, 12);
  assert.deepEqual(aggregateFileEdits([
    edit({ patch: "@@ -5,1 +5,1 @@\n-old\n+temporary\n" }),
    edit({ patch: "@@ -5,1 +5,1 @@\n-temporary\n+old\n" })
  ]), []);
});

test("multiple hunks in a patch use that edit's original positions", () => {
  const [summary] = aggregateFileEdits([
    edit({ patch: "@@ -2,1 +2,2 @@\n-first\n+first changed\n+inserted\n@@ -10,1 +11,1 @@\n-last\n+last changed\n" }),
    edit({ patch: "@@ -11,1 +11,1 @@\n-last changed\n+final\n" })
  ]);
  assert.deepEqual(counts(summary), { added: 3, removed: 2 });
  assert.deepEqual(buildFileDiff(summary).rows.filter(row => row.kind === "delete").map(row => row.oldLine), [2, 10]);
});

test("AGY replacement snippets plus trimmed patch context still yield the complete net changes", () => {
  const summaries = aggregateFileEdits(agyTurnChanges.map(change => edit(change)));
  assert.equal(summaries.length, 1);
  const summary = summaries[0];
  assert.deepEqual(counts(summary), { added: 3, removed: 3 });
  assert.equal(summary.oldText, undefined);
  assert.equal(summary.newText, undefined);
  const diff = buildFileDiff(summary);
  assert.deepEqual(diff.rows.filter(row => row.kind === "delete").map(row => [row.oldLine, row.text]), [
    [1, "# Star Fighter"], [3, "A shooting game."], [7, "Open index.html in a browser."]
  ]);
  assert.deepEqual(diff.rows.filter(row => row.kind === "add").map(row => [row.newLine, row.text]), [
    [1, "# Star Fighter (Canvas)"], [3, "A lightweight shooting game."], [7, "Open index.html in a browser to start playing."]
  ]);
  // Line 10 was omitted from the last captured patch. Do not invent its text.
  assert.equal(diff.rows.some(row => row.oldLine === 10 || row.newLine === 10), false);
});

test("full snapshots accompanied by patches retain both complete document versions", () => {
  const [summary] = aggregateFileEdits([
    edit({ oldText: "header\nold\nfooter\n", newText: "header\nmiddle\nfooter\n", patch: "@@ -1,3 +1,3 @@\n header\n-old\n+middle\n footer\n" }),
    edit({ oldText: "header\nmiddle\nfooter\n", newText: "header\nfinal\nfooter\n", patch: "@@ -1,3 +1,3 @@\n header\n-middle\n+final\n footer\n" })
  ]);
  assert.equal(summary.oldText, "header\nold\nfooter\n");
  assert.equal(summary.newText, "header\nfinal\nfooter\n");
  assert.deepEqual(counts(summary), { added: 1, removed: 1 });
});

test("a one-line patch snippet cannot prevent composing later file-relative patches", () => {
  const [summary] = aggregateFileEdits([
    edit({ oldText: "first", newText: "changed", patch: "@@ -1,1 +1,1 @@\n-first\n+changed" }),
    edit({ oldText: "later", newText: "final", patch: "@@ -10,1 +10,1 @@\n-later\n+final" })
  ]);
  assert.deepEqual(counts(summary), { added: 2, removed: 2 });
  assert.deepEqual(buildFileDiff(summary).rows.filter(row => row.kind === "delete").map(row => row.oldLine), [1, 10]);
});

test("trimmed context recovery cannot accept mismatched snippets or missing changed lines", () => {
  for (const change of [
    { ...agyTurnChanges[0], newText: "uncaptured replacement" },
    { ...agyTurnChanges[0], patch: "@@ -1,4 +1,4 @@\n-# Star Fighter\n+# Star Fighter (Canvas)" },
    { ...agyTurnChanges[0], truncated: true }
  ]) {
    const [summary] = aggregateFileEdits([edit(change), edit(agyTurnChanges[1])]);
    assert.equal(buildFileDiff(summary).notice, "missing");
  }
});

test("connected snippets have a single partial diff and do not become full document previews", () => {
  const [summary] = aggregateFileEdits([
    edit({ partial: true, oldText: "const x = 1;", newText: "const x = 2;" }),
    edit({ partial: true, oldText: "x = 2", newText: "x = 3" })
  ]);
  assert.equal(summary.oldText, "const x = 1;");
  assert.equal(summary.newText, "const x = 3;");
  assert.equal(summary.partial, true);
  assert.deepEqual(counts(summary), { added: 1, removed: 1 });
});

test("disjoint CodeBuddy snippets display every net change in one partial diff", () => {
  const [summary] = aggregateFileEdits(codebuddyTurnChanges.map(change => edit({ ...change, partial: true })));
  assert.equal(summary.partial, true);
  assert.equal(summary.oldText, undefined);
  assert.equal(summary.newText, undefined);
  assert.deepEqual(counts(summary), { added: 3, removed: 3 });
  const diff = buildFileDiff(summary);
  assert.deepEqual(diff.rows.filter(row => row.kind === "delete").map(row => row.text), codebuddyTurnChanges.map(change => change.oldText));
  assert.deepEqual(diff.rows.filter(row => row.kind === "add").map(row => row.text), codebuddyTurnChanges.map(change => change.newText));
});

test("snippet regions cancel reverts and join a later wider captured region", () => {
  const [summary] = aggregateFileEdits([
    edit({ partial: true, oldText: "old", newText: "middle" }),
    edit({ partial: true, oldText: "prefix middle suffix", newText: "prefix final suffix" }),
    edit({ partial: true, oldText: "other", newText: "temporary" }),
    edit({ partial: true, oldText: "temporary", newText: "other" })
  ]);
  assert.equal(summary.oldText, "prefix old suffix");
  assert.equal(summary.newText, "prefix final suffix");
  assert.equal(summary.partial, true);
});

test("missing, disconnected, ambiguous, and truncated captures cannot fabricate a whole-file diff", () => {
  for (const edits of [
    [edit({ oldText: "a", newText: "b" }), edit({ oldText: "unrelated", newText: "different" })],
    [edit({ partial: true, oldText: "a", newText: "b b" }), edit({ partial: true, oldText: "b", newText: "c" })],
    [edit({ blobKey: "first" }), edit({ blobKey: "last" })],
    [edit({ oldText: "a", newText: "b" }), edit({ oldText: "b", newText: "c", truncated: true })],
    [edit({ patch: "@@ -1,2 +1,1 @@\n-a\n+b" }), edit({ patch: "@@ -1,1 +1,1 @@\n-b\n+c" })],
    [edit({ patch: "@@ -30000,1 +30000,1 @@\n-a\n+b" }), edit({ patch: "@@ -30000,1 +30000,1 @@\n-b\n+c" })]
  ]) {
    const summary = aggregateFileEdits(edits);
    assert.equal(summary.length, 1);
    assert.equal(buildFileDiff(summary[0]).notice, "missing");
    assert.equal(summary[0].counts, undefined);
  }
});

test("failed and pending edits do not enter the final turn summary", () => {
  const summaries = aggregateFileEdits([
    edit({ oldText: "a", newText: "b", status: "completed" }),
    edit({ oldText: "b", newText: "wrong", status: "failed" }),
    edit({ oldText: "b", newText: "pending", status: "pending" })
  ]);
  assert.equal(summaries[0].newText, "b");
});

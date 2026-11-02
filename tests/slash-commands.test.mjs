import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(
  new URL("../src/utils/skillCommands.ts", import.meta.url),
  "utf8"
);
const javascript = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX
  }
 }).outputText;
const { parseSlashDraft, filterCommandSkills, snapshotCommandSkill, mergeMessageSkills, withMessageSkills } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

test("slash completion accepts an initial slash and command name prefixes", () => {
  for (const query of ["", "help", "review-code", "my_command", "speckit.plan", "plugin:review"]) {
    assert.deepEqual(parseSlashDraft(`/${query}`), { query });
  }
});

test("pasted absolute file paths do not activate slash completion", () => {
  for (const draft of [
    "/car_paly/home/",
    "/Users/demo/www/freebuddy/src/App.tsx",
    "/Users/demo/My Documents/notes.md",
    "/tmp/",
    "/etc/hosts",
    "//server/share/report.txt",
    "/Users\\demo\\notes.md",
    "/用户/文档/说明.md",
    '"/Users/demo/notes.md"',
    "file:///Users/demo/notes.md"
  ]) {
    assert.equal(parseSlashDraft(draft), null, draft);
  }
});

test("slash completion ignores ordinary text and commands with arguments", () => {
  for (const draft of ["", "hello", "look at /help", " /help", "/help ", "/review src/App.tsx", "/help\n"]) {
    assert.equal(parseSlashDraft(draft), null, JSON.stringify(draft));
  }
});

const skill = (id, extras = {}) => ({
  id, name: id, description: "", version: "1.0", source: "imported", rootPath: `/skills/${id}`,
  contentHash: id, enabled: true, trusted: true, createdAt: "", updatedAt: "", ...extras
});

test("skill search matches Chinese descriptions and excludes disabled or untrusted skills", () => {
  const records = [skill("code-review", { description: "审查代码，发现问题" }), skill("other"),
    skill("disabled", { description: "审查", enabled: false }), skill("untrusted", { description: "审查", trusted: false })];
  assert.deepEqual(filterCommandSkills(records, "审查").map(s => s.id), ["code-review"]);
});

test("skill search prioritizes name matches, then recent use", () => {
  const records = [skill("a"), skill("b"), skill("review"), skill("review-code"), skill("c", { description: "review code" })];
  assert.deepEqual(filterCommandSkills(records, "", ["b", "a"]).slice(0, 2).map(s => s.id), ["b", "a"]);
  assert.deepEqual(filterCommandSkills(records, "review", ["c"]).map(s => s.id), ["review", "review-code", "c"]);
});

test("message skill selection creates snapshots without persisting enabled/trusted flags", () => {
  const snapshot = snapshotCommandSkill(skill("review"));
  assert.equal(snapshot.id, "review");
  assert.equal("enabled" in snapshot, false);
  assert.equal("trusted" in snapshot, false);
});

test("per-message skill composition preserves defaults and scopes explicit use to this request", () => {
  const defaults = [snapshotCommandSkill(skill("base"))];
  const selected = [snapshotCommandSkill(skill("review"))];
  assert.deepEqual(mergeMessageSkills(defaults, selected).map(s => s.id), ["base", "review"]);
  assert.deepEqual(defaults.map(s => s.id), ["base"]);
  assert.match(withMessageSkills("检查改动", selected), /review/);
  assert.match(withMessageSkills("检查改动", selected), /only to this request/);
  assert.equal(withMessageSkills("普通消息", []), "普通消息");
});

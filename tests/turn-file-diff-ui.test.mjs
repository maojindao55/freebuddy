import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { aggregateFileEdits } from "@freebuddy/cli-stream";
import { agyTurnChanges } from "./fixtures/agy-turn-diff.mjs";
import { codebuddyTurnChanges } from "./fixtures/codebuddy-turn-diff.mjs";
import { claudeTurnBefore, claudeTurnAfter } from "./fixtures/claude-turn-diff.mjs";

const require = createRequire(import.meta.url);
const utils = ts.transpileModule(fs.readFileSync(new URL("../src/utils/fileDiff.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText.replaceAll('"@freebuddy/cli-stream"', JSON.stringify(new URL("../packages/cli-stream/dist/index.js", import.meta.url).href));
const diffUtils = await import(`data:text/javascript;base64,${Buffer.from(utils).toString("base64")}`);
const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/components/CLI/FileChanges.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText;
const edits = [
  { kind: "file-edit", path: "file.ts", action: "update", oldText: "original\n", newText: "temporary\nextra\n" },
  { kind: "file-edit", path: "file.ts", action: "update", oldText: "temporary\nextra\n", newText: "final\n" }
];

function components(selection, extra = {}) {
  const exports = {};
  const state = { counts: {}, selection, ...extra };
  const useFileDiffStore = selector => selector(state);
  vm.runInNewContext(compiled, {
    exports,
    window: {},
    require: name => {
      if (name === "@/utils/fileDiff") return diffUtils;
      if (name === "@/store/fileDiffStore") return { useFileDiffStore };
      if (name === "@/store/conversationStore") return { useConversationStore: selector => selector({ conversations: [], activeId: "conversation" }) };
      if (name === "@/services/cli/client") return { cliClient: {} };
      if (name === "./conversationProjectGrouping") return { conversationWorktreePath: () => undefined };
      if (name === "@/utils/clipboard") return {};
      if (name === "@/components/DocStudio/utils/docFileKinds") return { isOfficeOrDocFile: () => false };
      if (name === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
      if (name === "react-markdown" || name === "remark-gfm") return { default: () => null };
      return require(name);
    }
  });
  return exports;
}

test("file changes stay hidden while running and list each file without computing its diff before opening", () => {
  const { FileChangesCard } = components();
  const props = { items: edits, conversationId: "conversation", messageId: "message" };
  assert.equal(renderToStaticMarkup(createElement(FileChangesCard, { ...props, isRunning: true })), "");
  assert.equal(renderToStaticMarkup(createElement(FileChangesCard, { ...props, storedTaskId: "task" })), "");
  const markup = renderToStaticMarkup(createElement(FileChangesCard, props));
  assert.equal((markup.match(/class="file-change-entry"/g) ?? []).length, 1);
  assert.equal(markup.includes('class="is-add"'), false);
  assert.ok(markup.includes("fileDiff.view"));
  assert.equal(markup.includes("fileDiff.editCount"), false);
});

test("cards update net counts after opening and hide files calculated as unchanged", () => {
  const item = { kind: "file-edit", path: "file.ts", action: "update", turnKey: "turn" };
  const props = { items: [item], conversationId: "conversation", messageId: "message" };
  const calculated = components(undefined, { counts: { turn: { added: 1, removed: 1 } } });
  const markup = renderToStaticMarkup(createElement(calculated.FileChangesCard, props));
  assert.ok(markup.includes('class="is-add">+1<'));
  assert.ok(markup.includes('class="is-delete">−1<'));
  const unchanged = components(undefined, { counts: { turn: { added: 0, removed: 0, unchanged: true } } });
  assert.equal(renderToStaticMarkup(createElement(unchanged.FileChangesCard, props)), "");
});

test("the panel has one file selector and shows the overall diff without a revision picker", () => {
  const { FileDiffPanel } = components({ conversationId: "conversation", messageId: "message", edits: aggregateFileEdits(edits), index: 0 });
  const markup = renderToStaticMarkup(createElement(FileDiffPanel));
  assert.equal((markup.match(/<select/g) ?? []).length, 1);
  assert.equal(markup.includes("fileDiff.record"), false);
  assert.ok(markup.includes("original"));
  assert.ok(markup.includes("final"));
  assert.equal(markup.includes("temporary"), false);
  assert.equal(markup.includes("extra"), false);
});

test("AGY's three disjoint snippet edits display together without an insufficient-content notice", () => {
  const summaries = aggregateFileEdits(agyTurnChanges.map(change => ({ ...change, kind: "file-edit", action: "update" })));
  const { FileDiffPanel } = components({ conversationId: "conversation", messageId: "message", edits: summaries, index: 0 });
  const markup = renderToStaticMarkup(createElement(FileDiffPanel));
  const text = markup.replace(/<[^>]*>/g, "");
  assert.equal(markup.includes("fileDiff.missing"), false);
  assert.ok(text.includes("Star Fighter (Canvas)"));
  assert.ok(text.includes("A lightweight shooting game."));
  assert.ok(text.includes("Open index.html in a browser to start playing."));
  assert.ok(markup.includes('class="is-add">+3<'));
  assert.ok(markup.includes('class="is-delete">−3<'));
});

test("CodeBuddy historical snippets share one reader and explicitly retain snippet-relative line numbers", () => {
  const summaries = aggregateFileEdits(codebuddyTurnChanges.map(change => ({ ...change, kind: "file-edit", action: "update", partial: true })));
  const { FileDiffPanel } = components({ conversationId: "conversation", messageId: "message", edits: summaries, index: 0 });
  const markup = renderToStaticMarkup(createElement(FileDiffPanel));
  const text = markup.replace(/<[^>]*>/g, "");
  assert.equal(markup.includes("fileDiff.missing"), false);
  assert.ok(markup.includes("fileDiff.partial"));
  assert.equal((markup.match(/<select/g) ?? []).length, 1);
  for (const change of codebuddyTurnChanges) assert.ok(text.includes(change.newText));
  assert.ok(markup.includes('class="is-add">+3<'));
  assert.ok(markup.includes('class="is-delete">−3<'));
});

test("Claude's recovered whole-turn document displays all three changes without missing content or synthetic EOF text", () => {
  const summary = { kind: "file-edit", path: "README.md", action: "update", oldText: claudeTurnBefore, newText: claudeTurnAfter };
  const { FileDiffPanel } = components({ conversationId: "conversation", messageId: "message", edits: [summary], index: 0 });
  const markup = renderToStaticMarkup(createElement(FileDiffPanel));
  const text = markup.replace(/<[^>]*>/g, "");
  assert.equal(markup.includes("fileDiff.missing"), false);
  assert.equal(markup.includes("fileDiff.partial"), false);
  assert.equal(text.includes("No newline at end of file"), false);
  assert.ok(text.includes("Star Fighter) DX"));
  assert.ok(text.includes("Chrome / Safari / Edge / Firefox"));
  assert.ok(text.includes("移动端触控支持"));
  assert.ok(markup.includes('class="is-add">+3<'));
  assert.ok(markup.includes('class="is-delete">−3<'));
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";

const compile = path => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText;
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
let source = compile("../src/components/CLI/ComposerWorkspaceMeta.tsx");
const imports = {
  "react": import.meta.resolve("react"),
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
  "lucide-react": import.meta.resolve("lucide-react"),
  "react-i18next": import.meta.resolve("react-i18next"),
  "@/utils/clipboard": asModule(compile("../src/utils/clipboard.ts")),
  "@/utils/projectPaths": asModule(compile("../src/utils/projectPaths.ts")),
  "./conversationProjectGrouping": asModule(compile("../src/components/CLI/conversationProjectGrouping.ts"))
};
for (const [key, value] of Object.entries(imports)) source = source.replaceAll(JSON.stringify(key), JSON.stringify(value));
const { ComposerWorkspaceMeta } = await import(asModule(source));
const conversation = { id: "conv", cwd: "/Users/me/www/freebuddy-main" };
const project = { name: "freebuddy-main", folders: [conversation.cwd], primaryPath: conversation.cwd };
async function render(props = {}, language = "zh-CN") {
  const i18n = createInstance();
  await i18n.init({ lng: language, interpolation: { escapeValue: false }, resources: {
    [language]: { translation: JSON.parse(fs.readFileSync(new URL(`../src/locales/${language}.json`, import.meta.url), "utf8")) }
  } });
  return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(ComposerWorkspaceMeta, { conversation, project, ...props })));
}
const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

test("active branch follows the retained project and directory count in both languages", async () => {
  for (const language of ["zh-CN", "en"]) {
    const html = await render({ gitInfo: { isGitRepository: true, currentBranch: "codex/agent-runtime-metrics", branches: [] } }, language);
    assert.ok(html.indexOf('class="composer-workspace-summary') < html.indexOf('class="composer-branch-info"'));
    assert.match(text(html), /freebuddy-main · 1 (?:个目录|folder) · codex\/agent-runtime-metrics/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /composer-workspace-folder-count/);
  }
});

test("actual worktree branch wins over the recorded starting branch; detached checkout is explicit", async () => {
  const worktree = { ...conversation, cwd: "/Users/me/.worktrees/task-123", sourceCwd: conversation.cwd, metadata: { taskWorkspace: { mode: "worktree", branch: "main" } } };
  const detached = await render({ conversation: worktree, gitInfo: { isGitRepository: true, branches: ["main"] } });
  assert.match(text(detached), /基于 main · Detached HEAD/);
  assert.match(text(detached), /freebuddy-main · 1 个目录 隔离副本/);
  assert.ok(detached.includes(worktree.cwd));
  const attached = await render({ conversation: worktree, gitInfo: { isGitRepository: true, currentBranch: "codex/new-work", branches: [] } });
  assert.match(text(attached), /codex\/new-work/);
  assert.doesNotMatch(text(attached), /Detached HEAD|基于 main/);
  const english = await render({ conversation: worktree, gitInfo: { isGitRepository: true, branches: [] } }, "en");
  assert.match(text(english), /Based on main · Detached HEAD/);
});

test("unavailable and non-Git inspection never turn stored metadata into a current branch", async () => {
  const recorded = { ...conversation, metadata: { taskWorkspace: { mode: "worktree", branch: "stale-branch" } } };
  for (const gitInfo of [undefined, { isGitRepository: false, branches: [] }]) {
    const html = await render({ conversation: recorded, gitInfo });
    assert.doesNotMatch(html, /composer-branch-info|stale-branch|Detached HEAD/);
    assert.match(text(html), /freebuddy-main · 1 个目录/);
  }
  const detached = await render({ gitInfo: { isGitRepository: true, branches: [] } });
  assert.match(text(detached), /Detached HEAD/);
  assert.doesNotMatch(text(detached), /基于/);
});

test("multiple roots and a plain directory remain available without changing project names", async () => {
  const html = await render({ project: { ...project, name: "freebuddy · main", folders: [...project.folders, "/Users/me/www/agy-acp"] } });
  assert.match(text(html), /freebuddy · main · 2 个目录/);
  const single = await render({ project: undefined });
  assert.match(text(single), /freebuddy-main/);
  assert.doesNotMatch(single, /composer-workspace-summary/);
});

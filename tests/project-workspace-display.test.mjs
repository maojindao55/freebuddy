import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

async function loadProjectPaths() {
  const source = read("src/utils/projectPaths.ts");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}

test("project path helpers collapse home and compare case-insensitively", async () => {
  const {
    shortPath,
    formatDisplayPath,
    folderBaseName,
    pathsEqual
  } = await loadProjectPaths();

  assert.equal(shortPath("/Users/me/www/exadmin/src"), "exadmin/src");
  assert.equal(formatDisplayPath("/Users/me/www/51caiji"), "~/www/51caiji");
  assert.equal(formatDisplayPath("C:\\Users\\me\\www\\exadmin"), "~/www/exadmin");
  assert.equal(folderBaseName("/Users/me/www/51caiji/"), "51caiji");
  assert.equal(pathsEqual("C:\\Users\\me\\A", "c:/Users/me/A/"), true);
});

test("composer and workspace panel surface multi-root project mounts", () => {
  const chat = read("src/components/CLI/ChatView.tsx");
  const composer = read("src/components/CLI/ComposerWorkspaceMeta.tsx");
  const panel = read("src/components/CLI/WorkspacePanel.tsx");
  const session = read("src/components/CLI/AgentSessionCard.tsx");
  const styles = read("styles.css");
  const en = JSON.parse(read("src/locales/en.json"));
  const zh = JSON.parse(read("src/locales/zh-CN.json"));

  assert.match(composer, /composer-workspace-summary/);
  assert.match(composer, /composer-workspace-popover/);
  assert.match(composer, /chat\.folderCount/);
  assert.match(session, /workspace\.mountedFolders/);
  assert.match(session, /workspace-mounted-list/);
  assert.match(panel, /folders=\{mountedFolders\}/);
  assert.match(session, /folders\.length > 1/);
  assert.match(chat, /<ComposerWorkspaceMeta/);
  assert.match(styles, /\.composer-workspace-popover\s*\{/);
  assert.match(styles, /\.workspace-mounted-list\s*\{/);

  assert.ok(en.chat.folderCount);
  assert.ok(zh.chat.folderCount);
  assert.ok(en.workspace.mountedFolders);
  assert.ok(zh.workspace.mountedFolders);
  assert.equal(zh.chat.folderCount.includes("目录"), true);
});

test("workspace panel passes the real worktree directory to session details", () => {
  const panel = read("src/components/CLI/WorkspacePanel.tsx");
  const session = read("src/components/CLI/AgentSessionCard.tsx");
  const chat = read("src/components/CLI/ChatView.tsx");
  const grouping = read("src/components/CLI/conversationProjectGrouping.ts");
  const styles = read("styles.css");
  const en = JSON.parse(read("src/locales/en.json"));
  const zh = JSON.parse(read("src/locales/zh-CN.json"));

  assert.match(grouping, /export function conversationWorktreePath/);
  assert.match(panel, /conversationWorktreePath/);
  assert.match(panel, /worktreePath=\{worktreePath\}/);
  assert.match(session, /workspace\.worktree/);
  assert.match(session, /workspace-worktree-row/);
  assert.match(session, /workspace-worktree-copy/);
  assert.match(session, /shortPath\(worktreePath\)/);
  assert.match(chat, /applyNewTaskWorkspace/);
  assert.match(chat, /ensureForCwd/);
  assert.match(chat, /onCwd=\{\(cwd\) => \{\s*void applyNewTaskWorkspace\(cwd\);/);
  assert.match(styles, /\.workspace-worktree-copy\s*\{/);
  assert.doesNotMatch(styles, /\.workspace-worktree-row dd[\s\S]{0,80}word-break:\s*break-all/);

  assert.ok(en.workspace.worktree);
  assert.ok(zh.workspace.worktree);
  assert.ok(en.workspace.copyWorktree);
  assert.ok(zh.workspace.copyWorktree);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const mentionSource = fs.readFileSync(
  new URL("../src/utils/workspaceFileMentions.ts", import.meta.url),
  "utf8"
);
const mentionJavascript = ts.transpileModule(mentionSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const mentions = await import(
  `data:text/javascript;base64,${Buffer.from(mentionJavascript).toString("base64")}`
);

const workspaceFiles = await import(
  new URL("../dist-electron/cli/workspaceFiles.js", import.meta.url)
);

test("mention parser finds inline Chinese file queries but ignores email addresses", () => {
  const draft = "请查看@app";
  assert.deepEqual(mentions.findWorkspaceFileMentionDraft(draft, draft.length), {
    start: 3,
    end: draft.length,
    query: "app"
  });
  assert.equal(
    mentions.findWorkspaceFileMentionDraft("mail a@app.tsx", "mail a@app.tsx".length),
    null
  );
});

test("mention selection replaces only the active token and leaves the prompt otherwise unchanged", () => {
  const draft = "请查看@app 文件有没有 bug";
  const active = mentions.findWorkspaceFileMentionDraft(draft, "请查看@app".length);
  assert.ok(active);
  assert.deepEqual(
    mentions.insertWorkspaceFileMention(draft, active, "src/app.tsx"),
    {
      value: "请查看@src/app.tsx 文件有没有 bug",
      cursor: "请查看@src/app.tsx".length
    }
  );
});

test("message parser highlights file-like mentions without highlighting users or emails", () => {
  assert.deepEqual(
    mentions.splitWorkspaceFileMentions(
      "请查看@src/app.tsx，并通知@alice，邮箱是 a@app.tsx"
    ),
    [
      { kind: "text", value: "请查看" },
      { kind: "mention", value: "@src/app.tsx", path: "src/app.tsx" },
      { kind: "text", value: "，并通知@alice，邮箱是 a@app.tsx" }
    ]
  );
  assert.equal(
    mentions.formatWorkspaceFileMention("src/my app.tsx"),
    '@"src/my app.tsx"'
  );
});

test("workspace file ranking favors exact and basename matches", () => {
  assert.ok(
    workspaceFiles.workspaceFileMatchScore("src/app.tsx", "app.tsx") <
      workspaceFiles.workspaceFileMatchScore("src/components/app-shell.tsx", "app.tsx")
  );
  assert.equal(workspaceFiles.workspaceFileMatchScore("src/app.tsx", "zzz"), null);
});

test("workspace indexing follows git ignore rules and returns relative paths", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-file-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.tsx"), "export default 1;\n");
  fs.writeFileSync(path.join(root, "notes.md"), "notes\n");
  fs.writeFileSync(path.join(root, "node_modules", "app.tsx"), "ignored\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "src/app.tsx"], { cwd: root });

  const results = await workspaceFiles.searchWorkspaceFiles(root, "app", 20);
  assert.deepEqual(results.map((entry) => entry.path), ["src/app.tsx"]);
  assert.equal(results[0].name, "app.tsx");
  assert.equal(results[0].directory, "src");
});

test("renderer and Electron bridge wire mentions without changing attachment prompts", () => {
  const files = {
    chatView: fs.readFileSync(
      new URL("../src/components/CLI/ChatView.tsx", import.meta.url),
      "utf8"
    ),
    messageBubble: fs.readFileSync(
      new URL("../src/components/CLI/MessageBubble.tsx", import.meta.url),
      "utf8"
    ),
    mentionMenu: fs.readFileSync(
      new URL("../src/components/CLI/WorkspaceFileMentionMenu.tsx", import.meta.url),
      "utf8"
    ),
    ipc: fs.readFileSync(new URL("../electron/cli/ipc.ts", import.meta.url), "utf8"),
    preload: fs.readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8"),
    store: fs.readFileSync(
      new URL("../src/store/conversationStore.ts", import.meta.url),
      "utf8"
    ),
    styles: fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  };
  assert.equal((files.chatView.match(/useWorkspaceFileMentions\(\{/g) ?? []).length, 2);
  assert.match(files.messageBubble, /splitWorkspaceFileMentions\(content\)/);
  assert.match(files.mentionMenu, /workspace-file-mention-path">\{match\.path\}/);
  assert.match(files.ipc, /cli:searchWorkspaceFiles/);
  assert.match(files.preload, /cli:searchWorkspaceFiles/);
  assert.doesNotMatch(files.store, /WorkspaceFileMention|workspaceFilePaths/);
  assert.match(
    files.styles,
    /\.workspace-file-mention\s*\{[\s\S]*background:\s*transparent[\s\S]*font-weight:\s*450/
  );
});

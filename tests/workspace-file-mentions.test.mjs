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

test("multi-root search returns absolute paths for insertion and keeps a disambiguated label", async (t) => {
  const primary = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-multi-primary-"));
  const secondary = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-multi-secondary-"));
  t.after(() => {
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(secondary, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(primary, "src"), { recursive: true });
  fs.mkdirSync(path.join(secondary, "lib"), { recursive: true });
  fs.writeFileSync(path.join(primary, "src", "only-primary.ts"), "export {};\n");
  fs.writeFileSync(path.join(secondary, "lib", "secondary-only.ts"), "export {};\n");
  execFileSync("git", ["init", "-q"], { cwd: primary });
  execFileSync("git", ["init", "-q"], { cwd: secondary });
  execFileSync("git", ["add", "src/only-primary.ts"], { cwd: primary });
  execFileSync("git", ["add", "lib/secondary-only.ts"], { cwd: secondary });

  const withoutRoots = await workspaceFiles.searchWorkspaceFiles(primary, "secondary-only", 20);
  assert.deepEqual(withoutRoots, []);

  const withRoots = await workspaceFiles.searchWorkspaceFiles(
    primary,
    "secondary-only",
    20,
    [primary, secondary]
  );
  assert.equal(withRoots.length, 1);
  const secondaryRoot = await fs.promises.realpath(secondary);
  const expectedAbs = path.join(secondaryRoot, "lib", "secondary-only.ts");
  const secondaryLabel = path.basename(secondary);
  assert.equal(withRoots[0].path, expectedAbs);
  assert.equal(withRoots[0].label, `${secondaryLabel}/lib/secondary-only.ts`);
  assert.equal(withRoots[0].name, "secondary-only.ts");
  assert.equal(withRoots[0].directory, "lib");
  assert.equal(withRoots[0].root, secondaryRoot);

  // Absolute insertion paths resolve against multi-root via path guard (basename-prefixed display paths would not).
  const { resolveWithinRoots } = await import(
    new URL("../dist-electron/shared/workspacePathGuard.js", import.meta.url)
  );
  const primaryRoot = await fs.promises.realpath(primary);
  const resolved = resolveWithinRoots(withRoots[0].path, [primaryRoot, secondaryRoot], primaryRoot);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.absolute, path.resolve(expectedAbs));

  const displayStyle = `${secondaryLabel}/lib/secondary-only.ts`;
  const mistaken = resolveWithinRoots(displayStyle, [primaryRoot, secondaryRoot], primaryRoot);
  assert.equal(mistaken.ok, true);
  // Basename-prefixed display paths resolve under Primary, not the secondary file.
  assert.notEqual(mistaken.absolute, path.resolve(expectedAbs));
  assert.ok(mistaken.absolute.startsWith(primaryRoot));

  // Composer insertion uses match.path (absolute), not the UI label.
  // Mentions always normalize separators to `/` for stable parsing across platforms.
  const draft = "请查看@secondary";
  const active = mentions.findWorkspaceFileMentionDraft(draft, draft.length);
  assert.ok(active);
  const inserted = mentions.insertWorkspaceFileMention(draft, active, withRoots[0].path);
  assert.equal(
    inserted.value,
    `请查看${mentions.formatWorkspaceFileMention(withRoots[0].path)}`
  );
  const normalizedAbs = withRoots[0].path.replace(/\\/g, "/");
  assert.ok(inserted.value.includes(normalizedAbs));
  assert.ok(!inserted.value.includes("\\"));
});

test("workspace indexing derives directories from indexed files (git repo)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-dir-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src", "components", "nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "components"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "components", "button.tsx"), "export {};\n");
  fs.writeFileSync(path.join(root, "src", "components", "nested", "deep.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "src", "app.tsx"), "export {};\n");
  fs.writeFileSync(path.join(root, "node_modules", "components", "index.js"), "ignored\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });

  const results = await workspaceFiles.searchWorkspaceFiles(root, "components", 20);
  assert.deepEqual(results[0], {
    path: "src/components/",
    name: "components",
    directory: "src",
    kind: "directory"
  });
  const button = results.find((entry) => entry.path === "src/components/button.tsx");
  assert.equal(button?.kind, "file");
  assert.ok(
    results.every((entry) => !entry.path.startsWith("node_modules")),
    "ignored directories never leak into derived directory results"
  );

  const drilled = await workspaceFiles.searchWorkspaceFiles(root, "src/components/", 20);
  assert.deepEqual(
    drilled.map((entry) => entry.path),
    ["src/components/nested/", "src/components/button.tsx", "src/components/nested/deep.ts"]
  );
});

test("workspace indexing derives directories from the non-git fallback scan", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-dir-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "docs", "guides"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "guides"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guides", "intro.md"), "# intro\n");
  fs.writeFileSync(path.join(root, "node_modules", "guides", "index.js"), "ignored\n");

  const results = await workspaceFiles.searchWorkspaceFiles(root, "guides", 20);
  assert.deepEqual(
    results.map((entry) => entry.path),
    ["docs/guides/", "docs/guides/intro.md"]
  );
  assert.equal(results[0].kind, "directory");
});

test("multi-root search labels directory matches with a trailing slash", async (t) => {
  const primary = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-multi-dir-primary-"));
  const secondary = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-multi-dir-secondary-"));
  t.after(() => {
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(secondary, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(primary, "src"), { recursive: true });
  fs.mkdirSync(path.join(secondary, "lib", "utils"), { recursive: true });
  fs.writeFileSync(path.join(primary, "src", "a.ts"), "export {};\n");
  fs.writeFileSync(path.join(secondary, "lib", "utils", "helper.ts"), "export {};\n");
  execFileSync("git", ["init", "-q"], { cwd: primary });
  execFileSync("git", ["init", "-q"], { cwd: secondary });

  const results = await workspaceFiles.searchWorkspaceFiles(primary, "utils", 20, [
    primary,
    secondary
  ]);
  const secondaryRoot = await fs.promises.realpath(secondary);
  assert.deepEqual(results[0], {
    path: `${path.join(secondaryRoot, "lib", "utils")}/`,
    name: "utils",
    directory: "lib",
    kind: "directory",
    root: secondaryRoot,
    label: `${path.basename(secondary)}/lib/utils/`
  });
});

test("mention parser highlights directory mentions and formats drill-down drafts", () => {
  assert.deepEqual(mentions.splitWorkspaceFileMentions("看下@src/components/ 目录"), [
    { kind: "text", value: "看下" },
    { kind: "mention", value: "@src/components/", path: "src/components/" },
    { kind: "text", value: " 目录" }
  ]);
  assert.deepEqual(mentions.splitWorkspaceFileMentions("@/ 不是路径"), [
    { kind: "text", value: "@/ 不是路径" }
  ]);
  assert.equal(
    mentions.formatWorkspaceFileMention("src/my dir/"),
    '@"src/my dir/"'
  );

  const draft = "看@comp";
  const active = mentions.findWorkspaceFileMentionDraft(draft, 6);
  assert.ok(active);
  const inserted = mentions.insertWorkspaceFileMention(draft, active, "src/components/");
  assert.deepEqual(inserted, {
    value: "看@src/components/",
    cursor: "看@src/components/".length
  });
  assert.deepEqual(
    mentions.findWorkspaceFileMentionDraft(inserted.value, inserted.cursor),
    { start: 1, end: inserted.value.length, query: "src/components/" }
  );
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
    mentionHook: fs.readFileSync(
      new URL("../src/hooks/useWorkspaceFileMentions.ts", import.meta.url),
      "utf8"
    ),
    ipc: fs.readFileSync(new URL("../electron/cli/ipc.ts", import.meta.url), "utf8"),
    preload: fs.readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8"),
    store: fs.readFileSync(
      new URL("../src/store/conversationStore.ts", import.meta.url),
      "utf8"
    ),
    styles: fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8"),
    webPreload: fs.readFileSync(new URL("../public/web-preload.js", import.meta.url), "utf8")
  };
  assert.equal((files.chatView.match(/useWorkspaceFileMentions\(\{/g) ?? []).length, 2);
  assert.match(files.chatView, /roots:\s*conversationMentionRoots/);
  assert.match(files.chatView, /roots:\s*workspaceRoots/);
  assert.match(files.mentionHook, /searchWorkspaceFiles\(cwd, activeMention\.query, 24, searchRoots\)/);
  assert.match(files.mentionHook, /selectMatch\(selected, \{ drillDown: event\.key === "Tab" \}\)/);
  assert.match(files.mentionMenu, /match\.kind === "directory"/);
  assert.match(files.webPreload, /roots: roots/);
  assert.match(files.messageBubble, /splitPluginMentions\(content\)/);
  assert.match(files.messageBubble, /splitWorkspaceFileMentions\(segment\.value\)/);
  assert.match(
    files.mentionMenu,
    /workspace-file-mention-path">\{match\.label \?\? match\.path\}/
  );
  assert.match(files.ipc, /cli:searchWorkspaceFiles/);
  assert.match(files.ipc, /return searchWorkspaceFiles\(cwd, query, limit, roots\)/);
  assert.match(files.preload, /cli:searchWorkspaceFiles/);
  assert.match(files.preload, /\{ cwd, query, limit, roots \}/);
  assert.doesNotMatch(files.store, /WorkspaceFileMention|workspaceFilePaths/);
  assert.match(
    files.styles,
    /\.workspace-file-mention\s*\{[\s\S]*background:\s*transparent[\s\S]*font-weight:\s*450/
  );
});

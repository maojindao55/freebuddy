import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const HOME = path.resolve("/Users/me");
const ROOT_AB = path.resolve("/a/b");
const ROOT_CD = path.resolve("/c/d");
const ROOT_X = path.resolve("/x");

async function loadWorkspaceRoots() {
  const source = fs.readFileSync(
    new URL("../electron/shared/workspaceRoots.ts", import.meta.url),
    "utf8"
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
  );
}

test("resolveWorkspaceRoots defaults to homedir and dedups/normalizes", async () => {
  const { resolveWorkspaceRoots } = await loadWorkspaceRoots();

  assert.deepEqual(resolveWorkspaceRoots(undefined, HOME), [HOME]);
  assert.deepEqual(resolveWorkspaceRoots([], HOME), [HOME]);
  assert.deepEqual(
    resolveWorkspaceRoots(["/a/b", "/a/b", " /c/d ", "", null, 5], HOME),
    [ROOT_AB, ROOT_CD],
    "trims, dedups, drops invalid entries"
  );
});

test("normalizeRoot expands ~ and maps bare /home to the real homedir on darwin", async () => {
  const { normalizeRoot } = await loadWorkspaceRoots();

  assert.equal(normalizeRoot("~", HOME), HOME);
  assert.equal(normalizeRoot("~/Projects", HOME), path.join(HOME, "Projects"));
  if (process.platform === "darwin") {
    assert.equal(
      normalizeRoot("/home", HOME),
      HOME,
      "macOS /home is not the user home directory"
    );
  }
});

test("isPathWithinRoots allows exact root and nested children only", async () => {
  const { isPathWithinRoots } = await loadWorkspaceRoots();

  assert.ok(isPathWithinRoots(ROOT_AB, [ROOT_AB]), "exact root allowed");
  assert.ok(isPathWithinRoots(path.join(ROOT_AB, "c"), [ROOT_AB]), "nested child allowed");
  assert.ok(
    !isPathWithinRoots(path.resolve("/a/bb"), [ROOT_AB]),
    "sibling prefix without separator must be rejected"
  );
  assert.ok(!isPathWithinRoots(path.resolve("/a/other"), [ROOT_AB]), "sibling dir rejected");
  assert.ok(!isPathWithinRoots(ROOT_X, [ROOT_AB]), "unrelated path rejected");
  assert.ok(isPathWithinRoots(ROOT_AB, [ROOT_X, ROOT_AB]), "matches one of several roots");
});

test("parentWithinRoots clamps at the root boundary", async () => {
  const { parentWithinRoots } = await loadWorkspaceRoots();

  assert.equal(parentWithinRoots(path.join(ROOT_AB, "c"), [ROOT_AB]), ROOT_AB);
  assert.equal(parentWithinRoots(ROOT_AB, [ROOT_AB]), null, "no parent above root");
  assert.equal(parentWithinRoots(path.join(ROOT_X, "y"), [ROOT_AB]), null, "outside roots");
});

test("isPathWithinRoots resolves symlinks before checking containment", async (t) => {
  const { isPathWithinRoots } = await loadWorkspaceRoots();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-roots-"));
  const root = path.join(temp, "root");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, path.join(root, "escape"));
  } catch (error) {
    if (error.code === "EPERM") {
      fs.rmSync(temp, { recursive: true, force: true });
      t.skip("symlinks require admin/Developer Mode on Windows");
      return;
    }
    throw error;
  }
  try {
    assert.equal(
      isPathWithinRoots(path.join(root, "escape", "secret.txt"), [root]),
      false,
      "a symlink inside an allowed root must not expose an outside target"
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("webUIServer exposes an authed, sandboxed /api/listDirs endpoint", () => {
  const server = fs.readFileSync(
    new URL("../electron/webUIServer.ts", import.meta.url),
    "utf8"
  );

  assert.match(server, /\/api\/listDirs/, "must register the /api/listDirs route");
  const block = server.slice(server.indexOf("/api/listDirs"));
  assert.match(block, /isAuthed\(req\)/, "must require auth");
  assert.match(block, /isPathWithinRoots/, "must enforce allowlist containment");
  assert.match(
    block,
    /remoteSourceRootsForUser\(callerUserId\)/,
    "must resolve roots for the calling user, not globally"
  );
  assert.match(
    block,
    /roots\.length === 0/,
    "a user with no assigned roots must browse nothing"
  );
  assert.match(block, /path\.resolve/, "must normalize the requested path");
  assert.match(block, /dirent\.isDirectory\(\)/, "must list directories only");
  assert.match(
    server,
    /handleListDirs\(req,\s*res\)/,
    "must dispatch to handleListDirs"
  );
});

test("webUIServer serves workspace files via /api/attachment and /api/draft-render", () => {
  const server = fs.readFileSync(
    new URL("../electron/webUIServer.ts", import.meta.url),
    "utf8"
  );
  const attachment = server.slice(server.indexOf("function handleAttachment"));
  const attachmentBlock = attachment.slice(0, attachment.indexOf("async function handleUpload"));

  assert.match(attachmentBlock, /canServeAttachmentPath/);
  assert.match(attachmentBlock, /remoteRootsForUser/);
  assert.match(server, /\/api\/draft-render/);
  assert.match(server, /handleDraftRender/);
  assert.match(server, /handleDraftRequest/);
});

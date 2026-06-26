import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

async function loadDraftModule() {
  const source = fs.readFileSync(
    new URL("../electron/draftProtocol.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function buildDraftUrl(root, rel) {
  const pathPart = rel ? `/${rel}` : "/";
  return `freebuddy-draft://render${pathPart}?root=${encodeURIComponent(root)}`;
}

test("parseDraftUrl resolves root and relative path", async () => {
  const { parseDraftUrl } = await loadDraftModule();
  const { root, rel } = parseDraftUrl(
    buildDraftUrl(path.resolve("/tmp/demo"), "dist/index.html")
  );
  assert.equal(root, path.resolve("/tmp/demo"));
  assert.equal(rel, "dist/index.html");
});

test("handleDraftRequest serves index.html with text/html mime", async () => {
  const { handleDraftRequest } = await loadDraftModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>hello</h1>");

  const response = await handleDraftRequest(
    new Request(buildDraftUrl(dir, "index.html"))
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/);
  const body = await response.text();
  assert.equal(body, "<h1>hello</h1>");
});

test("handleDraftRequest auto-appends index.html for directory request", async () => {
  const { handleDraftRequest } = await loadDraftModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<p>dir</p>");

  const response = await handleDraftRequest(new Request(buildDraftUrl(dir, "")));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<p>dir</p>");
});

test("handleDraftRequest returns 404 for missing file", async () => {
  const { handleDraftRequest } = await loadDraftModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-"));

  const response = await handleDraftRequest(
    new Request(buildDraftUrl(dir, "nope.html"))
  );
  assert.equal(response.status, 404);
});

test("isWithinRoot confines access to the root subtree", async () => {
  const { isWithinRoot } = await loadDraftModule();
  const root = path.resolve(os.tmpdir(), "draft-root");
  assert.equal(isWithinRoot(path.join(root, "index.html"), root), true);
  assert.equal(isWithinRoot(path.join(root, "sub", "a.css"), root), true);
  assert.equal(isWithinRoot(root, root), true);
  assert.equal(
    isWithinRoot(path.join(path.dirname(root), "outside.html"), root),
    false
  );
});

test("handleDraftRequest neutralizes encoded dot-segment traversal", async () => {
  const { handleDraftRequest } = await loadDraftModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-"));
  const outside = path.join(path.dirname(dir), "draft-outside-secret.txt");
  fs.writeFileSync(outside, "secret");

  try {
    // The WHATWG URL parser collapses ".." (even when %2e%2e-encoded), so the
    // request is resolved inside root where no such file exists. The outside
    // file must never be served.
    const url = `freebuddy-draft://render/%2e%2e/${path.basename(outside)}?root=${encodeURIComponent(dir)}`;
    const response = await handleDraftRequest(new Request(url));
    assert.notEqual(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes("secret"), false);
  } finally {
    fs.unlinkSync(outside);
  }
});

test("resolveDraftEntry finds index.html and returns null when absent", async () => {
  const { resolveDraftEntry } = await loadDraftModule();

  const withEntry = fs.mkdtempSync(path.join(os.tmpdir(), "draft-"));
  fs.writeFileSync(path.join(withEntry, "index.html"), "<p>x</p>");
  assert.equal(await resolveDraftEntry(withEntry), "index.html");

  const distOnly = fs.mkdtempSync(path.join(os.tmpdir(), "draft-"));
  fs.mkdirSync(path.join(distOnly, "dist"));
  fs.writeFileSync(path.join(distOnly, "dist", "index.html"), "<p>x</p>");
  assert.equal(await resolveDraftEntry(distOnly), "dist/index.html");

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "draft-"));
  assert.equal(await resolveDraftEntry(empty), null);

  assert.equal(await resolveDraftEntry(""), null);
});

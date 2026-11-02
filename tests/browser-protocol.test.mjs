import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

async function loadBrowserModule() {
  const source = fs.readFileSync(
    new URL("../electron/browserProtocol.ts", import.meta.url),
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

function buildBrowserUrl(root, rel) {
  const pathPart = rel ? `/${rel}` : "/";
  return `freebuddy-browser://render${pathPart}?root=${encodeURIComponent(root)}`;
}

function buildEmbeddedRootBrowserUrl(root, rel) {
  const encodedRoot = encodeURIComponent(root);
  const encodedRel = rel.split("/").map(encodeURIComponent).join("/");
  return `freebuddy-browser://render/${encodedRoot}/${encodedRel}`;
}

test("parseBrowserUrl resolves root embedded in path", async () => {
  const { parseBrowserUrl } = await loadBrowserModule();
  const rootPath = path.resolve("/tmp/demo app");
  const { root, rel } = parseBrowserUrl(
    buildEmbeddedRootBrowserUrl(rootPath, "docs/sample.pdf")
  );
  assert.equal(root, rootPath);
  assert.equal(rel, "docs/sample.pdf");
});

test("parseBrowserUrl resolves root and relative path", async () => {
  const { parseBrowserUrl } = await loadBrowserModule();
  const { root, rel } = parseBrowserUrl(
    buildBrowserUrl(path.resolve("/tmp/demo"), "dist/index.html")
  );
  assert.equal(root, path.resolve("/tmp/demo"));
  assert.equal(rel, "dist/index.html");
});

test("handleBrowserRequest serves index.html with text/html mime", async () => {
  const { handleBrowserRequest } = await loadBrowserModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>hello</h1>");

  const response = await handleBrowserRequest(
    new Request(buildBrowserUrl(dir, "index.html"))
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/);
  const body = await response.text();
  assert.equal(body, "<h1>hello</h1>");
});

test("handleBrowserRequest serves pdf with application/pdf mime", async () => {
  const { handleBrowserRequest } = await loadBrowserModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  fs.writeFileSync(path.join(dir, "sample.pdf"), Buffer.from("%PDF-1.4"));

  const response = await handleBrowserRequest(
    new Request(buildEmbeddedRootBrowserUrl(dir, "sample.pdf"))
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/pdf");
});

test("handleBrowserRequest auto-appends index.html for directory request", async () => {
  const { handleBrowserRequest } = await loadBrowserModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<p>dir</p>");

  const response = await handleBrowserRequest(new Request(buildBrowserUrl(dir, "")));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<p>dir</p>");
});

test("handleBrowserRequest returns 404 for missing file", async () => {
  const { handleBrowserRequest } = await loadBrowserModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));

  const response = await handleBrowserRequest(
    new Request(buildBrowserUrl(dir, "nope.html"))
  );
  assert.equal(response.status, 404);
});

test("isWithinRoot confines access to the root subtree", async () => {
  const { isWithinRoot } = await loadBrowserModule();
  const root = path.resolve(os.tmpdir(), "browser-root");
  assert.equal(isWithinRoot(path.join(root, "index.html"), root), true);
  assert.equal(isWithinRoot(path.join(root, "sub", "a.css"), root), true);
  assert.equal(isWithinRoot(root, root), true);
  assert.equal(
    isWithinRoot(path.join(path.dirname(root), "outside.html"), root),
    false
  );
});

test("handleBrowserRequest neutralizes encoded dot-segment traversal", async () => {
  const { handleBrowserRequest } = await loadBrowserModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  const outside = path.join(path.dirname(dir), "browser-outside-secret.txt");
  fs.writeFileSync(outside, "secret");

  try {
    const url = `freebuddy-browser://render/%2e%2e/${path.basename(outside)}?root=${encodeURIComponent(dir)}`;
    const response = await handleBrowserRequest(new Request(url));
    assert.notEqual(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes("secret"), false);
  } finally {
    fs.unlinkSync(outside);
  }
});

test("resolveBrowserEntry finds index.html and returns null when absent", async () => {
  const { resolveBrowserEntry } = await loadBrowserModule();

  const withEntry = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  fs.writeFileSync(path.join(withEntry, "index.html"), "<p>x</p>");
  assert.equal(await resolveBrowserEntry(withEntry), "index.html");

  const distOnly = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  fs.mkdirSync(path.join(distOnly, "dist"));
  fs.writeFileSync(path.join(distOnly, "dist", "index.html"), "<p>x</p>");
  assert.equal(await resolveBrowserEntry(distOnly), "dist/index.html");

  const outOnly = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  fs.mkdirSync(path.join(outOnly, "out"));
  fs.writeFileSync(path.join(outOnly, "out", "index.html"), "<p>x</p>");
  assert.equal(await resolveBrowserEntry(outOnly), "out/index.html");

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  assert.equal(await resolveBrowserEntry(empty), null);

  assert.equal(await resolveBrowserEntry(""), null);
});

test("resolveBrowserEntry discovers package framework and html candidates", async () => {
  const { resolveBrowserEntry } = await loadBrowserModule();

  const nextApp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  fs.writeFileSync(
    path.join(nextApp, "package.json"),
    JSON.stringify({ dependencies: { next: "latest" } })
  );
  fs.mkdirSync(path.join(nextApp, "out"));
  fs.writeFileSync(path.join(nextApp, "out", "index.html"), "<p>next</p>");
  assert.equal(await resolveBrowserEntry(nextApp), "out/index.html");

  const htmlOnly = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  fs.mkdirSync(path.join(htmlOnly, "public"));
  fs.writeFileSync(path.join(htmlOnly, "public", "demo.html"), "<p>demo</p>");
  assert.equal(await resolveBrowserEntry(htmlOnly), "public/demo.html");
});

test("readBrowserMarkdown reads workspace text documents and blocks invalid paths", async () => {
  const { readBrowserMarkdown } = await loadBrowserModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  fs.writeFileSync(path.join(dir, "README.md"), "# Hello");
  fs.writeFileSync(path.join(dir, "data.json"), "{\"ok\":true}");
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
  fs.writeFileSync(path.join(dir, "Comm_Upload.php"), "<?php echo 1;");
  fs.writeFileSync(path.join(dir, "index.ts"), "export const x = 1;");
  fs.writeFileSync(path.join(dir, "index.html"), "<p>x</p>");

  assert.equal(await readBrowserMarkdown(dir, "README.md"), "# Hello");
  assert.equal(await readBrowserMarkdown(dir, "data.json"), "{\"ok\":true}");
  assert.equal(await readBrowserMarkdown(dir, "notes.txt"), "hello");
  assert.equal(await readBrowserMarkdown(dir, "Comm_Upload.php#L45-L60"), "<?php echo 1;");
  assert.equal(await readBrowserMarkdown(dir, "index.ts:10:2"), "export const x = 1;");
  assert.equal(await readBrowserMarkdown(dir, "index.html"), null);
  assert.equal(await readBrowserMarkdown(dir, "../README.md"), null);
  assert.equal(await readBrowserMarkdown("", "README.md"), null);
});

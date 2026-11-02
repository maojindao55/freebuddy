import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

async function loadReleaseNotesModule() {
  const output = ts.transpileModule(read("../src/utils/releaseNotes.ts"), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("formatReleaseNotes accepts GitHub feed strings and release note arrays", async () => {
  const { formatReleaseNotes } = await loadReleaseNotesModule();

  assert.equal(formatReleaseNotes("<h3>新功能</h3><p>notes</p>"), "<h3>新功能</h3><p>notes</p>");
  assert.equal(
    formatReleaseNotes([{ note: "### 新功能\n- one" }, { note: "### 修复\n- two" }]),
    "### 新功能\n- one\n\n### 修复\n- two"
  );
  assert.equal(formatReleaseNotes([{ note: "" }]), null);
});

test("isReleaseNotesHtml distinguishes Atom HTML from markdown", async () => {
  const { isReleaseNotesHtml } = await loadReleaseNotesModule();

  assert.equal(isReleaseNotesHtml("<h3>新功能</h3><ul><li>x</li></ul>"), true);
  assert.equal(isReleaseNotesHtml("### 新功能\n\n- x"), false);
});

test("release note HTML is rendered through a sanitizing allowlist", () => {
  const source = read("../src/utils/releaseNotes.ts");
  const aboutTab = read("../src/components/Settings/AboutTab.tsx");

  assert.match(source, /new DOMParser\(\)/);
  assert.match(source, /ALLOWED_TAGS/);
  assert.match(source, /DROP_TAGS/);
  assert.match(source, /"script"/);
  assert.match(source, /name\.startsWith\("on"\)/);
  assert.match(source, /target\.setAttribute\("target", "_blank"\)/);
  assert.match(source, /target\.setAttribute\("rel", "noreferrer noopener"\)/);
  assert.match(aboutTab, /sanitizeReleaseNotesHtml\(notesText\)/);
  assert.match(aboutTab, /dangerouslySetInnerHTML=\{\{ __html: notesHtml \}\}/);
  assert.match(aboutTab, /<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\}>/);
});

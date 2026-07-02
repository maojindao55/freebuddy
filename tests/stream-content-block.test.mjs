import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const streamItemSource = fs.readFileSync(
  new URL("../src/components/CLI/StreamItem.tsx", import.meta.url),
  "utf8"
);
const stylesSource = fs.readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8"
);

test("StreamItem renders ACP content-block variants", () => {
  assert.match(streamItemSource, /case "content-block":/);
  assert.match(streamItemSource, /function StreamContentBlock/);
  assert.match(streamItemSource, /case "image":/);
  assert.match(streamItemSource, /case "audio":/);
  assert.match(streamItemSource, /case "resource_link":/);
  assert.match(streamItemSource, /case "resource":/);
});

test("MarkdownText supports links and blockquotes", () => {
  assert.match(streamItemSource, /\[[^\]]+\]\([^)]+\)/);
  assert.match(streamItemSource, /markdown-blockquote/);
  assert.match(streamItemSource, /resolveLinkHref/);
});

test("styles include content-block and markdown quote rules", () => {
  assert.match(stylesSource, /\.markdown-blockquote\b/);
  assert.match(stylesSource, /\.stream-content-block\b/);
  assert.match(stylesSource, /\.stream-audio\b/);
  assert.match(stylesSource, /\.markdown-body a\b/);
});

test("tool invocation rows avoid disclosure arrows", () => {
  assert.match(streamItemSource, /case "thinking":[\s\S]*<ToolKindIcon toolKind="think" \/>/);
  assert.match(stylesSource, /\.stream-thinking summary::-webkit-details-marker/);
  assert.match(stylesSource, /\.stream-tool-result summary::-webkit-details-marker/);
  assert.match(stylesSource, /\.stream-file-edit summary::-webkit-details-marker/);
  assert.match(stylesSource, /\.stream-tool-invocation summary::marker/);
  assert.match(stylesSource, /\.stream-tool-invocation\.has-body > summary/);
  assert.match(stylesSource, /\.stream-tool-invocation\.has-body > summary:hover/);
  assert.match(stylesSource, /\.stream-thinking > summary:hover/);
  assert.match(stylesSource, /\.stream-tool-body\s*\{[\s\S]*border-left:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.22\)/);
  assert.match(stylesSource, /\.stream-thinking \.markdown-body\s*\{[\s\S]*border-left:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.22\)/);
  assert.doesNotMatch(stylesSource, /\.stream-thinking summary::before/);
  assert.doesNotMatch(stylesSource, /\.stream-thinking\[open\] summary::before/);
  assert.doesNotMatch(stylesSource, /\.stream-tool-invocation summary::before/);
  assert.doesNotMatch(stylesSource, /\.stream-tool-invocation\.has-body summary::after/);
  assert.doesNotMatch(stylesSource, /\.stream-tool-invocation\.has-body\[open\] summary::after/);
});

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

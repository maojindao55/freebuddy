import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildStepPath, niceMaximum, renderSvg } from "../scripts/generate-star-history.mjs";

test("star history uses a readable rounded y-axis maximum", () => {
  assert.equal(niceMaximum(7), 10);
  assert.equal(niceMaximum(93), 100);
  assert.equal(niceMaximum(234), 250);
});

test("star history path grows one step per star", () => {
  const paths = buildStepPath([25, 75], 0, 100, 10, {
    left: 0,
    top: 0,
    width: 100,
    height: 100
  });
  assert.match(paths.line, /^M 0\.00 100\.00 H 25\.00 V 90\.00 H 75\.00 V 80\.00 H 100\.00$/);
});

test("rendered chart includes an accessible title and curve", () => {
  const svg = renderSvg({
    createdAt: "2026-01-01T00:00:00Z",
    generatedAt: "2026-01-03T00:00:00Z",
    timestamps: [
      new Date("2026-01-02T00:00:00Z").getTime(),
      new Date("2026-01-03T00:00:00Z").getTime()
    ]
  });
  assert.match(svg, /FreeBuddy Star History/);
  assert.match(svg, /class="star-line"/);
  assert.match(svg, /2 stars · Updated 2026-01-03/);
});

test("readmes embed the generated star history curve", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const readmeZh = fs.readFileSync(new URL("../README.zh-CN.md", import.meta.url), "utf8");
  assert.match(readme, /assets\/star-history\.svg/);
  assert.match(readmeZh, /assets\/star-history\.svg/);
});

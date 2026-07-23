import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadAutolink() {
  const source = fs.readFileSync(
    new URL("../src/utils/autolink.ts", import.meta.url),
    "utf8"
  );
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

test("splitAutolinkSegments detects bare https URLs", async () => {
  const { splitAutolinkSegments } = await loadAutolink();
  assert.deepEqual(
    splitAutolinkSegments(
      "PR 已创建：https://github.com/maojindao55/freebuddy/pull/74"
    ),
    [
      { kind: "text", value: "PR 已创建：" },
      {
        kind: "link",
        value: "https://github.com/maojindao55/freebuddy/pull/74",
        href: "https://github.com/maojindao55/freebuddy/pull/74"
      }
    ]
  );
});

test("splitAutolinkSegments strips trailing punctuation", async () => {
  const { splitAutolinkSegments } = await loadAutolink();
  assert.deepEqual(splitAutolinkSegments("see https://example.com/path."), [
    { kind: "text", value: "see " },
    {
      kind: "link",
      value: "https://example.com/path",
      href: "https://example.com/path"
    },
    { kind: "text", value: "." }
  ]);
});

test("splitAutolinkSegments keeps balanced parentheses in URLs", async () => {
  const { splitAutolinkSegments } = await loadAutolink();
  assert.deepEqual(
    splitAutolinkSegments("https://en.wikipedia.org/wiki/Foo_(bar)"),
    [
      {
        kind: "link",
        value: "https://en.wikipedia.org/wiki/Foo_(bar)",
        href: "https://en.wikipedia.org/wiki/Foo_(bar)"
      }
    ]
  );
});

test("splitAutolinkSegments returns plain text when no URL", async () => {
  const { splitAutolinkSegments } = await loadAutolink();
  assert.deepEqual(splitAutolinkSegments("no links here"), [
    { kind: "text", value: "no links here" }
  ]);
});

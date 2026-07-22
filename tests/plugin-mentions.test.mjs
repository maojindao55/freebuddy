import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(
  new URL("../src/utils/pluginMentions.ts", import.meta.url),
  "utf8"
);
const javascript = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const mentions = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

test("plugin references are split from surrounding prompt text", () => {
  assert.deepEqual(
    mentions.splitPluginMentions(
      "请用 [@product-design](plugin://product-design@openai-curated-remote) 优化页面"
    ),
    [
      { kind: "text", value: "请用 " },
      {
        kind: "plugin",
        value: "[@product-design](plugin://product-design@openai-curated-remote)",
        name: "product-design",
        uri: "plugin://product-design@openai-curated-remote"
      },
      { kind: "text", value: " 优化页面" }
    ]
  );
});

test("plain markdown and malformed plugin references remain unchanged", () => {
  const value = "打开 [Browser](https://example.com) 和 [@browser](plugin://bad uri)";
  assert.deepEqual(mentions.splitPluginMentions(value), [{ kind: "text", value }]);
});

test("plugin slugs receive readable display names", () => {
  assert.equal(mentions.pluginDisplayName("product-design"), "Product Design");
  assert.equal(mentions.pluginDisplayName("spreadsheets"), "Spreadsheets");
});

test("Browser references receive FreeBuddy ACP host compatibility guidance", () => {
  const prompt = "[@browser](plugin://browser@openai-bundled) 打开百度";
  const compatible = mentions.addPluginHostCompatibility(prompt, "codex-acp");
  assert.match(compatible, /freebuddy-browser MCP server/);
  assert.match(compatible, /browser_open/);
  assert.match(compatible, /visible=true/);
  assert.equal(mentions.addPluginHostCompatibility(prompt, "opencode-acp"), prompt);
  assert.equal(
    mentions.addPluginHostCompatibility("直接打开百度", "codex-acp"),
    "直接打开百度"
  );
});

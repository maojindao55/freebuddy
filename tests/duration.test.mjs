import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadModule() {
  const source = fs.readFileSync(
    new URL("../src/utils/duration.ts", import.meta.url),
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

test("formatDuration formats milliseconds into a compact human duration", async () => {
  const { formatDuration } = await loadModule();

  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(500), "0s");
  assert.equal(formatDuration(59_000), "59s");
  assert.equal(formatDuration(60_000), "1m 0s");
  assert.equal(formatDuration(125_000), "2m 5s");
  assert.equal(formatDuration(3_661_000), "1h 1m");
});

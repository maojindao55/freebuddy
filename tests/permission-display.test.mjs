import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadModule() {
  const source = fs.readFileSync(
    new URL("../src/utils/permissionDisplay.ts", import.meta.url),
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

test("actionKeyFor maps known tool titles/kinds to locale keys (case-insensitive)", async () => {
  const { actionKeyFor } = await loadModule();
  assert.equal(actionKeyFor("external_directory", "other"), "permission.action.externalDirectory");
  assert.equal(actionKeyFor("Edit", undefined), "permission.action.edit");
  assert.equal(actionKeyFor(undefined, "execute"), "permission.action.command");
  assert.equal(actionKeyFor("bash", undefined), "permission.action.command");
  assert.equal(actionKeyFor("web_search", undefined), "permission.action.search");
  assert.equal(actionKeyFor("weird_unknown_tool", "other"), null);
  assert.equal(actionKeyFor(undefined, undefined), null);
});

test("permissionTargets extracts deduped paths from locations, falling back to rawInput", async () => {
  const { permissionTargets } = await loadModule();

  const fromLocations = permissionTargets({
    locations: [
      { path: "/a/b.png" },
      { path: "/a/b.png" },
      { path: "/a" }
    ]
  });
  assert.deepEqual(fromLocations, ["/a/b.png", "/a"]);

  const fromRawInput = permissionTargets({
    rawInput: { filepath: "/x/y.txt", parentDir: "/x" }
  });
  assert.deepEqual(fromRawInput, ["/x/y.txt", "/x"]);

  assert.deepEqual(permissionTargets(undefined), []);
  assert.deepEqual(permissionTargets({ locations: [] }), []);
});

test("optionKeyFor maps standardized ACP option kinds to locale keys", async () => {
  const { optionKeyFor } = await loadModule();
  assert.equal(optionKeyFor("allow_once"), "permission.allowOnce");
  assert.equal(optionKeyFor("allow_always"), "permission.allowAlways");
  assert.equal(optionKeyFor("reject_once"), "permission.reject");
  assert.equal(optionKeyFor(undefined), null);
  assert.equal(optionKeyFor("something_else"), null);
});

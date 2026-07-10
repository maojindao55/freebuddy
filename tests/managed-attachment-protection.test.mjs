import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadProtectionModule() {
  const source = fs.readFileSync(
    new URL("../src/utils/managedAttachmentProtection.ts", import.meta.url),
    "utf8"
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const attachment = (path) => ({
  id: "att-1",
  kind: "image",
  name: "shot.png",
  path,
  managed: true
});

test("managed attachment protection uses reference counting", async () => {
  const {
    protectManagedAttachments,
    unprotectManagedAttachments,
    isManagedAttachmentPathProtected,
    resetManagedAttachmentProtectionForTests
  } = await loadProtectionModule();

  resetManagedAttachmentProtectionForTests();
  const files = [attachment("/tmp/managed/a.png")];

  protectManagedAttachments(files);
  protectManagedAttachments(files);
  assert.equal(isManagedAttachmentPathProtected("/tmp/managed/a.png"), true);

  unprotectManagedAttachments(files);
  assert.equal(isManagedAttachmentPathProtected("/tmp/managed/a.png"), true);

  unprotectManagedAttachments(files);
  assert.equal(isManagedAttachmentPathProtected("/tmp/managed/a.png"), false);
});

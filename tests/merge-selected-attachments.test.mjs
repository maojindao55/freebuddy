import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadMergeModule() {
  const chatAttachmentsSource = fs.readFileSync(
    new URL("../src/utils/chatAttachments.ts", import.meta.url),
    "utf8"
  );
  const mergeSource = fs.readFileSync(
    new URL("../src/utils/mergeSelectedAttachments.ts", import.meta.url),
    "utf8"
  );
  const combined = `${chatAttachmentsSource.replace(
    /^import i18next from "i18next";\s*$/m,
    ""
  )}\n${mergeSource.replace(
    /import \{[\s\S]*?\} from "\.\/chatAttachments";\s*/m,
    ""
  )}`;
  const transpiled = ts.transpileModule(combined, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const validCandidate = (path, extra = {}) => ({
  path,
  name: path.split("/").pop(),
  size: 1024,
  ...extra
});

const currentNine = Array.from({ length: 9 }, (_, index) => ({
  id: `att-${index}`,
  kind: "image",
  name: `existing-${index}.png`,
  path: `/tmp/existing-${index}.png`,
  mimeType: "image/png",
  extension: "png"
}));

test("mergeSelectedAttachments adds new file without limit warning when next item is duplicate", async () => {
  const { mergeSelectedAttachments } = await loadMergeModule();
  const duplicatePath = "/tmp/existing-0.png";

  const result = mergeSelectedAttachments(currentNine, [
    validCandidate("/tmp/new.png"),
    validCandidate(duplicatePath)
  ]);

  assert.equal(result.attachments.length, 10);
  assert.equal(result.attachments.at(-1)?.path, "/tmp/new.png");
  assert.equal(result.overflow, false);
  assert.deepEqual(result.warnings, []);
});

test("mergeSelectedAttachments reports overflow only for unique valid candidates", async () => {
  const { mergeSelectedAttachments } = await loadMergeModule();

  const result = mergeSelectedAttachments(currentNine, [
    validCandidate("/tmp/new-a.png"),
    validCandidate("/tmp/new-b.png")
  ]);

  assert.equal(result.attachments.length, 10);
  assert.equal(result.overflow, true);
  assert.deepEqual(result.warnings, [{ code: "attachmentLimit" }]);
});

test("shouldDiscardCreatedManagedCandidate only allows batch-created managed files", async () => {
  const { shouldDiscardCreatedManagedCandidate } = await loadMergeModule();

  assert.equal(
    shouldDiscardCreatedManagedCandidate({
      managed: true,
      created: true,
      path: "/tmp/managed/new.png"
    }),
    true
  );
  assert.equal(
    shouldDiscardCreatedManagedCandidate({
      managed: true,
      path: "/tmp/managed/existing.png"
    }),
    false
  );
});

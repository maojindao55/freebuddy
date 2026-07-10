import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadCollectModule() {
  const source = fs.readFileSync(
    new URL("../electron/shared/collectPreparedAttachmentsUntilLimit.ts", import.meta.url),
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

async function loadAttachmentImportModule() {
  const source = fs.readFileSync(
    new URL("../src/utils/attachmentImport.ts", import.meta.url),
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

test("hasFileTransfer detects file drags only", async () => {
  const { hasFileTransfer } = await loadAttachmentImportModule();
  assert.equal(hasFileTransfer({ types: ["text/plain"] }), false);
  assert.equal(hasFileTransfer({ types: ["Files"] }), true);
  assert.equal(hasFileTransfer({ types: ["text/plain", "Files"] }), true);
});

test("extractFilesFromClipboard prefers files and falls back to items", async () => {
  const { extractFilesFromClipboard } = await loadAttachmentImportModule();
  const fileA = { name: "a.png" };
  const fileB = { name: "b.png" };

  assert.deepEqual(
    extractFilesFromClipboard({ files: [fileA], items: [] }),
    [fileA]
  );

  const item = {
    kind: "file",
    getAsFile: () => fileB
  };
  assert.deepEqual(
    extractFilesFromClipboard({ files: [], items: [item] }),
    [fileB]
  );
  assert.deepEqual(extractFilesFromClipboard({ files: [], items: [] }), []);
});

test("collectPreparedAttachmentsUntilLimit validates files until the attachment limit is reached", async () => {
  const { collectPreparedAttachmentsUntilLimit } = await loadCollectModule();
  const files = ["bad.exe", "good.png", "extra.png"];

  const result = await collectPreparedAttachmentsUntilLimit(files, 1, async (file) => {
    if (file === "bad.exe") {
      return {
        candidates: [],
        rejections: [{ name: file, reason: "unsupported_type" }]
      };
    }
    return {
      candidates: [{ name: file, path: `/tmp/${file}` }],
      rejections: []
    };
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].name, "good.png");
  assert.deepEqual(result.rejections, [{ name: "bad.exe", reason: "unsupported_type" }]);
});

test("deferred file picker results are discarded when send starts before apply", async () => {
  const { resolveDeferredAttachmentImport } = await loadAttachmentImportModule();
  const selected = [{ path: "/tmp/photo.png", managed: false }];

  const duringSend = resolveDeferredAttachmentImport({
    capturedGeneration: 1,
    currentGeneration: 2,
    sendLockBlocked: true,
    canImport: false,
    selected
  });
  assert.equal(duringSend.shouldApply, false);
  assert.deepEqual(duringSend.selected, selected);

  const normal = resolveDeferredAttachmentImport({
    capturedGeneration: 1,
    currentGeneration: 1,
    sendLockBlocked: false,
    canImport: true,
    selected
  });
  assert.equal(normal.shouldApply, true);
  assert.deepEqual(normal.selected, selected);
});

test("deferred attachment import invalidates when send starts during file picker", async () => {
  const { isDeferredAttachmentImportStillValid } = await loadAttachmentImportModule();

  assert.equal(
    isDeferredAttachmentImportStillValid({
      capturedGeneration: 1,
      currentGeneration: 1,
      sendLockBlocked: false,
      canImport: true
    }),
    true
  );

  assert.equal(
    isDeferredAttachmentImportStillValid({
      capturedGeneration: 1,
      currentGeneration: 2,
      sendLockBlocked: false,
      canImport: true
    }),
    false,
    "generation bump during send should discard picker results"
  );

  assert.equal(
    isDeferredAttachmentImportStillValid({
      capturedGeneration: 1,
      currentGeneration: 1,
      sendLockBlocked: true,
      canImport: true
    }),
    false,
    "send lock during picker wait should discard results"
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadManagedBufferValidationModule() {
  const source = fs.readFileSync(
    new URL("../electron/shared/managedBufferValidation.ts", import.meta.url),
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

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
]);

test("resolveManagedBufferAttachment rejects mime and extension mismatches", async () => {
  const { resolveManagedBufferAttachment } = await loadManagedBufferValidationModule();

  assert.deepEqual(
    resolveManagedBufferAttachment("photo.png", "text/html", Buffer.from("<html></html>")),
    { reason: "unsupported_type" }
  );

  assert.deepEqual(resolveManagedBufferAttachment("photo.png", "image/png", PNG_BYTES), {
    extension: "png",
    mimeType: "image/png"
  });
});

test("collectPreparedAttachmentsUntilLimit skips existing duplicates before hitting limit", async () => {
  const { collectPreparedAttachmentsUntilLimit } = await loadCollectModule();
  const existingPath = "/tmp/a.png";

  const result = await collectPreparedAttachmentsUntilLimit(
    [existingPath, "/tmp/b.png"],
    1,
    async (filePath) => ({
      candidates: [{ path: filePath, name: filePath.split("/").pop() }],
      rejections: []
    }),
    {
      existingPaths: [existingPath],
      getCandidatePath: (candidate) => candidate.path
    }
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].path, "/tmp/b.png");
});

test("collectPreparedAttachmentsUntilLimit keeps scanning after rejected files", async () => {
  const { collectPreparedAttachmentsUntilLimit } = await loadCollectModule();

  const result = await collectPreparedAttachmentsUntilLimit(
    ["bad.exe", "good.png"],
    1,
    async (file) => {
      if (file === "bad.exe") {
        return {
          candidates: [],
          rejections: [{ name: file, reason: "unsupported_type" }]
        };
      }
      return {
        candidates: [{ path: `/tmp/${file}`, name: file }],
        rejections: []
      };
    },
    {
      getCandidatePath: (candidate) => candidate.path
    }
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].name, "good.png");
});

test("collectPreparedAttachmentsUntilLimit reports overflow only when unique candidates are truncated", async () => {
  const { collectPreparedAttachmentsUntilLimit } = await loadCollectModule();
  const existingPath = "/tmp/a.png";

  const duplicateThenNew = await collectPreparedAttachmentsUntilLimit(
    [existingPath, "/tmp/b.png"],
    1,
    async (filePath) => ({
      candidates: [{ path: filePath, name: filePath.split("/").pop() }],
      rejections: []
    }),
    {
      existingPaths: [existingPath],
      getCandidatePath: (candidate) => candidate.path
    }
  );
  assert.equal(duplicateThenNew.overflow, false);

  const truncated = await collectPreparedAttachmentsUntilLimit(
    ["/tmp/a.png", "/tmp/b.png"],
    1,
    async (filePath) => ({
      candidates: [{ path: filePath, name: filePath.split("/").pop() }],
      rejections: []
    }),
    {
      getCandidatePath: (candidate) => candidate.path
    }
  );
  assert.equal(truncated.overflow, true);
});

test("collectPreparedAttachmentsUntilLimit does not overflow after valid then invalid", async () => {
  const { collectPreparedAttachmentsUntilLimit } = await loadCollectModule();

  const result = await collectPreparedAttachmentsUntilLimit(
    ["good.png", "bad.exe"],
    1,
    async (file) => {
      if (file === "bad.exe") {
        return {
          candidates: [],
          rejections: [{ name: file, reason: "unsupported_type" }]
        };
      }
      return {
        candidates: [{ path: `/tmp/${file}`, name: file }],
        rejections: []
      };
    },
    { getCandidatePath: (candidate) => candidate.path }
  );

  assert.equal(result.overflow, false);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.rejections, [{ name: "bad.exe", reason: "unsupported_type" }]);
});

test("collectPreparedAttachmentsUntilLimit does not overflow after valid then existing duplicate", async () => {
  const { collectPreparedAttachmentsUntilLimit } = await loadCollectModule();
  const existingPath = "/tmp/managed/existing.png";

  const result = await collectPreparedAttachmentsUntilLimit(
    ["good.png", existingPath],
    1,
    async (file) => ({
      candidates: [
        {
          path: file === "good.png" ? "/tmp/good.png" : existingPath,
          name: String(file),
          managed: file === existingPath
        }
      ],
      rejections: []
    }),
    {
      existingPaths: [existingPath],
      getCandidatePath: (candidate) => candidate.path
    }
  );

  assert.equal(result.overflow, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].path, "/tmp/good.png");
});

test("managedPathsToDiscardAfterPrepare ignores pre-existing managed paths not created in batch", async () => {
  const { managedPathsToDiscardAfterPrepare } = await loadCollectModule();
  const preExistingManaged = "/tmp/managed/existing.png";

  assert.deepEqual(
    managedPathsToDiscardAfterPrepare([], [{ managed: true, path: preExistingManaged }]),
    []
  );
  assert.deepEqual(
    managedPathsToDiscardAfterPrepare([], []),
    []
  );
});

test("managedPathsToDiscardAfterPrepare keeps accepted managed files and drops the rest", async () => {
  const { managedPathsToDiscardAfterPrepare } = await loadCollectModule();
  const created = ["/tmp/managed/a.png", "/tmp/managed/b.png"];
  const accepted = [{ managed: true, created: true, path: "/tmp/managed/a.png" }];

  assert.deepEqual(managedPathsToDiscardAfterPrepare(created, accepted), [
    "/tmp/managed/b.png"
  ]);
});

test("partial prepare failure should discard every created managed path", async () => {
  const { collectPreparedAttachmentsUntilLimit, managedPathsToDiscardAfterPrepare } =
    await loadCollectModule();
  const createdManagedPaths = ["/tmp/managed/first.png"];

  await assert.rejects(
    () =>
      collectPreparedAttachmentsUntilLimit(
        ["first.png", "second.png"],
        2,
        async (file) => {
          if (file === "first.png") {
            return {
              candidates: [{ managed: true, path: "/tmp/managed/first.png" }],
              rejections: []
            };
          }
          throw new Error("arrayBuffer failed");
        },
        {
          getCandidatePath: (candidate) => candidate.path
        }
      ),
    /arrayBuffer failed/
  );

  assert.deepEqual(
    managedPathsToDiscardAfterPrepare(createdManagedPaths, []),
    createdManagedPaths
  );
});

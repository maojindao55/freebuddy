import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadStreamMedia() {
  const source = fs.readFileSync(
    new URL("../src/utils/streamMedia.ts", import.meta.url),
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

test("extractDataUrlImages removes base64 payloads from tool output text", async () => {
  const { extractDataUrlImages } = await loadStreamMedia();
  const payload = "a".repeat(400);
  const input = `{"url":"data:image/png;base64,${payload}"}`;
  const { text, images } = extractDataUrlImages(input);

  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(images[0].data, payload);
  assert.doesNotMatch(text, /data:image\/png;base64,/);
});

test("sanitizeStreamItems splits image output into compact text plus image blocks", async () => {
  const { sanitizeStreamItems } = await loadStreamMedia();
  const payload = "b".repeat(500);
  const items = sanitizeStreamItems([
    {
      kind: "tool-result",
      tool: "read",
      content: `<image>{"url":"data:image/png;base64,${payload}"}</image>`
    }
  ]);

  const textItem = items.find((item) => item.kind === "tool-result");
  const imageItem = items.find(
    (item) => item.kind === "content-block" && item.blockType === "image"
  );

  assert.ok(textItem);
  assert.ok(textItem.content.length < 200);
  assert.ok(imageItem);
  assert.equal(imageItem.data, payload);
});

test("sanitizeStreamItems stores oversized image previews by reference key", async () => {
  const { sanitizeStreamItems, MAX_PERSISTED_IMAGE_BASE64 } = await loadStreamMedia();
  const payload = "c".repeat(MAX_PERSISTED_IMAGE_BASE64 + 128);
  const items = sanitizeStreamItems(
    [
      {
        kind: "content-block",
        blockType: "image",
        mimeType: "image/png",
        data: payload
      }
    ],
    () => "preview-1"
  );

  assert.deepEqual(items, [
    {
      kind: "content-block",
      blockType: "image",
      mimeType: "image/png",
      previewKey: "preview-1"
    }
  ]);
});

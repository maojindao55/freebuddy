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

test("sanitizeStreamItems redacts tool image output without inline previews", async () => {
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
  assert.match(textItem.content, /Image output/);
  assert.equal(imageItem, undefined);
});

test("extractDataUrlImages matches standard base64 alphabet casing", async () => {
  const { extractDataUrlImages } = await loadStreamMedia();
  const payload = "iVBORw0KGgoAAAANSUhEUg";
  const { text, images } = extractDataUrlImages(
    `{"url":"data:image/png;base64,${payload}"}`
  );

  assert.equal(images.length, 1);
  assert.equal(images[0].data, payload);
  assert.doesNotMatch(text, /iVBORw0KGgo/);
});

test("sanitizeStreamItems redacts tool-call output payloads", async () => {
  const { sanitizeStreamItems } = await loadStreamMedia();
  const payload = "iVBORw0KGgo" + "A".repeat(120);
  const items = sanitizeStreamItems([
    {
      kind: "tool-call",
      id: "tool-read",
      tool: "gaokao_jiayou.png",
      output: `{"url":"data:image/png;base64,${payload}"}`
    }
  ]);

  const call = items.find((item) => item.kind === "tool-call");
  assert.ok(call);
  assert.doesNotMatch(call.output ?? "", /data:image\/png;base64,/);
  assert.match(call.output ?? "", /Image output/);
  assert.equal(
    call.toolOutputs?.some(
      (item) => item.kind === "content-block" && item.blockType === "image"
    ),
    undefined
  );
});

test("sanitizeStreamItems drops native tool image content blocks", async () => {
  const { sanitizeStreamItems } = await loadStreamMedia();
  const items = sanitizeStreamItems([
    {
      kind: "tool-call",
      id: "tool-read",
      tool: "read_image",
      toolOutputs: [
        {
          kind: "content-block",
          blockType: "image",
          mimeType: "image/png",
          data: "aGVsbG8="
        },
        {
          kind: "file-edit",
          path: "/tmp/a.png",
          action: "update"
        }
      ]
    }
  ]);

  const call = items.find((item) => item.kind === "tool-call");
  assert.equal(call?.toolOutputs?.length, 1);
  assert.equal(call?.toolOutputs?.[0].kind, "file-edit");
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

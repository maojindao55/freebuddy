import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

async function loadProtocolModule() {
  const source = fs.readFileSync(
    new URL("../electron/freebuddyFileProtocol.ts", import.meta.url),
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

async function loadAttachmentUtils() {
  const source = fs.readFileSync(
    new URL("../src/utils/chatAttachments.ts", import.meta.url),
    "utf8"
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const output = transpiled.replace(
    /^import i18next from "i18next";\s*$/m,
    'const i18next = { t: (k) => k };'
  );
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("attachmentPreviewUrl encodes absolute paths in query form", async () => {
  const { attachmentPreviewUrl } = await loadAttachmentUtils();
  const url = attachmentPreviewUrl("/home/me/photo name.png");
  assert.match(url, /^freebuddy-file:\/\/open\?path=/);
  const parsed = new URL(url);
  assert.equal(
    decodeURIComponent(parsed.searchParams.get("path") ?? ""),
    "/home/me/photo name.png"
  );
});

test("resolveAttachmentFilePath supports query and legacy local URLs", async () => {
  const { buildAttachmentPreviewUrl, resolveAttachmentFilePath } =
    await loadProtocolModule();

  const queryUrl = buildAttachmentPreviewUrl("/tmp/screen.png");
  assert.equal(resolveAttachmentFilePath(queryUrl), path.normalize("/tmp/screen.png"));

  const legacyUrl = "freebuddy-file://local/tmp/screen.png";
  assert.equal(resolveAttachmentFilePath(legacyUrl), path.normalize("/tmp/screen.png"));

  if (process.platform === "win32") {
    const windowsUrl = buildAttachmentPreviewUrl("C:/Users/me/screen.png");
    assert.equal(
      resolveAttachmentFilePath(windowsUrl),
      path.normalize("C:/Users/me/screen.png")
    );
  }
});

test("handleFreebuddyFileRequest serves image bytes with mime type", async () => {
  const { handleFreebuddyFileRequest, buildAttachmentPreviewUrl } =
    await loadProtocolModule();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-file-"));
  const filePath = path.join(dir, "preview.png");
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444",
    "hex"
  );
  fs.writeFileSync(filePath, png);

  const response = await handleFreebuddyFileRequest(
    new Request(buildAttachmentPreviewUrl(filePath))
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, png.length);
});

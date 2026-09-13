import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadModule() {
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

test("classifies supported attachment paths", async () => {
  const { classifyAttachmentPath } = await loadModule();

  assert.deepEqual(classifyAttachmentPath("/tmp/screen.PNG"), {
    kind: "image",
    extension: "png",
    mimeType: "image/png"
  });
  assert.deepEqual(classifyAttachmentPath("/tmp/readme.md"), {
    kind: "document",
    extension: "md",
    mimeType: "text/markdown"
  });
  assert.deepEqual(classifyAttachmentPath("/tmp/App.tsx"), {
    kind: "code",
    extension: "tsx",
    mimeType: "text/plain"
  });
  assert.deepEqual(classifyAttachmentPath("/tmp/archive.zip"), {
    kind: "document",
    extension: "zip",
    mimeType: "application/zip"
  });
  assert.equal(classifyAttachmentPath("/tmp/binary.bin"), null);
  assert.equal(classifyAttachmentPath("/tmp/no-extension"), null);
});

test("creates and validates attachment metadata", async () => {
  const {
    createChatAttachment,
    validateAttachmentCandidate,
    MAX_ATTACHMENT_BYTES
  } = await loadModule();

  const attachment = createChatAttachment({
    path: "/Users/me/Desktop/screen.png",
    size: 1536
  });

  assert.equal(attachment.kind, "image");
  assert.equal(attachment.name, "screen.png");
  assert.equal(attachment.path, "/Users/me/Desktop/screen.png");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.size, 1536);
  assert.equal(attachment.extension, "png");
  assert.equal(validateAttachmentCandidate(attachment).ok, true);
  assert.deepEqual(validateAttachmentCandidate(null), {
    ok: false,
    reason: "unsupported_type"
  });
  assert.deepEqual(
    validateAttachmentCandidate(
      createChatAttachment({ path: "/tmp/big.pdf", size: MAX_ATTACHMENT_BYTES + 1 })
    ),
    { ok: false, reason: "file_too_large" }
  );
});

test("createChatAttachment preserves managed and created flags", async () => {
  const { createChatAttachment } = await loadModule();
  const attachment = createChatAttachment({
    path: "/tmp/freebuddy/managed-attachments/abc.png",
    managed: true,
    created: true
  });
  assert.equal(attachment.managed, true);
  assert.equal(attachment.created, true);
});

test("handles windows paths and custom mime types", async () => {
  const { createChatAttachment } = await loadModule();

  const attachment = createChatAttachment({
    path: "C:\\Users\\me\\project\\main.TS",
    mimeType: "application/typescript"
  });

  assert.equal(attachment.kind, "code");
  assert.equal(attachment.name, "main.TS");
  assert.equal(attachment.mimeType, "application/typescript");
  assert.equal(attachment.extension, "ts");
});

test("formats attachments for agent prompts", async () => {
  const {
    createChatAttachment,
    formatBytes,
    formatAttachmentForPrompt,
    composeMessageWithAttachments
  } = await loadModule();
  const image = createChatAttachment({
    path: "/Users/me/Desktop/screen.png",
    size: 1536
  });

  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(
    formatAttachmentForPrompt(image),
    "- screen.png (image/png, 1.5 KB): /Users/me/Desktop/screen.png"
  );
  assert.equal(
    composeMessageWithAttachments("请分析", [image]),
    "attachments.userMessage\n请分析\n\nattachments.attached\n- screen.png (image/png, 1.5 KB): /Users/me/Desktop/screen.png"
  );
  assert.equal(
    composeMessageWithAttachments("", [image]),
    "attachments.userMessage\nattachments.review\n\nattachments.attached\n- screen.png (image/png, 1.5 KB): /Users/me/Desktop/screen.png"
  );
});

test("attachmentPreviewUrl uses query-based freebuddy-file URLs", async () => {
  const { attachmentPreviewUrl } = await loadModule();
  const previous = globalThis.window;
  globalThis.window = undefined;
  try {
    const url = attachmentPreviewUrl("/tmp/photo.png");
    assert.match(url, /^freebuddy-file:\/\/open\?path=/);
    assert.equal(
      decodeURIComponent(new URL(url).searchParams.get("path") ?? ""),
      "/tmp/photo.png"
    );
  } finally {
    globalThis.window = previous;
  }
});

test("attachmentPreviewUrl uses /api/attachment on the web platform", async () => {
  const { attachmentPreviewUrl } = await loadModule();
  const previous = globalThis.window;
  globalThis.window = {
    freebuddy: { platform: "web", sessionToken: () => "tok-123" }
  };
  try {
    const url = attachmentPreviewUrl("/tmp/photo.png");
    assert.match(url, /^\/api\/attachment\?/);
    const parsed = new URL(url, "http://local.invalid");
    assert.equal(parsed.pathname, "/api/attachment");
    assert.equal(
      decodeURIComponent(parsed.searchParams.get("path") ?? ""),
      "/tmp/photo.png"
    );
    assert.equal(parsed.searchParams.get("token"), "tok-123");
  } finally {
    globalThis.window = previous;
  }
});

test("resolveLocalFilePath joins workspace-relative image paths", async () => {
  const { resolveLocalFilePath, attachmentPreviewUrl } = await loadModule();
  assert.equal(
    resolveLocalFilePath("generated-images/poster.png", "/Users/me/workspace"),
    "/Users/me/workspace/generated-images/poster.png"
  );
  assert.equal(resolveLocalFilePath("generated-images/poster.png", ""), "");
  assert.equal(
    resolveLocalFilePath("/abs/poster.png", "/Users/me/workspace"),
    "/abs/poster.png"
  );

  const previous = globalThis.window;
  globalThis.window = { freebuddy: { platform: "web" } };
  try {
    const abs = resolveLocalFilePath(
      "generated-images/poster.png",
      "/Users/me/workspace"
    );
    const url = attachmentPreviewUrl(abs);
    assert.equal(
      decodeURIComponent(new URL(url, "http://local.invalid").searchParams.get("path") ?? ""),
      "/Users/me/workspace/generated-images/poster.png"
    );
  } finally {
    globalThis.window = previous;
  }
});

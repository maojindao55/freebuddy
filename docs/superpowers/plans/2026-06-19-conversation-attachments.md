# Conversation Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add path-based attachments to FreeBuddy conversation messages.

**Architecture:** Electron selects local files and returns metadata. A renderer utility classifies, validates, formats, and composes attachment prompts. Conversation messages persist visible text plus attachment metadata, while CLI runs receive a composed prompt that includes original file paths.

**Tech Stack:** Electron IPC, React, Zustand, TypeScript, better-sqlite3, Node test runner.

---

### Task 1: Attachment Utility

**Files:**
- Create: `src/utils/chatAttachments.ts`
- Test: `tests/chat-attachments.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/chat-attachments.test.mjs` with tests for classification, validation, byte formatting, and prompt composition:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadModule() {
  const source = fs.readFileSync(new URL("../src/utils/chatAttachments.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("classifies supported attachment paths", async () => {
  const { classifyAttachmentPath } = await loadModule();
  assert.deepEqual(classifyAttachmentPath("/tmp/screen.PNG"), { kind: "image", extension: "png", mimeType: "image/png" });
  assert.deepEqual(classifyAttachmentPath("/tmp/readme.md"), { kind: "document", extension: "md", mimeType: "text/markdown" });
  assert.deepEqual(classifyAttachmentPath("/tmp/App.tsx"), { kind: "code", extension: "tsx", mimeType: "text/plain" });
  assert.equal(classifyAttachmentPath("/tmp/archive.zip"), null);
});

test("creates and validates attachment metadata", async () => {
  const { createChatAttachment, validateAttachmentCandidate, MAX_ATTACHMENT_BYTES } = await loadModule();
  const attachment = createChatAttachment({ path: "/Users/me/Desktop/screen.png", size: 1536 });
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.name, "screen.png");
  assert.equal(attachment.path, "/Users/me/Desktop/screen.png");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.size, 1536);
  assert.equal(validateAttachmentCandidate(attachment).ok, true);
  assert.deepEqual(validateAttachmentCandidate(null), { ok: false, reason: "unsupported_type" });
  assert.deepEqual(validateAttachmentCandidate(createChatAttachment({ path: "/tmp/big.pdf", size: MAX_ATTACHMENT_BYTES + 1 })), { ok: false, reason: "file_too_large" });
});

test("formats attachments for agent prompts", async () => {
  const { createChatAttachment, formatBytes, formatAttachmentForPrompt, composeMessageWithAttachments } = await loadModule();
  const image = createChatAttachment({ path: "/Users/me/Desktop/screen.png", size: 1536 });
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatAttachmentForPrompt(image), "- screen.png (image/png, 1.5 KB): /Users/me/Desktop/screen.png");
  assert.equal(composeMessageWithAttachments("请分析", [image]), "用户消息：\n请分析\n\n附件：\n- screen.png (image/png, 1.5 KB): /Users/me/Desktop/screen.png");
  assert.equal(composeMessageWithAttachments("", [image]), "用户消息：\n请查看这些附件。\n\n附件：\n- screen.png (image/png, 1.5 KB): /Users/me/Desktop/screen.png");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/chat-attachments.test.mjs`

Expected: FAIL because `src/utils/chatAttachments.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/chatAttachments.ts` with exported `ChatAttachment`, `AttachmentCandidate`, `MAX_ATTACHMENTS_PER_MESSAGE`, `MAX_ATTACHMENT_BYTES`, `classifyAttachmentPath`, `createChatAttachment`, `validateAttachmentCandidate`, `formatBytes`, `formatAttachmentForPrompt`, and `composeMessageWithAttachments`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/chat-attachments.test.mjs`

Expected: PASS.

### Task 2: Attachment Data And IPC

**Files:**
- Modify: `src/services/cli/types.ts`
- Modify: `electron/cli/conversations.ts`
- Modify: `electron/cli/db.ts`
- Modify: `electron/cli/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/freebuddy.d.ts`
- Modify: `src/services/cli/client.ts`
- Test: `tests/attachments-integration.test.mjs`

- [ ] **Step 1: Write the failing static test**

Create `tests/attachments-integration.test.mjs` asserting that types include `attachments`, DB migration adds an `attachments` column, IPC exposes `cli:selectAttachments`, preload exposes `selectAttachments`, and client calls it.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/attachments-integration.test.mjs`

Expected: FAIL because the surface does not exist yet.

- [ ] **Step 3: Implement metadata plumbing**

Add `ChatAttachment` and `AttachmentCandidate` types, persist `attachments` as JSON in `conversation_messages`, and expose `selectAttachments(): Promise<AttachmentCandidate[]>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/attachments-integration.test.mjs`

Expected: PASS.

### Task 3: Conversation Send Flow

**Files:**
- Modify: `src/store/conversationStore.ts`
- Modify: `src/components/CLI/ChatView.tsx`
- Test: `tests/attachments-integration.test.mjs`

- [ ] **Step 1: Extend failing static test**

Update `tests/attachments-integration.test.mjs` to assert that `sendMessage` accepts `attachments`, stores visible `content: trimmed`, and sends `prompt: composeMessageWithAttachments(trimmed, attachments)` to `cliClient.run`. Assert `ChatView` tracks pending attachments and permits attachment-only sends.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/attachments-integration.test.mjs`

Expected: FAIL because send flow and UI state are still text-only.

- [ ] **Step 3: Implement send flow**

Update `sendMessage` to accept attachments, store them on user messages, and compose the runtime prompt. Update `ChatView` to select, validate, display, remove, preview, and send pending attachments in active and new conversations.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/attachments-integration.test.mjs`

Expected: PASS.

### Task 4: Message Rendering And Styles

**Files:**
- Modify: `src/components/CLI/MessageBubble.tsx`
- Modify: `styles.css`
- Test: `tests/attachments-integration.test.mjs`

- [ ] **Step 1: Extend failing static test**

Update `tests/attachments-integration.test.mjs` to assert that `MessageBubble` renders `message.attachments` with an attachment list and that `styles.css` defines composer and message attachment classes.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/attachments-integration.test.mjs`

Expected: FAIL because attachments are not rendered yet.

- [ ] **Step 3: Implement renderer and styles**

Render compact attachment rows for user messages and add styles for pending trays, chips, remove buttons, and sent attachment lists.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/chat-attachments.test.mjs tests/attachments-integration.test.mjs`

Expected: PASS.

### Task 5: Full Verification

**Files:**
- Verify all touched files.

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Inspect diff**

Run: `git diff -- src tests electron styles.css docs/superpowers/specs/2026-06-19-conversation-attachments-design.md docs/superpowers/plans/2026-06-19-conversation-attachments.md`

Expected: Diff contains only path-based attachment feature changes.

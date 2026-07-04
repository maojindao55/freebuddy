import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const files = {
  types: fs.readFileSync(
    new URL("../src/services/cli/types.ts", import.meta.url),
    "utf8"
  ),
  conversations: fs.readFileSync(
    new URL("../electron/cli/conversations.ts", import.meta.url),
    "utf8"
  ),
  db: fs.readFileSync(new URL("../electron/cli/db.ts", import.meta.url), "utf8"),
  ipc: fs.readFileSync(
    new URL("../electron/cli/ipc.ts", import.meta.url),
    "utf8"
  ),
  preload: fs.readFileSync(
    new URL("../electron/preload.ts", import.meta.url),
    "utf8"
  ),
  globalTypes: fs.readFileSync(
    new URL("../src/types/freebuddy.d.ts", import.meta.url),
    "utf8"
  ),
  client: fs.readFileSync(
    new URL("../src/services/cli/client.ts", import.meta.url),
    "utf8"
  ),
  store: fs.readFileSync(
    new URL("../src/store/conversationStore.ts", import.meta.url),
    "utf8"
  ),
  chatView: fs.readFileSync(
    new URL("../src/components/CLI/ChatView.tsx", import.meta.url),
    "utf8"
  ),
  messageBubble: fs.readFileSync(
    new URL("../src/components/CLI/MessageBubble.tsx", import.meta.url),
    "utf8"
  ),
  styles: fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8")
};

test("attachment types and persistence are wired through conversations", () => {
  assert.match(files.types, /export interface ChatAttachment\s*\{/);
  assert.match(files.types, /attachments\?: ChatAttachment\[\]/);
  assert.match(files.conversations, /attachments\?: ChatAttachment\[\]/);
  assert.match(files.conversations, /JSON\.parse\(r\.attachments\)/);
  assert.match(files.conversations, /JSON\.stringify\(input\.attachments/);
  assert.match(files.db, /attachments TEXT/);
  assert.match(files.db, /ALTER TABLE conversation_messages ADD COLUMN attachments TEXT/);
});

test("electron bridge exposes multi-file attachment selection", () => {
  assert.match(files.ipc, /cli:selectAttachments/);
  assert.match(files.ipc, /properties:\s*\[[^\]]*"openFile"[^\]]*"multiSelections"[^\]]*\]/s);
  assert.match(files.ipc, /fs\.statSync/);
  assert.match(files.preload, /selectAttachments:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("cli:selectAttachments"\)/);
  assert.match(files.globalTypes, /selectAttachments\(\): Promise<AttachmentCandidate\[\]>/);
  assert.match(files.client, /selectAttachments\(\): Promise<AttachmentCandidate\[\]>/);
  assert.match(files.client, /return api\(\)\.selectAttachments\(\)/);
});

test("conversation send flow composes agent prompts from attachments", () => {
  assert.match(files.store, /composeMessageWithAttachments/);
  assert.match(files.store, /attachments\?: ChatAttachment\[\]/);
  assert.match(files.store, /content:\s*trimmed/);
  assert.match(files.store, /attachments/);
  assert.match(files.store, /upsertConversationMessage/);
  assert.match(files.store, /savedUser\.attachments/);
  assert.match(files.store, /const userPrompt = composeMessageWithAttachments\(trimmed,\s*attachments\)/);
  assert.match(files.store, /prompt:\s*promptWithWorkflowContext/);
});

test("chat composer supports pending and attachment-only sends", () => {
  assert.match(files.chatView, /pendingAttachments/);
  assert.match(files.chatView, /handleSelectAttachments/);
  assert.match(files.chatView, /handleRemovePendingAttachment/);
  assert.match(files.chatView, /draft\.trim\(\) \|\| pendingAttachments\.length > 0/);
  assert.match(files.chatView, /attachments:\s*attachmentsToSend/);
  assert.match(files.chatView, /className="attachment-tray"/);
});

test("user message bubbles render attachments with styles", () => {
  assert.match(files.messageBubble, /message\.attachments/);
  assert.match(files.messageBubble, /attachment-list/);
  assert.match(files.styles, /\.attachment-tray\s*\{/);
  assert.match(files.styles, /\.attachment-chip\s*\{/);
  assert.match(files.styles, /\.message-attachments\s*\{/);
});

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
  attachmentsModule: fs.readFileSync(
    new URL("../electron/cli/attachments.ts", import.meta.url),
    "utf8"
  ),
  attachmentImportHook: fs.readFileSync(
    new URL("../src/hooks/useAttachmentImport.ts", import.meta.url),
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
  assert.match(files.ipc, /cli:prepareAttachmentFiles/);
  assert.match(files.ipc, /cli:discardManagedAttachment/);
  assert.match(files.preload, /selectAttachments:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("cli:selectAttachments"\)/);
  assert.match(files.preload, /webUtils\.getPathForFile/);
  assert.match(files.preload, /file\.size > MAX_ATTACHMENT_BYTES/);
  assert.match(files.preload, /collectPreparedAttachmentsUntilLimit/);
  assert.match(files.preload, /existingPaths/);
  assert.doesNotMatch(files.preload, /files\.slice\(0, Math\.max\(0, limit\)\)/);
  assert.match(files.preload, /prepareAttachmentFiles/);
  assert.match(files.preload, /discardManagedAttachment/);
  assert.match(files.globalTypes, /selectAttachments\(\): Promise<AttachmentCandidate\[\]>/);
  assert.match(
    files.globalTypes,
    /prepareAttachmentFiles\([\s\S]*?\): Promise<PrepareAttachmentFilesResult>/
  );
  assert.match(files.globalTypes, /PrepareAttachmentFilesResult/);
  assert.match(files.globalTypes, /discardManagedAttachment\(filePath: string\): Promise<boolean>/);
  assert.match(files.client, /selectAttachments\(\): Promise<AttachmentCandidate\[\]>/);
  assert.match(files.client, /prepareAttachmentFiles\(\s*files: File\[\],\s*limit\?: number,\s*existingPaths\?: string\[\]\s*\)/);
  assert.match(files.client, /discardManagedAttachment\(filePath: string\)/);
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
  assert.match(files.chatView, /handleImportAttachments/);
  assert.match(files.chatView, /handleRemovePendingAttachment/);
  assert.match(files.chatView, /useAttachmentImport/);
  assert.match(files.chatView, /onPaste=\{chatAttachmentImport\.handlePaste\}/);
  assert.match(files.chatView, /attachment-drop-active/);
  assert.match(files.chatView, /draft\.trim\(\) \|\| pendingAttachments\.length > 0/);
  assert.match(files.chatView, /attachments:\s*attachmentsToSend/);
  assert.match(files.chatView, /className="attachment-tray"/);
  assert.match(files.chatView, /discardManagedAttachmentIfUnreferenced/);
  assert.match(files.chatView, /if \(attachmentBusy\) return/);
  assert.match(files.chatView, /prepareAttachmentFiles\(\s*files,\s*remaining,\s*existingPaths\s*\)/);
  assert.match(files.chatView, /!acceptedPaths\.has\(candidate\.path\)/);
});

test("managed attachments are cleaned up when conversations delete", () => {
  assert.match(files.attachmentsModule, /managed-attachments/);
  assert.match(files.attachmentsModule, /isManagedAttachmentPath/);
  assert.match(files.attachmentsModule, /discardManagedAttachment/);
  assert.match(files.conversations, /discardManagedAttachmentIfUnreferenced/);
  assert.match(files.attachmentsModule, /cleanupOrphanManagedAttachments/);
  assert.match(files.attachmentsModule, /countManagedAttachmentReferences/);
  assert.match(files.preload, /createdManagedPaths/);
  assert.match(files.preload, /discardManagedAttachments/);
  assert.match(files.chatView, /setter\(\(current\)/);
  assert.match(files.chatView, /beforeunload/);
  assert.match(files.preload, /managedPathsToDiscardAfterPrepare/);
  assert.match(files.preload, /trackCreatedManagedFromBatch/);
  const prepareFileBlock = files.preload.slice(
    files.preload.indexOf("const prepareFile = async")
  );
  const pathBranch = prepareFileBlock.slice(
    0,
    prepareFileBlock.indexOf("if (file.size > MAX_ATTACHMENT_BYTES)")
  );
  assert.doesNotMatch(pathBranch, /trackCreatedManagedFromBatch/);
  assert.match(prepareFileBlock, /kind: "buffer"[\s\S]*trackCreatedManagedFromBatch/);
  assert.match(files.globalTypes, /discardManagedAttachmentIfUnreferenced/);
  assert.match(files.client, /discardManagedAttachmentIfUnreferenced/);
  assert.match(files.ipc, /cli:discardManagedAttachmentIfUnreferenced/);
  assert.match(files.attachmentsModule, /cleanupManagedAttachmentsIfUnreferenced/);
  assert.match(files.chatView, /discardManagedAttachmentIfUnreferenced/);
  assert.match(files.chatView, /prepareAttachmentFiles\(\s*files,\s*remaining,\s*existingPaths\s*\)/);
  assert.match(files.globalTypes, /PrepareAttachmentFilesResult/);
  assert.match(files.preload, /collectPreparedAttachmentsUntilLimit/);
  assert.match(files.attachmentsModule, /resolveManagedBufferAttachment/);
  assert.match(files.attachmentsModule, /created: true/);
  assert.match(files.preload, /item\?\.created && item\?\.managed/);
  assert.match(files.attachmentsModule, /isManagedAttachmentPath\(filePath\)/);
  assert.match(files.chatView, /protectManagedAttachments/);
  assert.match(files.chatView, /attachmentRejectionWarnings/);
});

test("attachment import hook handles drag depth and paste", () => {
  assert.match(files.attachmentImportHook, /dragDepthRef/);
  assert.match(files.attachmentImportHook, /hasFileTransfer/);
  assert.match(files.attachmentImportHook, /extractFilesFromClipboard/);
  assert.match(
    files.attachmentImportHook,
    /if \(!hasFileTransfer\(event\.dataTransfer\)\) return;\s*event\.preventDefault\(\)/s
  );
  assert.match(files.attachmentImportHook, /resetDrag\(\)/);
});

test("user message bubbles render attachments with styles", () => {
  assert.match(files.messageBubble, /message\.attachments/);
  assert.match(files.messageBubble, /attachment-list/);
  assert.match(files.styles, /\.attachment-tray\s*\{/);
  assert.match(files.styles, /\.attachment-chip\s*\{/);
  assert.match(files.styles, /\.message-attachments\s*\{/);
});

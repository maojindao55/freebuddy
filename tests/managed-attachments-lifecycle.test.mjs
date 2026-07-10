import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const attachmentsSource = fs.readFileSync(
  new URL("../electron/cli/attachments.ts", import.meta.url),
  "utf8"
);
const chatViewSource = fs.readFileSync(
  new URL("../src/components/CLI/ChatView.tsx", import.meta.url),
  "utf8"
);
const conversationsSource = fs.readFileSync(
  new URL("../electron/cli/conversations.ts", import.meta.url),
  "utf8"
);
const ipcSource = fs.readFileSync(
  new URL("../electron/cli/ipc.ts", import.meta.url),
  "utf8"
);

test("managed attachment cleanup respects database reference counts", () => {
  assert.match(attachmentsSource, /countManagedAttachmentReferences/);
  assert.match(attachmentsSource, /discardManagedAttachmentIfUnreferenced/);
  assert.match(attachmentsSource, /cleanupManagedAttachmentsIfUnreferenced/);
  assert.match(ipcSource, /cli:discardManagedAttachmentIfUnreferenced/);
  assert.match(ipcSource, /cleanupManagedAttachmentsIfUnreferenced/);
});

test("send-fail restore keeps managed files referenced by saved messages", () => {
  const onSend = chatViewSource.slice(chatViewSource.indexOf("const onSend = async () =>"));
  assert.match(onSend, /restoreAttachmentsForSend\(attachmentsToSend, prev\)/);
  assert.match(chatViewSource, /discardManagedAttachmentIfUnreferenced/);
  assert.doesNotMatch(
    chatViewSource.match(/const discardAttachmentIfManaged[\s\S]*?\n  \};/)?.[0] ?? "",
    /discardManagedAttachment\(attachment\.path\)/
  );
});

test("component unmount and stale imports clean up only unreferenced managed files", () => {
  assert.match(chatViewSource, /attachmentImportGenerationRef/);
  assert.match(chatViewSource, /cleanupPendingManagedIfUnreferenced/);
  assert.match(chatViewSource, /shouldDiscardCreatedManagedCandidate/);
  assert.match(chatViewSource, /discardRejectedManagedCandidates/);
  assert.match(chatViewSource, /attachmentImportGenerationRef\.current \+= 1/);
});

test("managed directory paths keep managed flag when re-attached", () => {
  assert.match(attachmentsSource, /isManagedAttachmentPath\(filePath\)/);
  assert.match(
    attachmentsSource,
    /attachment\.managed \|\| isManagedAttachmentPath\(attachment\.path\)/
  );
});

test("in-flight send protects managed attachments from unmount cleanup", () => {
  assert.match(chatViewSource, /sendInFlightRef/);
  assert.match(chatViewSource, /setSendLock\(true\)/);
  assert.match(chatViewSource, /protectManagedAttachments\(attachmentsToSend\)/);
  assert.match(chatViewSource, /const targetMember = await resolveWorkflowFollowupMember\(\)/);
  assert.match(chatViewSource, /isManagedAttachmentPathProtected/);
});

test("rejected managed candidates only delete unreferenced files", () => {
  assert.match(chatViewSource, /discardManagedAttachmentIfUnreferenced\(candidate\.path\)/);
  assert.match(conversationsSource, /isManagedAttachmentPath\(attachment\.path\)/);
  assert.doesNotMatch(
    conversationsSource.slice(conversationsSource.indexOf("export function deleteConversation")),
    /attachment\.managed && isManagedAttachmentPath/
  );
});

test("file picker revalidates send lock after await", () => {
  const handleSelect = chatViewSource.slice(
    chatViewSource.indexOf("const handleSelectAttachments = async")
  );
  assert.match(handleSelect, /const importGeneration = attachmentImportGenerationRef\.current/);
  assert.match(handleSelect, /await cliClient\.selectAttachments\(\)/);
  assert.match(handleSelect, /resolveDeferredAttachmentImport/);
  assert.match(handleSelect, /discardRejectedManagedCandidates\(\[\.\.\.deferredImport\.selected\]\)/);
});

test("import rejections surface attachment warnings to the user", () => {
  assert.match(chatViewSource, /attachmentRejectionWarnings/);
  assert.match(chatViewSource, /rejections/);
  assert.match(chatViewSource, /applyAttachmentCandidates\(target, candidates, rejectionWarnings\)/);
});

test("drag and paste import validates all files before attachment limit is applied", () => {
  const handleImport = chatViewSource.slice(
    chatViewSource.indexOf("const handleImportAttachments = async")
  );
  assert.match(handleImport, /prepareAttachmentFiles\(\s*files,\s*remaining,\s*existingPaths\s*\)/);
  assert.doesNotMatch(handleImport, /files\.slice\(0, remaining\)/);
  assert.match(handleImport, /overflow/);
  assert.doesNotMatch(handleImport, /files\.length > remaining/);
  assert.doesNotMatch(handleImport, /limitWarning/);
  assert.match(chatViewSource, /isImportBlockedBySendLock/);
  assert.match(chatViewSource, /sendLock \|\| sendInFlightRef/);
  assert.match(chatViewSource, /detachAttachmentsForSend/);
});

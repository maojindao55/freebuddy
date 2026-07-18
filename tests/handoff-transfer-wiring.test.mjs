import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) =>
  fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("db.ts declares handoff_briefs table and source_* columns", () => {
  const db = read("electron/cli/db.ts");
  assert.match(db, /CREATE TABLE IF NOT EXISTS handoff_briefs/);
  assert.match(db, /brief_json\s+TEXT NOT NULL/);
  assert.match(db, /transcript_path\s+TEXT/);
  assert.match(db, /cleanupOrphanHandoffTranscriptSnapshots/);
  assert.match(db, /CREATE INDEX IF NOT EXISTS idx_handoff_briefs_target/);
  assert.match(db, /CREATE INDEX IF NOT EXISTS idx_handoff_briefs_source/);
  assert.match(db, /FOREIGN KEY\(target_conversation_id\) REFERENCES conversations/);
  assert.doesNotMatch(db, /FOREIGN KEY\(source_conversation_id\) REFERENCES conversations/);
  assert.match(db, /PRAGMA foreign_key_list\(handoff_briefs\)/);
  assert.match(db, /CREATE TABLE handoff_briefs_next/);
  assert.match(db, /ALTER TABLE conversations ADD COLUMN source_conversation_id/);
  assert.match(db, /ALTER TABLE conversations ADD COLUMN source_agent_id/);
  assert.match(db, /ALTER TABLE conversations ADD COLUMN source_agent_name/);
  assert.match(db, /ALTER TABLE conversations ADD COLUMN source_adapter/);
  assert.match(db, /ALTER TABLE conversations ADD COLUMN source_brief_id/);
});

test("conversations.ts wires source_* through createConversation and rowToConversation", () => {
  const src = read("electron/cli/conversations.ts");
  assert.match(src, /source_conversation_id/);
  assert.match(src, /sourceConversationId:/);
  assert.match(src, /sourceBriefId/);
  assert.match(src, /sourceConversationId\?: string;/);
});

test("contextToolService exports register/unregister and writes manifest under dataDir", () => {
  const src = read("electron/contextToolService.ts");
  assert.match(src, /export function registerContextToolSession/);
  assert.match(src, /export function unregisterContextToolSession/);
  assert.match(src, /name: "freebuddy-context"/);
  assert.match(src, /FREEBUDDY_HANDOFF_MANIFEST/);
  assert.match(src, /context-sessions/);
  assert.match(src, /version: 2/);
  assert.match(src, /transcript/);
});

test("acpRuntime pushes context MCP server when args.handoffBrief present", () => {
  const src = read("electron/cli/acpRuntime.ts");
  assert.match(src, /registerContextToolSession/);
  assert.match(src, /unregisterContextToolSession/);
  assert.match(src, /args\.handoffBrief/);
  assert.match(src, /registerContextToolSession\(/);
  assert.match(src, /unregisterContextToolSession\(args\.sessionId\)/);
});

test("IPC exposes preview/transfer and resolves handoff briefs inside the main process", () => {
  const ipc = read("electron/cli/ipc.ts");
  const preload = read("electron/preload.ts");
  const dts = read("src/types/freebuddy.d.ts");
  assert.match(ipc, /cli:previewHandoffBrief/);
  assert.match(ipc, /cli:transferConversation/);
  assert.match(ipc, /extractHandoffBrief/);
  assert.match(ipc, /insertHandoffBrief/);
  assert.match(ipc, /createHandoffTranscriptSnapshot/);
  assert.match(ipc, /deleteHandoffTranscriptSnapshot/);
  assert.match(ipc, /cwd: source\.cwd/);
  assert.doesNotMatch(ipc, /input\.cwd \?\? source\.cwd/);
  assert.match(ipc, /getHandoffBrief\(args\.handoffBriefId\)/);
  assert.match(ipc, /row\.targetConversationId === args\.conversationId/);
  assert.match(preload, /previewHandoffBrief:/);
  assert.match(preload, /transferConversation:/);
  assert.doesNotMatch(preload, /getHandoffBriefByTarget:/);
  assert.match(dts, /previewHandoffBrief\(/);
  assert.match(dts, /transferConversation\(/);
  assert.doesNotMatch(dts, /getHandoffBriefByTarget\(/);
});

test("handoff UI auto-starts with a reference card and keeps per-conversation drafts isolated", () => {
  const dialog = read("src/components/CLI/TransferDialog.tsx");
  const chat = read("src/components/CLI/ChatView.tsx");
  const app = read("src/App.tsx");
  const store = read("src/store/conversationStore.ts");
  const css = read("styles.css");
  assert.match(dialog, /const loadPreview = async/);
  assert.match(dialog, /onKeyDown=\{handleDialogKeyDown\}/);
  assert.match(dialog, /aria-labelledby=\{titleId\}/);
  assert.match(dialog, /value=\{source\.cwd \?\? t\("chat\.noWorkspace"\)\}/);
  assert.match(dialog, /readOnly/);
  assert.doesNotMatch(dialog, /setCwd|cwdMismatch/);
  assert.match(dialog, /transfer-dialog-select-wrap/);
  assert.match(dialog, /transfer-dialog-select-chevron/);
  assert.match(dialog, /ChevronDown/);
  assert.match(chat, /conversationDraftsRef/);
  assert.match(chat, /conversationAttachmentsRef/);
  assert.match(chat, /HandoffConversationCard/);
  assert.match(chat, /contextAvailable=\{Boolean\(conv\.sourceBriefId\)\}/);
  assert.match(store, /internalPrompt: true/);
  assert.match(store, /if \(!internalPrompt\)/);
  assert.doesNotMatch(store, /pendingTransferSeed/);
  assert.doesNotMatch(chat, /composer-context-transfer/);
  assert.match(app, /titlebar-transfer-button/);
  assert.match(app, /activeConversationHasContent/);
  assert.match(app, /stopBeforeTransfer/);
  assert.match(app, /transferSourceId/);
  assert.match(css, /\.transfer-dialog\s*\{/);
  assert.match(css, /\.titlebar-transfer-button\s*\{/);
  assert.match(css, /\.handoff-reference-card\s*\{/);
  assert.match(css, /appearance: none/);
  assert.match(css, /\.transfer-dialog-select-chevron\s*\{/);
});

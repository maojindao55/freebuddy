import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) =>
  fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("db.ts declares handoff_briefs table and source_* columns", () => {
  const db = read("electron/cli/db.ts");
  assert.match(db, /CREATE TABLE IF NOT EXISTS handoff_briefs/);
  assert.match(db, /brief_json\s+TEXT NOT NULL/);
  assert.match(db, /CREATE INDEX IF NOT EXISTS idx_handoff_briefs_target/);
  assert.match(db, /CREATE INDEX IF NOT EXISTS idx_handoff_briefs_source/);
  assert.match(db, /FOREIGN KEY\(source_conversation_id\) REFERENCES conversations/);
  assert.match(db, /FOREIGN KEY\(target_conversation_id\) REFERENCES conversations/);
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
});

test("acpRuntime pushes context MCP server when args.handoffBrief present", () => {
  const src = read("electron/cli/acpRuntime.ts");
  assert.match(src, /import.*registerContextToolSession.*from.*contextToolService/);
  assert.match(src, /args\.handoffBrief/);
  assert.match(src, /registerContextToolSession\(/);
});

test("IPC exposes previewHandoffBrief, transferConversation, and getHandoffBriefByTarget", () => {
  const ipc = read("electron/cli/ipc.ts");
  const preload = read("electron/preload.ts");
  const dts = read("src/types/freebuddy.d.ts");
  assert.match(ipc, /cli:previewHandoffBrief/);
  assert.match(ipc, /cli:transferConversation/);
  assert.match(ipc, /cli:getHandoffBriefByTarget/);
  assert.match(ipc, /extractHandoffBrief/);
  assert.match(ipc, /insertHandoffBrief/);
  assert.match(preload, /previewHandoffBrief:/);
  assert.match(preload, /transferConversation:/);
  assert.match(preload, /getHandoffBriefByTarget:/);
  assert.match(dts, /previewHandoffBrief\(/);
  assert.match(dts, /transferConversation\(/);
  assert.match(dts, /getHandoffBriefByTarget\(/);
});

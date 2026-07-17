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

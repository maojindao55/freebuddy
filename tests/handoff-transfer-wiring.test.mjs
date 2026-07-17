import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) =>
  fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("db.ts declares handoff_briefs table and source_* columns", () => {
  const db = read("electron/cli/db.ts");
  assert.match(db, /CREATE TABLE IF NOT EXISTS handoff_briefs/);
  assert.match(db, /ALTER TABLE conversations ADD COLUMN source_conversation_id/);
  assert.match(db, /ADD COLUMN source_brief_id/);
  assert.match(db, /FOREIGN KEY\(source_conversation_id\) REFERENCES conversations/);
  assert.match(db, /FOREIGN KEY\(target_conversation_id\) REFERENCES conversations/);
});

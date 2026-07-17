import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      adapter TEXT NOT NULL,
      cwd TEXT,
      approval_mode TEXT,
      config_option_overrides TEXT,
      skill_snapshot TEXT,
      title_source TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT,
      source_conversation_id TEXT,
      source_agent_id TEXT,
      source_agent_name TEXT,
      source_adapter TEXT,
      source_brief_id TEXT
    );
    CREATE TABLE handoff_briefs (
      id TEXT PRIMARY KEY,
      source_conversation_id TEXT NOT NULL,
      target_conversation_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      source_agent_name TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      source_message_count INTEGER NOT NULL,
      source_last_message_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(source_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(target_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
  `);
  return db;
}

const sampleBrief = {
  version: 1,
  generatedAt: "t",
  source: { conversationId: "A", agentId: "A", agentName: "Codex", adapter: "codex", title: "A", messageCount: 1 },
  originalGoal: "g",
  recentUserMessages: [],
  lastAssistantSummary: "",
  fileChanges: [],
  transcriptExcerpts: []
};

test("insertHandoffBrief + getHandoffBriefByTarget roundtrip", async () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
     VALUES ('A', 'A', 'A', 'A', 'codex', '0', '0'),
            ('B', 'B', 'B', 'B', 'claude', '0', '0')`
  ).run();
  const { setDbForTest, insertHandoffBrief, getHandoffBriefByTarget } =
    await import("../dist-electron/cli/handoffBriefs.js");
  setDbForTest(db);
  const row = insertHandoffBrief({
    id: "br1",
    sourceConversationId: "A",
    targetConversationId: "B",
    sourceAgentId: "A",
    sourceAgentName: "Codex",
    sourceAdapter: "codex",
    brief: sampleBrief,
    sourceMessageCount: 1,
    sourceLastMessageId: "m1"
  });
  assert.equal(row.id, "br1");
  assert.equal(row.targetConversationId, "B");
  const got = getHandoffBriefByTarget("B");
  assert.equal(got?.id, "br1");
  assert.equal(got?.brief.originalGoal, "g");
});

test("CASCADE: delete target conversation removes brief", async () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
     VALUES ('A', 'A', 'A', 'A', 'codex', '0', '0'),
            ('B', 'B', 'B', 'B', 'claude', '0', '0')`
  ).run();
  const { setDbForTest, insertHandoffBrief, getHandoffBriefByTarget } =
    await import("../dist-electron/cli/handoffBriefs.js");
  setDbForTest(db);
  insertHandoffBrief({
    id: "br1", sourceConversationId: "A", targetConversationId: "B",
    sourceAgentId: "A", sourceAgentName: "Codex", sourceAdapter: "codex",
    brief: sampleBrief, sourceMessageCount: 0
  });
  db.prepare("DELETE FROM conversations WHERE id = ?").run("B");
  assert.equal(getHandoffBriefByTarget("B"), undefined);
});

test("getHandoffBriefsBySource returns briefs ordered DESC", async () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
     VALUES ('A', 'A', 'A', 'A', 'codex', '0', '0'),
            ('B1', 'B1', 'B1', 'B1', 'claude', '0', '0'),
            ('B2', 'B2', 'B2', 'B2', 'claude', '0', '0')`
  ).run();
  const { setDbForTest, insertHandoffBrief, getHandoffBriefsBySource } =
    await import("../dist-electron/cli/handoffBriefs.js");
  setDbForTest(db);
  insertHandoffBrief({
    id: "old", sourceConversationId: "A", targetConversationId: "B1",
    sourceAgentId: "A", sourceAgentName: "Codex", sourceAdapter: "codex",
    brief: sampleBrief, sourceMessageCount: 0
  });
  await new Promise((r) => setTimeout(r, 10));
  insertHandoffBrief({
    id: "new", sourceConversationId: "A", targetConversationId: "B2",
    sourceAgentId: "A", sourceAgentName: "Codex", sourceAdapter: "codex",
    brief: sampleBrief, sourceMessageCount: 0
  });
  const list = getHandoffBriefsBySource("A");
  assert.deepEqual(list.map((r) => r.id), ["new", "old"]);
});

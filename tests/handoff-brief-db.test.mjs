import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// better-sqlite3 is a native binding compiled for either Electron or Node.
// When postinstall runs electron-rebuild, the binding targets Electron's
// NODE_MODULE_VERSION and CLI Node can't load it. Skip these DB integration
// tests in that case (CI environments where the binding matches will run them).
let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  // The native .node file loads lazily on first instantiation; probe it.
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

function makeDb(legacySourceForeignKey = false) {
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
      ${legacySourceForeignKey ? "" : `transcript_path TEXT,
      transcript_message_count INTEGER,
      transcript_byte_size INTEGER,
      transcript_truncated INTEGER NOT NULL DEFAULT 0,`}
      created_at TEXT NOT NULL,
      ${legacySourceForeignKey
        ? "FOREIGN KEY(source_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,"
        : ""}
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

test("insertHandoffBrief + getHandoffBriefByTarget roundtrip", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable under this Node"); return; }
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
    sourceLastMessageId: "m1",
    transcript: {
      format: "jsonl",
      path: "/tmp/handoff-snapshots/br1.jsonl",
      messageCount: 1,
      byteSize: 123,
      truncated: true
    }
  });
  assert.equal(row.id, "br1");
  assert.equal(row.targetConversationId, "B");
  const got = getHandoffBriefByTarget("B");
  assert.equal(got?.id, "br1");
  assert.equal(got?.brief.originalGoal, "g");
  assert.deepEqual(got?.transcript, {
    format: "jsonl",
    path: "/tmp/handoff-snapshots/br1.jsonl",
    messageCount: 1,
    byteSize: 123,
    truncated: true
  });
});

test("CASCADE: delete target conversation removes brief", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable under this Node"); return; }
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

test("snapshot survives deleting the source conversation", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable under this Node"); return; }
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
    id: "br-source-delete", sourceConversationId: "A", targetConversationId: "B",
    sourceAgentId: "A", sourceAgentName: "Codex", sourceAdapter: "codex",
    brief: sampleBrief, sourceMessageCount: 1
  });
  db.prepare("DELETE FROM conversations WHERE id = ?").run("A");
  assert.equal(getHandoffBriefByTarget("B")?.brief.originalGoal, "g");
});

test("migration removes the legacy source cascade without losing snapshots", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable under this Node"); return; }
  const db = makeDb(true);
  db.prepare(
    `INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
     VALUES ('A', 'A', 'A', 'A', 'codex', '0', '0'),
            ('B', 'B', 'B', 'B', 'claude', '0', '0')`
  ).run();
  db.prepare(
    `INSERT INTO handoff_briefs
       (id, source_conversation_id, target_conversation_id, source_agent_id,
        source_agent_name, source_adapter, brief_json, source_message_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("legacy", "A", "B", "A", "Codex", "codex", JSON.stringify(sampleBrief), 1, "0");

  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  const columnNames = db.prepare("PRAGMA table_info(handoff_briefs)").all().map((column) => column.name);
  assert.ok(columnNames.includes("transcript_path"));
  assert.ok(columnNames.includes("transcript_message_count"));
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(handoff_briefs)").all();
  assert.equal(foreignKeys.some((key) => key.from === "source_conversation_id"), false);
  db.prepare("DELETE FROM conversations WHERE id = ?").run("A");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM handoff_briefs WHERE id = 'legacy'").get().count,
    1
  );
});

test("getHandoffBriefsBySource returns briefs ordered DESC", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable under this Node"); return; }
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

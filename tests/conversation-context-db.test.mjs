import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY
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
      transcript_path TEXT,
      transcript_message_count INTEGER,
      transcript_byte_size INTEGER,
      transcript_truncated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(target_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE conversation_context_snapshots (
      id TEXT PRIMARY KEY,
      source_conversation_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      source_agent_name TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      source_title TEXT NOT NULL,
      source_cwd TEXT,
      brief_json TEXT NOT NULL,
      source_message_count INTEGER NOT NULL,
      source_last_message_id TEXT,
      transcript_path TEXT,
      transcript_message_count INTEGER,
      transcript_byte_size INTEGER,
      transcript_truncated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE conversation_context_refs (
      id TEXT PRIMARY KEY,
      target_conversation_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(target_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(snapshot_id) REFERENCES conversation_context_snapshots(id) ON DELETE CASCADE,
      UNIQUE(target_conversation_id, snapshot_id)
    );
    CREATE TABLE conversation_share_tokens (
      token_hash TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(snapshot_id) REFERENCES conversation_context_snapshots(id) ON DELETE CASCADE
    );
  `);
  db.prepare("INSERT INTO conversations (id) VALUES ('A'), ('B'), ('C')").run();
  return db;
}

const brief = {
  version: 1,
  generatedAt: "2026-07-24T00:00:00.000Z",
  source: {
    conversationId: "A",
    agentId: "codex",
    agentName: "Codex",
    adapter: "codex-acp",
    title: "Source",
    cwd: "/workspace",
    messageCount: 3
  },
  originalGoal: "Build sharing",
  recentUserMessages: [],
  lastAssistantSummary: "",
  fileChanges: [],
  transcriptExcerpts: []
};

test("share token attaches one immutable snapshot to arbitrary conversations", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  const db = makeDb();
  const context = await import("../dist-electron/cli/conversationContext.js");
  context.setConversationContextDbForTest(db);
  t.after(() => {
    context.setConversationContextDbForTest(null);
    db.close();
  });

  context.insertConversationContextSnapshot({
    id: "snapshot-1",
    brief,
    sourceLastMessageId: "m3",
    transcript: {
      format: "jsonl",
      path: "/data/handoff-snapshots/snapshot-1.jsonl",
      messageCount: 3,
      byteSize: 123,
      truncated: false
    }
  });
  const link = context.createConversationShareToken("snapshot-1");
  assert.match(link, /^freebuddy:\/\/conversation-share\/v1\/[a-zA-Z0-9_-]+$/);

  const attachedB = context.attachConversationSharesFromText(
    "B",
    `Please inspect ${link}`
  );
  assert.equal(attachedB.attachedCount, 1);
  assert.equal(attachedB.references[0].source.title, "Source");
  assert.equal(attachedB.references[0].referenceType, "share");
  assert.equal(attachedB.references[0].transcriptAvailable, true);

  const duplicate = context.attachConversationSharesFromText("B", link);
  assert.equal(duplicate.attachedCount, 0);

  const attachedC = context.attachConversationSharesFromText("C", link);
  assert.equal(attachedC.attachedCount, 1);
  assert.equal(context.listConversationContextPayloads("C")[0].brief.originalGoal, "Build sharing");

  const afterRemove = context.removeConversationContextReference(
    "B",
    attachedB.references[0].id
  );
  assert.deepEqual(afterRemove, []);
  assert.equal(context.listConversationContextReferences("C").length, 1);
});

test("invalid share token is rejected without creating a reference", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  const db = makeDb();
  const context = await import("../dist-electron/cli/conversationContext.js");
  context.setConversationContextDbForTest(db);
  t.after(() => {
    context.setConversationContextDbForTest(null);
    db.close();
  });

  assert.throws(
    () =>
      context.attachConversationSharesFromText(
        "B",
        "freebuddy://conversation-share/v1/invalid_token_value_1234"
      ),
    /invalid, expired, or revoked/
  );
  assert.deepEqual(context.listConversationContextReferences("B"), []);
});


test("legacy transfer rows resolve as canonical context references", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  const db = makeDb();
  const context = await import("../dist-electron/cli/conversationContext.js");
  const handoffs = await import("../dist-electron/cli/handoffBriefs.js");
  context.setConversationContextDbForTest(db);
  handoffs.setDbForTest(db);
  t.after(() => {
    context.setConversationContextDbForTest(null);
    handoffs.setDbForTest(null);
    db.close();
  });

  handoffs.insertHandoffBrief({
    id: "legacy-transfer",
    sourceConversationId: "A",
    targetConversationId: "B",
    sourceAgentId: "codex",
    sourceAgentName: "Codex",
    sourceAdapter: "codex-acp",
    brief,
    sourceMessageCount: 3,
    sourceLastMessageId: "m3"
  });

  const references = context.listResolvedConversationContextPayloads("B");
  assert.equal(references.length, 1);
  assert.equal(references[0].id, "legacy-transfer");
  assert.equal(references[0].referenceType, "transfer");
  assert.equal(references[0].brief.originalGoal, "Build sharing");
});

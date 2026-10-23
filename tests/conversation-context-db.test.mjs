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
    CREATE TABLE conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
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

async function contextForTest(t) {
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
  return { db, context };
}

function insertMessage(db, {
  id,
  content,
  conversationId = "B",
  role = "user",
  createdAt = "2026-10-23T08:00:00.000Z"
}) {
  db.prepare(
    `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, conversationId, role, content, createdAt);
}

function targetMessagesBySnapshot(references) {
  return Object.fromEntries(
    references.map((reference) => [reference.snapshotId, reference.targetMessageId])
  );
}

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

test("share references stay with their original messages across complete history and later sends", async (t) => {
  const setup = await contextForTest(t);
  if (!setup) return;
  const { db, context } = setup;
  context.insertConversationContextSnapshot({ id: "snapshot-1", brief });
  context.insertConversationContextSnapshot({ id: "snapshot-2", brief });
  const first = context.createConversationShareToken("snapshot-1");
  const second = context.createConversationShareToken("snapshot-2");
  const prompt = `${first}\n${first}\n${second}`;

  const attached = context.attachConversationSharesFromText("B", prompt, "pending-message");
  assert.equal(attached.attachedCount, 2);
  assert.deepEqual(targetMessagesBySnapshot(attached.references), {
    "snapshot-1": "pending-message",
    "snapshot-2": "pending-message"
  });
  // Pending annotations are response-only until the actual user message exists.
  assert.deepEqual(targetMessagesBySnapshot(context.listConversationContextReferences("B")), {
    "snapshot-1": undefined,
    "snapshot-2": undefined
  });

  insertMessage(db, { id: "other-conversation", conversationId: "C", content: prompt });
  insertMessage(db, { id: "assistant-quote", role: "assistant", content: prompt });
  insertMessage(db, { id: "original-message", content: prompt });
  for (let index = 0; index < 80; index += 1) {
    insertMessage(db, {
      id: `followup-${index}`,
      content: `Unrelated follow-up ${index}`,
      createdAt: "2026-10-23T09:00:00.000Z"
    });
  }
  insertMessage(db, {
    id: "repeat-message",
    content: prompt,
    createdAt: "2026-10-23T10:00:00.000Z"
  });

  const expected = {
    "snapshot-1": "original-message",
    "snapshot-2": "original-message"
  };
  assert.deepEqual(targetMessagesBySnapshot(context.listConversationContextReferences("B")), expected);
  const repeat = context.attachConversationSharesFromText("B", prompt, "next-message");
  assert.equal(repeat.attachedCount, 0);
  assert.deepEqual(targetMessagesBySnapshot(repeat.references), expected);
  const plain = context.attachConversationSharesFromText("B", "Another ordinary message", "latest-message");
  assert.equal(plain.attachedCount, 0);
  assert.deepEqual(targetMessagesBySnapshot(plain.references), expected);
});

test("share ownership follows exact snapshot tokens and stable message order, excluding transfer references", async (t) => {
  const setup = await contextForTest(t);
  if (!setup) return;
  const { db, context } = setup;
  for (const id of ["snapshot-1", "snapshot-2", "transfer-snapshot"]) {
    context.insertConversationContextSnapshot({ id, brief });
  }
  const first = context.createConversationShareToken("snapshot-1");
  const alias = context.createConversationShareToken("snapshot-1");
  const second = context.createConversationShareToken("snapshot-2");
  const transferLink = context.createConversationShareToken("transfer-snapshot");
  // Reference creation order differs from message order.
  context.attachConversationSharesFromText("B", second);
  context.attachConversationSharesFromText("B", first);
  context.insertConversationContextReference({
    targetConversationId: "B",
    snapshotId: "transfer-snapshot",
    referenceType: "transfer"
  });

  insertMessage(db, {
    id: "later-but-inserted-first",
    content: first,
    createdAt: "2026-10-23T10:00:00.000Z"
  });
  insertMessage(db, { id: "z-first-at-timestamp", content: `${alias}\n${transferLink}` });
  insertMessage(db, { id: "a-second-at-timestamp", content: first });
  insertMessage(db, {
    id: "second-snapshot-message",
    content: second,
    createdAt: "2026-10-23T09:00:00.000Z"
  });

  assert.deepEqual(targetMessagesBySnapshot(context.listConversationContextReferences("B")), {
    "snapshot-1": "z-first-at-timestamp",
    "snapshot-2": "second-snapshot-message",
    "transfer-snapshot": undefined
  });
  const attachedTransfer = context.attachConversationSharesFromText("B", transferLink, "pending-transfer");
  assert.equal(attachedTransfer.references.find((reference) => reference.snapshotId === "transfer-snapshot").targetMessageId, undefined);
});

test("expired and revoked tokens still identify historical share messages", async (t) => {
  const setup = await contextForTest(t);
  if (!setup) return;
  const { db, context } = setup;
  context.insertConversationContextSnapshot({ id: "expired-snapshot", brief });
  context.insertConversationContextSnapshot({ id: "revoked-snapshot", brief });
  const expired = context.createConversationShareToken("expired-snapshot");
  const revoked = context.createConversationShareToken("revoked-snapshot");
  context.attachConversationSharesFromText("B", `${expired}\n${revoked}`);
  insertMessage(db, { id: "historical-expired", content: expired });
  insertMessage(db, { id: "historical-revoked", content: revoked });
  db.prepare("UPDATE conversation_share_tokens SET expires_at = ? WHERE snapshot_id = ?")
    .run("2000-01-01T00:00:00.000Z", "expired-snapshot");
  db.prepare("UPDATE conversation_share_tokens SET revoked_at = ? WHERE snapshot_id = ?")
    .run("2000-01-01T00:00:00.000Z", "revoked-snapshot");

  assert.deepEqual(targetMessagesBySnapshot(context.listConversationContextReferences("B")), {
    "expired-snapshot": "historical-expired",
    "revoked-snapshot": "historical-revoked"
  });
  for (const link of [expired, revoked]) {
    assert.throws(
      () => context.attachConversationSharesFromText("C", link, "new-message"),
      /invalid, expired, or revoked/
    );
  }
  assert.deepEqual(context.listConversationContextReferences("C"), []);
});

test("pending share annotations apply only to snapshots introduced by that prompt", async (t) => {
  const setup = await contextForTest(t);
  if (!setup) return;
  const { context } = setup;
  context.insertConversationContextSnapshot({ id: "orphaned-snapshot", brief });
  context.insertConversationContextSnapshot({ id: "new-snapshot", brief });
  const orphaned = context.createConversationShareToken("orphaned-snapshot");
  const fresh = context.createConversationShareToken("new-snapshot");
  context.attachConversationSharesFromText("B", orphaned);

  const result = context.attachConversationSharesFromText("B", fresh, "pending-new-message");
  assert.deepEqual(targetMessagesBySnapshot(result.references), {
    "orphaned-snapshot": undefined,
    "new-snapshot": "pending-new-message"
  });
  const plain = context.attachConversationSharesFromText("B", "No share links", "plain-message");
  assert.deepEqual(targetMessagesBySnapshot(plain.references), {
    "orphaned-snapshot": undefined,
    "new-snapshot": undefined
  });
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

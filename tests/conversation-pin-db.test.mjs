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
  return db;
}

const convInput = (id) => ({
  id,
  title: id,
  agentId: "agent",
  agentName: "Agent",
  adapter: "codex-acp"
});

async function setup() {
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const conversations = await import("../dist-electron/cli/conversations.js");
  return {
    db,
    createConversation: conversations.createConversation,
    appendMessage: conversations.appendMessage,
    listConversations: conversations.listConversations,
    setConversationPinned: conversations.setConversationPinned,
    cleanup() {
      setDbForTest(null);
      db.close();
    }
  };
}

test("pinning floats a conversation above newer unpinned ones", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(convInput("old"));
    ctx.createConversation(convInput("new"));
    // Distinct past activity times: "new" is the more recent conversation.
    ctx.db
      .prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", "old");
    ctx.db
      .prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?")
      .run("2026-02-01T00:00:00.000Z", "new");
    assert.deepEqual(
      ctx.listConversations({ archived: false }).map((c) => c.id),
      ["new", "old"]
    );

    const pinned = ctx.setConversationPinned("old", true);
    assert.equal(pinned.pinned, true);
    assert.ok(pinned.pinnedAt);

    assert.deepEqual(
      ctx.listConversations({ archived: false }).map((c) => c.id),
      ["old", "new"]
    );

    const unpinned = ctx.setConversationPinned("old", false);
    assert.equal(unpinned.pinned, false);
    assert.equal(unpinned.pinnedAt, undefined);
    assert.deepEqual(
      ctx.listConversations({ archived: false }).map((c) => c.id),
      ["new", "old"]
    );
  } finally {
    ctx.cleanup();
  }
});

test("multiple pins keep most-recently-pinned on top", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(convInput("a"));
    ctx.createConversation(convInput("b"));
    ctx.setConversationPinned("a", true);
    // Later pinnedAt wins the top slot.
    ctx.db
      .prepare("UPDATE conversations SET pinned_at = ? WHERE id = ?")
      .run("2026-01-02T00:00:00.000Z", "b");
    ctx.db
      .prepare("UPDATE conversations SET pinned = 1 WHERE id = ?")
      .run("b");
    ctx.db
      .prepare("UPDATE conversations SET pinned_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", "a");

    assert.deepEqual(
      ctx.listConversations({ archived: false }).map((c) => c.id),
      ["b", "a"]
    );
  } finally {
    ctx.cleanup();
  }
});

test("pin rejects unknown conversations", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    assert.throws(
      () => ctx.setConversationPinned("ghost", true),
      /Conversation not found/
    );
  } finally {
    ctx.cleanup();
  }
});

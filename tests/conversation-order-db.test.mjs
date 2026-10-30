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
    listConversations: conversations.listConversations,
    getConversation: conversations.getConversation,
    setConversationOrder: conversations.setConversationOrder,
    resetConversationOrder: conversations.resetConversationOrder,
    cleanup() {
      setDbForTest(null);
      db.close();
    }
  };
}

function seedOrdered(ctx) {
  // c (oldest) … a (newest): default activity order is a, b, c.
  ctx.createConversation(convInput("c"));
  ctx.createConversation(convInput("b"));
  ctx.createConversation(convInput("a"));
  ctx.db
    .prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?")
    .run("2026-01-01T00:00:00.000Z", "c");
  ctx.db
    .prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?")
    .run("2026-02-01T00:00:00.000Z", "b");
  ctx.db
    .prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?")
    .run("2026-03-01T00:00:00.000Z", "a");
  assert.deepEqual(
    ctx.listConversations({ archived: false }).map((conv) => conv.id),
    ["a", "b", "c"]
  );
}

test("manual order persists positions; the global list stays activity-ordered", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    seedOrdered(ctx);

    const updated = ctx.setConversationOrder(["c", "a", "b"]);
    assert.equal(updated.length, 3);
    // Positions are persisted for the client to apply within a group.
    assert.deepEqual(
      updated.map((conv) => [conv.id, conv.sortPosition]),
      [["c", 0], ["a", 1024], ["b", 2048]]
    );
    assert.equal(ctx.getConversation("c").sortPosition, 0);
    assert.equal(ctx.getConversation("a").sortPosition, 1024);
    assert.equal(ctx.getConversation("b").sortPosition, 2048);

    // The DB list itself keeps main's pagination contract (activity order,
    // pins first): per-group positions from different groups overlap, so
    // ordering the global list by them would break the LIMIT truncation.
    // Applying the manual order is the client's job (grouping util).
    assert.deepEqual(
      ctx.listConversations({ archived: false }).map((conv) => conv.id),
      ["a", "b", "c"]
    );
    assert.deepEqual(
      ctx.listConversations({ archived: false }).map((conv) => conv.sortPosition),
      [1024, 2048, 0]
    );

    // A brand-new conversation has no position; the DB list keeps pure
    // activity order and the client floats the unpositioned row above
    // positioned rows inside its group.
    ctx.createConversation(convInput("new"));
    ctx.db
      .prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?")
      .run("2026-01-15T00:00:00.000Z", "new");
    assert.deepEqual(
      ctx.listConversations({ archived: false }).map((conv) => conv.id),
      ["a", "b", "new", "c"]
    );
    assert.equal(ctx.getConversation("new").sortPosition, null);
  } finally {
    ctx.cleanup();
  }
});

test("reordering never touches updated_at", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    seedOrdered(ctx);
    const before = ctx.getConversation("a").updatedAt;

    ctx.setConversationOrder(["c", "a", "b"]);
    assert.equal(ctx.getConversation("a").updatedAt, before);
  } finally {
    ctx.cleanup();
  }
});

test("reset restores activity ordering", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    seedOrdered(ctx);
    ctx.setConversationOrder(["c", "a", "b"]);

    const updated = ctx.resetConversationOrder(["c", "a", "b"]);
    assert.equal(updated.length, 3);
    assert.ok(updated.every((conv) => conv.sortPosition === null));
    assert.deepEqual(
      ctx.listConversations({ archived: false }).map((conv) => conv.id),
      ["a", "b", "c"]
    );
  } finally {
    ctx.cleanup();
  }
});

test("order accepts a subset, ignores unknown ids, rejects bad input", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    seedOrdered(ctx);

    // Position only "b"; the untouched rows stay null and the client lets
    // them lead within the group.
    ctx.setConversationOrder(["b"]);
    assert.equal(ctx.getConversation("b").sortPosition, 0);
    assert.equal(ctx.getConversation("a").sortPosition, null);
    assert.equal(ctx.getConversation("c").sortPosition, null);

    const updated = ctx.setConversationOrder(["a", "ghost", "c"]);
    assert.deepEqual(updated.map((conv) => conv.id), ["a", "c"]);
    // Previously positioned rows keep their position until reset.
    assert.equal(ctx.getConversation("b").sortPosition, 0);

    assert.throws(() => ctx.setConversationOrder("a"), /array/);
    assert.throws(() => ctx.setConversationOrder(["a", 42]), /array/);
  } finally {
    ctx.cleanup();
  }
});

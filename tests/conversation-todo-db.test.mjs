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
  const caller = await import("../dist-electron/cli/callerContext.js");
  return {
    db,
    createConversation: conversations.createConversation,
    getConversation: conversations.getConversation,
    listConversations: conversations.listConversations,
    setConversationTodo: conversations.setConversationTodo,
    runAsCaller: caller.runAsCaller,
    cleanup() {
      setDbForTest(null);
      db.close();
    }
  };
}

test("toggling todo persists state without changing regular list membership or activity order", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(convInput("older"));
    ctx.createConversation(convInput("newer"));
    ctx.db
      .prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", "older");
    ctx.db
      .prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?")
      .run("2026-02-01T00:00:00.000Z", "newer");

    const initial = ctx.listConversations({ archived: false });
    assert.deepEqual(initial.map((c) => [c.id, c.todo, c.todoAt]), [
      ["newer", false, undefined],
      ["older", false, undefined]
    ]);

    const marked = ctx.setConversationTodo("older", true);
    assert.equal(marked.todo, true);
    assert.ok(marked.todoAt);
    assert.equal(ctx.getConversation("older")?.todo, true);

    // Way A: conversation stays in regular list and keeps its original activity order.
    assert.deepEqual(
      ctx.listConversations({ archived: false }).map((c) => c.id),
      ["newer", "older"]
    );

    const cleared = ctx.setConversationTodo("older", false);
    assert.equal(cleared.todo, false);
    assert.equal(cleared.todoAt, undefined);
    assert.equal(ctx.getConversation("older")?.todo, false);
  } finally {
    ctx.cleanup();
  }
});

test("setConversationTodo enforces conversation existence and ownership", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    assert.throws(
      () => ctx.setConversationTodo("missing", true),
      /Conversation not found/
    );

    ctx.runAsCaller("alice", () => ctx.createConversation(convInput("alice-conv")));
    assert.throws(
      () => ctx.runAsCaller("bob", () => ctx.setConversationTodo("alice-conv", true)),
      /Conversation not found/
    );
    const updated = ctx.runAsCaller("alice", () =>
      ctx.setConversationTodo("alice-conv", true)
    );
    assert.equal(updated.todo, true);
  } finally {
    ctx.cleanup();
  }
});

test("migrate adds todo and todo_at columns to legacy conversations tables", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate } = await import("../dist-electron/cli/db.js");
  try {
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
        updated_at TEXT NOT NULL
      );
      INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
      VALUES ('legacy-1', 'Legacy', 'agent', 'Agent', 'codex-acp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    migrate(db);
    const cols = db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name);
    assert.ok(cols.includes("todo"));
    assert.ok(cols.includes("todo_at"));
    const row = db.prepare("SELECT todo, todo_at FROM conversations WHERE id = 'legacy-1'").get();
    assert.equal(row.todo, 0);
    assert.equal(row.todo_at, null);
  } finally {
    db.close();
  }
});

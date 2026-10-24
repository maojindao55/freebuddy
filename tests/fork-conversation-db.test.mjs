import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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

const baseInput = (id) => ({
  id,
  title: `conv-${id}`,
  agentId: "agent",
  agentName: "Agent",
  adapter: "codex-acp"
});

async function setup() {
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const conversations = await import("../dist-electron/cli/conversations.js");
  const { forkConversation } = await import("../dist-electron/cli/conversationFork.js");
  migrate(db);
  setDbForTest(db);
  return {
    db,
    forkConversation,
    createConversation: conversations.createConversation,
    appendMessage: conversations.appendMessage,
    listMessages: conversations.listMessages,
    deleteConversation: conversations.deleteConversation,
    cleanup() {
      setDbForTest(null);
      db.close();
    }
  };
}

function seedTurns(ctx, conversationId, turns) {
  for (const [id, role, content, extra = {}] of turns) {
    ctx.appendMessage({
      id,
      conversationId,
      role,
      status: role === "user" ? "sent" : "done",
      content,
      ...extra
    });
  }
}

test("fork copies messages through the fork point and leaves the source untouched", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(baseInput("src"));
    const turns = [
      ["u1", "user", "first question"],
      ["a1", "assistant", JSON.stringify([{ kind: "text", content: "first answer" }])],
      ["u2", "user", "second question"],
      ["a2", "assistant", JSON.stringify([{ kind: "text", content: "second answer" }])],
      ["u3", "user", "third question"]
    ];
    seedTurns(ctx, "src", turns);

    const result = ctx.forkConversation({
      sourceConversationId: "src",
      throughMessageId: "a2",
      targetConversationId: "fork1",
      title: "Forked title"
    });
    assert.equal(result.conversation.id, "fork1");
    assert.equal(result.conversation.title, "Forked title");
    assert.equal(result.copiedMessages, 4);
    assert.equal(result.conversation.metadata.forkedFrom, "src");
    assert.equal(result.conversation.metadata.forkedAtMessageId, "a2");

    const forkMessages = ctx.listMessages("fork1");
    assert.deepEqual(forkMessages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.deepEqual(
      forkMessages.map((m) => m.content),
      turns.slice(0, 4).map(([, , content]) => content)
    );
    // Fresh message ids: no collision with the source rows.
    assert.ok(forkMessages.every((m) => !["u1", "a1", "u2", "a2", "u3"].includes(m.id)));
    // Timestamps (and therefore ordering, incl. equal-timestamp rowid ties)
    // carry over so the fork reads identically to the source prefix.
    const sourceMessages = ctx.listMessages("src");
    assert.deepEqual(
      forkMessages.map((m) => m.createdAt),
      sourceMessages.slice(0, 4).map((m) => m.createdAt)
    );
    // The source conversation is untouched.
    assert.deepEqual(
      sourceMessages.map((m) => m.id),
      ["u1", "a1", "u2", "a2", "u3"]
    );
  } finally {
    ctx.cleanup();
  }
});

test("fork strips session markers so it never resumes the source native session", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(baseInput("src"));
    const withSession = JSON.stringify([
      { kind: "session", sessionId: "native-1" },
      { kind: "text", content: "answer" },
      { kind: "tool-call", id: "call-1", toolOutputs: [] }
    ]);
    seedTurns(ctx, "src", [
      ["u1", "user", "question"],
      ["a1", "assistant", withSession]
    ]);

    ctx.forkConversation({
      sourceConversationId: "src",
      throughMessageId: "a1",
      targetConversationId: "fork1"
    });
    const forkAssistant = ctx.listMessages("fork1").find((m) => m.role === "assistant");
    const items = JSON.parse(forkAssistant.content);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["text", "tool-call"]
    );
    // The source keeps its session marker.
    const sourceAssistant = ctx.listMessages("src").find((m) => m.role === "assistant");
    assert.equal(JSON.parse(sourceAssistant.content)[0].kind, "session");
  } finally {
    ctx.cleanup();
  }
});

test("fork re-keys file edit blobs and rewrites message references", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(baseInput("src"));
    const oldKey = "a".repeat(64);
    const payload = Buffer.from(JSON.stringify({ oldText: "a", newText: "b" }), "utf8");
    ctx.db.prepare(
      `INSERT INTO file_edit_blobs
         (blob_key, conversation_id, task_id, tool_call_id, entry_index, path,
          action, partial, status, active, counts, payload)
       VALUES (?, 'src', 'task-9', 'call-9', 0, '/tmp/a.txt', 'update', 0, 'completed', 1, NULL, ?)`
    ).run(oldKey, payload);
    seedTurns(ctx, "src", [
      ["u1", "user", "edit a file"],
      [
        "a1",
        "assistant",
        JSON.stringify([
          { kind: "file-edit", path: "/tmp/a.txt", action: "update", blobKey: oldKey }
        ]),
        { taskId: "task-9" }
      ]
    ]);

    ctx.forkConversation({
      sourceConversationId: "src",
      throughMessageId: "a1",
      targetConversationId: "fork1"
    });

    const forkRow = ctx.db
      .prepare("SELECT blob_key, task_id, payload FROM file_edit_blobs WHERE conversation_id = 'fork1'")
      .get();
    assert.ok(forkRow, "fork owns a copied blob row");
    assert.notEqual(forkRow.blob_key, oldKey);
    assert.equal(forkRow.task_id, "task-9");
    assert.deepEqual(forkRow.payload, payload);
    // The copied row must be keyed exactly like a blob written live in the
    // fork (contentKey hashes the owning conversation in), so restore and
    // read paths keep resolving.
    const expectedKey = createHash("sha256")
      .update(JSON.stringify(["fork1", "task-9", "call-9", 0, "/tmp/a.txt", "update", false]))
      .update(payload)
      .digest("hex");
    assert.equal(forkRow.blob_key, expectedKey);

    const forkAssistant = ctx.listMessages("fork1").find((m) => m.role === "assistant");
    assert.equal(JSON.parse(forkAssistant.content)[0].blobKey, forkRow.blob_key);
    // The source row is untouched.
    assert.ok(
      ctx.db.prepare("SELECT 1 FROM file_edit_blobs WHERE blob_key = ? AND conversation_id = 'src'").get(oldKey)
    );
  } finally {
    ctx.cleanup();
  }
});

test("fork survives deletion of the source conversation", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(baseInput("src"));
    const payload = Buffer.from(JSON.stringify({ oldText: "a", newText: "b" }), "utf8");
    ctx.db.prepare(
      `INSERT INTO file_edit_blobs
         (blob_key, conversation_id, task_id, tool_call_id, entry_index, path,
          action, partial, status, active, counts, payload)
       VALUES (?, 'src', 'task-9', 'call-9', 0, '/tmp/a.txt', 'update', 0, 'completed', 1, NULL, ?)`
    ).run("b".repeat(64), payload);
    seedTurns(ctx, "src", [
      ["u1", "user", "question"],
      [
        "a1",
        "assistant",
        JSON.stringify([
          { kind: "file-edit", path: "/tmp/a.txt", action: "update", blobKey: "b".repeat(64) }
        ]),
        { taskId: "task-9" }
      ]
    ]);
    ctx.forkConversation({
      sourceConversationId: "src",
      throughMessageId: "a1",
      targetConversationId: "fork1"
    });

    ctx.deleteConversation("src");

    assert.equal(ctx.listMessages("fork1").length, 2);
    assert.ok(
      ctx.db.prepare("SELECT payload FROM file_edit_blobs WHERE conversation_id = 'fork1'").get()
    );
  } finally {
    ctx.cleanup();
  }
});

test("a fork can itself be forked", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(baseInput("src"));
    seedTurns(ctx, "src", [
      ["u1", "user", "question"],
      ["a1", "assistant", JSON.stringify([{ kind: "text", content: "answer" }])]
    ]);
    ctx.forkConversation({
      sourceConversationId: "src",
      throughMessageId: "a1",
      targetConversationId: "fork1"
    });
    const fork1First = ctx.listMessages("fork1")[0];
    const result = ctx.forkConversation({
      sourceConversationId: "fork1",
      throughMessageId: fork1First.id,
      targetConversationId: "fork2"
    });
    assert.equal(result.copiedMessages, 1);
    assert.equal(result.conversation.metadata.forkedFrom, "fork1");
    assert.equal(ctx.listMessages("fork2")[0].content, "question");
  } finally {
    ctx.cleanup();
  }
});

test("fork rejects unknown sources, fork points and non-default kinds", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(baseInput("src"));
    seedTurns(ctx, "src", [["u1", "user", "question"]]);
    ctx.createConversation({ ...baseInput("wf"), kind: "workflow" });

    assert.throws(
      () => ctx.forkConversation({ sourceConversationId: "ghost", throughMessageId: "u1" }),
      /Source conversation not found/
    );
    assert.throws(
      () => ctx.forkConversation({ sourceConversationId: "src", throughMessageId: "missing" }),
      /Fork message not found/
    );
    assert.throws(
      () => ctx.forkConversation({ sourceConversationId: "wf", throughMessageId: "u1" }),
      /Only default conversations/
    );
    assert.throws(
      () => ctx.forkConversation({ sourceConversationId: "", throughMessageId: "u1" }),
      /source conversation id is required/
    );
  } finally {
    ctx.cleanup();
  }
});

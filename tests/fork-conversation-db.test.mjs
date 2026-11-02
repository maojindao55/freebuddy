import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

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
    getConversation: conversations.getConversation,
    moveConversationToProject: conversations.moveConversationToProject,
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
    // A caller-supplied target id that is already taken fails with a typed
    // error instead of a raw SQLite primary-key violation.
    ctx.createConversation(baseInput("taken"));
    assert.throws(
      () =>
        ctx.forkConversation({
          sourceConversationId: "src",
          throughMessageId: "u1",
          targetConversationId: "taken"
        }),
      /already exists/
    );
    // The occupied target conversation is untouched by the failed fork.
    assert.equal(ctx.listMessages("taken").length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("fork preserves source metadata alongside fork provenance", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation({
      ...baseInput("src"),
      metadata: {
        mcpServerIds: ["srv-1", "srv-2"],
        taskWorkspace: { mode: "worktree", sourceCwd: "/repo", worktreeRoot: "/wt" }
      }
    });
    seedTurns(ctx, "src", [["u1", "user", "question"]]);

    const result = ctx.forkConversation({
      sourceConversationId: "src",
      throughMessageId: "u1",
      targetConversationId: "fork1"
    });
    assert.deepEqual(result.conversation.metadata, {
      mcpServerIds: ["srv-1", "srv-2"],
      taskWorkspace: { mode: "worktree", sourceCwd: "/repo", worktreeRoot: "/wt" },
      forkedFrom: "src",
      forkedAtMessageId: "u1"
    });
  } finally {
    ctx.cleanup();
  }
});

test("fork copies per-message skill snapshots", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(baseInput("src"));
    const skill = {
      id: "review", name: "代码审查", rootPath: "/skills/review",
      contentHash: "hash-1", version: "1", source: "builtin"
    };
    seedTurns(ctx, "src", [
      ["u1", "user", "question"],
      [
        "a1",
        "assistant",
        JSON.stringify([{ kind: "text", content: "answer" }]),
        { skillSnapshot: [skill] }
      ]
    ]);

    ctx.forkConversation({
      sourceConversationId: "src",
      throughMessageId: "a1",
      targetConversationId: "fork1"
    });
    const forkAssistant = ctx.listMessages("fork1").find((m) => m.role === "assistant");
    assert.deepEqual(forkAssistant.skillSnapshot, [skill]);
    // The user message without a snapshot stays empty.
    const forkUser = ctx.listMessages("fork1").find((m) => m.role === "user");
    assert.deepEqual(forkUser.skillSnapshot, []);
  } finally {
    ctx.cleanup();
  }
});

test("fork returns the inherited conversation skills and final message timestamp", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(baseInput("src"));
    const snapshot = [{
      id: "review", name: "Review", rootPath: "/skills/review",
      contentHash: "pinned-hash", version: "1", source: "builtin"
    }];
    // A pinned snapshot can outlive the installed skill registry.
    ctx.db.prepare("UPDATE conversations SET skill_snapshot = ? WHERE id = 'src'")
      .run(JSON.stringify(snapshot));
    seedTurns(ctx, "src", [
      ["u1", "user", "question"],
      ["a1", "assistant", JSON.stringify([{ kind: "text", content: "answer" }])]
    ]);

    const result = ctx.forkConversation({
      sourceConversationId: "src",
      throughMessageId: "a1",
      targetConversationId: "fork1"
    });

    assert.deepEqual(result.conversation.skillSnapshot, snapshot);
    assert.equal(result.conversation.lastMessageAt, ctx.listMessages("src")[1].createdAt);
    assert.deepEqual(result.conversation, ctx.getConversation("fork1"));
  } finally {
    ctx.cleanup();
  }
});

for (const mode of ["directory", "worktree"]) {
  test(`fork keeps an explicitly detached ${mode} conversation in Recent`, async (t) => {
    if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
    const ctx = await setup();
    try {
      const { createProject, listProjects } = await import("../dist-electron/cli/projects.js");
      // Exercise current project assignment independently of legacy migration.
      ctx.db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)")
        .run("projects.cwdMigration.v1", "1");
      const repo = path.resolve("workspace", "repo");
      const project = createProject({ name: "Source", folders: [repo], primaryPath: repo });
      const cwd = mode === "worktree" ? path.join(repo, ".worktrees", "task") : repo;
      ctx.createConversation({
        ...baseInput("src"),
        projectId: project.id,
        cwd,
        ...(mode === "worktree" ? {
          metadata: { taskWorkspace: { mode: "worktree", sourceCwd: repo } }
        } : {})
      });
      ctx.moveConversationToProject("src", null);
      seedTurns(ctx, "src", [["u1", "user", "question"]]);
      const source = ctx.getConversation("src");

      const result = ctx.forkConversation({
        sourceConversationId: "src",
        throughMessageId: "u1",
        targetConversationId: "fork1"
      });

      assert.equal(result.conversation.projectId, undefined);
      assert.equal(result.conversation.metadata.projectDetached, true);
      assert.equal(result.conversation.cwd, cwd);
      assert.deepEqual(result.conversation, ctx.getConversation("fork1"));
      assert.deepEqual(ctx.getConversation("src"), source);
      assert.deepEqual(listProjects().map((entry) => entry.id), [project.id]);
    } finally {
      ctx.cleanup();
    }
  });
}

test("fork preserves file edit order within and across tasks", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(baseInput("src"));
    const payload = Buffer.from(JSON.stringify({ oldText: "a", newText: "b" }), "utf8");
    // Chronological order interleaves two tasks: seq 1 (task-1), 2 (task-2),
    // 3 (task-1), 4 (task-2). A copy that re-inserts in index/scan order
    // instead of sequence order scrambles the replay order in the fork.
    const rows = [
      [1, "k1", "task-1", "call-1", 0, "/tmp/one.txt"],
      [2, "k2", "task-2", "call-2", 0, "/tmp/two.txt"],
      [3, "k3", "task-1", "call-3", 0, "/tmp/three.txt"],
      [4, "k4", "task-2", "call-4", 0, "/tmp/four.txt"]
    ];
    for (const [sequence, key, taskId, callId, entryIndex, blobPath] of rows) {
      ctx.db.prepare(
        `INSERT INTO file_edit_blobs
           (sequence, blob_key, conversation_id, task_id, tool_call_id, entry_index, path,
            action, partial, status, active, counts, payload)
         VALUES (?, ?, 'src', ?, ?, ?, ?, 'update', 0, 'completed', 1, NULL, ?)`
      ).run(sequence, key, taskId, callId, entryIndex, blobPath, payload);
    }
    seedTurns(ctx, "src", [
      ["u1", "user", "edit files", { taskId: "task-1" }],
      ["a1", "assistant", JSON.stringify([{ kind: "text", content: "done" }]), { taskId: "task-1" }],
      ["u2", "user", "edit more", { taskId: "task-2" }],
      ["a2", "assistant", JSON.stringify([{ kind: "text", content: "done" }]), { taskId: "task-2" }]
    ]);

    ctx.forkConversation({
      sourceConversationId: "src",
      throughMessageId: "a2",
      targetConversationId: "fork1"
    });
    const forkOrder = ctx.db
      .prepare(
        `SELECT path FROM file_edit_blobs WHERE conversation_id = 'fork1' ORDER BY sequence ASC`
      )
      .all()
      .map((row) => row.path);
    assert.deepEqual(forkOrder, [
      "/tmp/one.txt",
      "/tmp/two.txt",
      "/tmp/three.txt",
      "/tmp/four.txt"
    ]);
  } finally {
    ctx.cleanup();
  }
});

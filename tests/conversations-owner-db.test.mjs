import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
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
  title: id,
  agentId: "agent",
  agentName: "Agent",
  adapter: "codex"
});

test("history pages bound content without dropping messages at size or count boundaries", async t => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const { createConversation, appendMessage, listMessagesForIpc } = await import("../dist-electron/cli/conversations.js");
  const { IPC_LIST_MESSAGES_PAGE_SIZE, IPC_LIST_MESSAGES_PAGE_CHARS } = await import("@freebuddy/cli-stream");
  migrate(db); setDbForTest(db);
  try {
    for (const [name, count, size] of [["large",9,300_000],["small",45,30]]) {
      createConversation(baseInput(name));
      const bodies = new Map();
      for (let i=0; i<count; i++) {
        const id = `${name}-${i}`;
        const content = JSON.stringify([{kind:"text",role:"assistant",content:`${i}:`+"x".repeat(size)}]);
        bodies.set(id, content);
        appendMessage({id,conversationId:name,role:"assistant",status:"done",content});
      }
      const ids = [];
      let cursor;
      for (;;) {
        const page = listMessagesForIpc(name, cursor);
        assert.ok(page.messages.length > 0 && page.messages.length <= IPC_LIST_MESSAGES_PAGE_SIZE);
        assert.ok(page.messages.reduce((sum,m)=>sum+m.content.length,0) <= IPC_LIST_MESSAGES_PAGE_CHARS);
        for (const message of page.messages) assert.equal(message.content,bodies.get(message.id));
        ids.unshift(...page.messages.map(m=>m.id));
        if (!page.hasMore) break;
        const oldest = page.messages[0];
        cursor = {beforeCreatedAt:oldest.createdAt,beforeId:oldest.id};
      }
      assert.deepEqual(ids,[...bodies.keys()]);
    }
  } finally {setDbForTest(null);db.close();}
});

test("createConversation stamps the caller as owner; listConversations filters by caller", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, listConversations } = await import("../dist-electron/cli/conversations.js");
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");

  runAsCaller("alice", () => createConversation(baseInput("a1")));
  runAsCaller("bob", () => createConversation(baseInput("b1")));

  const aliceView = runAsCaller("alice", () => listConversations().map((c) => c.id));
  assert.deepEqual(aliceView, ["a1"]);
  const bobView = runAsCaller("bob", () => listConversations().map((c) => c.id));
  assert.deepEqual(bobView, ["b1"]);

  // Internal calls with no caller see everything (trusted main-process).
  assert.equal(listConversations().length, 2);
});

test("createConversation records ownerId on the row", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, getConversation } = await import("../dist-electron/cli/conversations.js");
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");

  runAsCaller("alice", () => createConversation(baseInput("a1")));
  assert.equal(getConversation("a1")?.ownerId, "alice");
});

test("remote conversations expose the assigned source path separately from cwd", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, getConversation } =
    await import("../dist-electron/cli/conversations.js");
  const { runAsCaller } =
    await import("../dist-electron/cli/callerContext.js");

  const managedRoot = path.resolve("managed", "project");
  const sourceRoot = path.resolve("assigned", "project");
  db.prepare(
    `INSERT INTO remote_users
       (id, username, password_hash, is_owner, created_at, disabled)
     VALUES ('alice', 'alice', 'test-only', 0, 0, 0)`
  ).run();
  db.prepare(
    `INSERT INTO remote_workspaces
       (id, owner_id, source_path, workspace_path, created_at, updated_at)
     VALUES ('workspace-1', 'alice', ?, ?, '0', '0')`
  ).run(sourceRoot, managedRoot);

  const conversation = runAsCaller("alice", () =>
    createConversation({
      ...baseInput("a1"),
      cwd: path.join(managedRoot, "src")
    })
  );

  assert.equal(conversation.cwd, path.join(managedRoot, "src"));
  assert.equal(conversation.sourceCwd, path.join(sourceRoot, "src"));
  assert.equal(getConversation("a1")?.sourceCwd, path.join(sourceRoot, "src"));
});

test("requireOwnedConversation hides other users' conversations", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, requireOwnedConversation } = await import("../dist-electron/cli/conversations.js");
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");

  runAsCaller("alice", () => createConversation(baseInput("a1")));
  runAsCaller("bob", () => createConversation(baseInput("b1")));

  assert.equal(runAsCaller("alice", () => requireOwnedConversation("a1")?.id), "a1");
  assert.equal(runAsCaller("alice", () => requireOwnedConversation("b1")), undefined);
  // No caller (internal) still sees the row.
  assert.equal(requireOwnedConversation("b1")?.id, "b1");
});

test("callerCanAccessMessage gates messages by their conversation owner", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, appendMessage, callerCanAccessMessage } =
    await import("../dist-electron/cli/conversations.js");
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");

  runAsCaller("alice", () => createConversation(baseInput("a1")));
  runAsCaller("alice", () =>
    appendMessage({
      id: "m1",
      conversationId: "a1",
      role: "user",
      status: "sent",
      content: "hi"
    })
  );

  assert.equal(runAsCaller("alice", () => callerCanAccessMessage("m1")), true);
  assert.equal(
    runAsCaller("bob", () => callerCanAccessMessage("m1")),
    false,
    "bob cannot read or update a message in alice's conversation"
  );
  assert.equal(
    runAsCaller("bob", () => callerCanAccessMessage("missing")),
    false,
    "unknown message ids are denied"
  );
  assert.equal(
    runAsCaller("owner", () => callerCanAccessMessage("m1"), true),
    true,
    "admin keeps access"
  );
  assert.equal(callerCanAccessMessage("m1"), true, "internal calls keep access");
});

test("backfillMissingOwners assigns legacy rows to the owner", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { backfillMissingOwners, getConversation } = await import("../dist-electron/cli/conversations.js");

  db.prepare(
    `INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
     VALUES ('legacy', 'L', 'a', 'A', 'codex', '0', '0')`
  ).run();
  assert.equal(getConversation("legacy")?.ownerId, null);

  const changes = backfillMissingOwners("owner-id");
  assert.equal(changes, 1);
  assert.equal(getConversation("legacy")?.ownerId, "owner-id");
});

test("appendMessage stamps the author username on user messages", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, appendMessage, listMessages } = await import("../dist-electron/cli/conversations.js");

  createConversation(baseInput("c1"));
  appendMessage({
    id: "m1",
    conversationId: "c1",
    role: "user",
    status: "sent",
    content: "hi",
    authorUsername: "alice"
  });
  const msgs = listMessages("c1");
  assert.equal(msgs[0].authorUsername, "alice");
});

test("admin (desktop owner) sees every user's conversations", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, listConversations, requireOwnedConversation } = await import("../dist-electron/cli/conversations.js");
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");

  runAsCaller("alice", () => createConversation(baseInput("a1")));
  runAsCaller("bob", () => createConversation(baseInput("b1")));

  // Admin (isAdmin=true) sees all, regardless of the admin's own userId.
  const adminView = runAsCaller(
    "owner",
    () => listConversations().map((c) => c.id).sort(),
    true
  );
  assert.deepEqual(adminView, ["a1", "b1"]);

  // Admin can requireOwnedConversation on another user's conversation.
  assert.equal(
    runAsCaller("owner", () => requireOwnedConversation("a1")?.id, true),
    "a1"
  );

  // A regular user still only sees their own.
  assert.deepEqual(
    runAsCaller("bob", () => listConversations().map((c) => c.id)),
    ["b1"]
  );
});

test("listMessagesForIpc pages newest messages and does not load oversized blobs", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const {
    createConversation,
    appendMessage,
    listMessages,
    listMessagesForIpc,
    getMessageForIpc
  } = await import("../dist-electron/cli/conversations.js");
  const { MAX_IPC_MESSAGE_CONTENT_CHARS } = await import(
    "../dist-electron/cli/messagePayloadSanitize.js"
  );

  createConversation(baseInput("c1"));
  for (const id of ["m1", "m2", "m3", "m4", "m5"]) {
    appendMessage({
      id,
      conversationId: "c1",
      role: "user",
      status: "sent",
      content: id
    });
  }

  const page1 = listMessagesForIpc("c1", { limit: 2 });
  assert.equal(page1.hasMore, true);
  assert.deepEqual(
    page1.messages.map((entry) => entry.id),
    ["m4", "m5"]
  );

  const oldest = page1.messages[0];
  const page2 = listMessagesForIpc("c1", {
    limit: 2,
    beforeCreatedAt: oldest.createdAt,
    beforeId: oldest.id
  });
  assert.equal(page2.hasMore, true);
  assert.deepEqual(
    page2.messages.map((entry) => entry.id),
    ["m2", "m3"]
  );

  const hugeId = "huge";
  const huge = "x".repeat(MAX_IPC_MESSAGE_CONTENT_CHARS + 50_000);
  appendMessage({
    id: hugeId,
    conversationId: "c1",
    role: "assistant",
    status: "done",
    content: huge
  });
  const full = listMessages("c1");
  assert.equal(full.at(-1)?.content.length, huge.length);

  const ipcLatest = listMessagesForIpc("c1", { limit: 1 });
  assert.equal(ipcLatest.messages[0]?.id, hugeId);
  assert.ok(ipcLatest.messages[0].content.length <= MAX_IPC_MESSAGE_CONTENT_CHARS + 1);

  const ipcOne = getMessageForIpc(hugeId);
  assert.ok(ipcOne);
  assert.ok(ipcOne.content.length <= MAX_IPC_MESSAGE_CONTENT_CHARS + 1);

  // Legacy delegate rows can contain hundreds of MB. Confirm the SQL guard
  // bypasses substr entirely instead of loading the blob just to slice it.
  db.prepare("UPDATE conversation_messages SET content = ? WHERE id = ?")
    .run("x".repeat(MAX_IPC_MESSAGE_CONTENT_CHARS * 4 + 1), hugeId);
  db.function("substr", (value, start, length) => {
    assert.ok(value.length <= MAX_IPC_MESSAGE_CONTENT_CHARS * 4,
      "large blob must not be sliced");
    return value.slice(start - 1, start - 1 + length);
  });
  assert.match(getMessageForIpc(hugeId).content, /omitted/);
  assert.match(listMessagesForIpc("c1", { limit: 1 }).messages.at(-1).content, /omitted/);
});

test("listMessagesForIpc keeps insertion order when created_at timestamps collide", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, listMessagesForIpc } = await import(
    "../dist-electron/cli/conversations.js"
  );

  createConversation(baseInput("c1"));
  const ts = "2026-09-15T00:00:00.000Z";
  const insert = (id) =>
    db.prepare(
      `INSERT INTO conversation_messages
         (id, conversation_id, role, status, content, created_at, updated_at)
       VALUES (?, 'c1', 'user', 'sent', ?, ?, ?)`
    ).run(id, id, ts, ts);
  insert("z-first");
  insert("a-second");

  const latest = listMessagesForIpc("c1", { limit: 1 });
  assert.equal(latest.messages[0]?.id, "a-second");
  assert.equal(latest.hasMore, true);

  const older = listMessagesForIpc("c1", {
    limit: 1,
    beforeCreatedAt: latest.messages[0].createdAt,
    beforeId: latest.messages[0].id
  });
  assert.equal(older.messages[0]?.id, "z-first");
  assert.ok(older.messages[0].sequence < latest.messages[0].sequence);
  assert.equal(older.hasMore, false);
});

test("followup history skips UI-only messages, excluded current turns, and live assistants", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, appendMessage, listFollowupMessagesForIpc } = await import(
    "../dist-electron/cli/conversations.js"
  );
  createConversation(baseInput("c1"));
  createConversation(baseInput("c2"));
  const add = (id, role, status, content = id, conversationId = "c1") => appendMessage({
    id, conversationId, role, status, content
  });
  add("ask", "user", "sent", "Build the missing feature");
  add("failure", "assistant", "failed", "[]");
  for (let index = 0; index < 60; index++) add(`system-${index}`, "system", "done");
  add("current", "user", "sent", "continue");
  add("live", "assistant", "running", "[]");
  add("starting", "assistant", "starting", "[]");
  add("foreign", "user", "sent", "Private other conversation", "c2");
  const messages = listFollowupMessagesForIpc("c1", ["current", "live"]);
  assert.deepEqual(messages.map((message) => message.id), ["ask", "failure"]);
  assert.ok(messages[0].sequence < messages[1].sequence);
  for (let index = 0; index < 20; index++) add(`turn-${index}`, "user", "sent");
  const recent = listFollowupMessagesForIpc("c1");
  assert.equal(recent.length, 12);
  assert.equal(recent[0].id, "turn-8");
  assert.equal(recent.at(-1).id, "turn-19");
});

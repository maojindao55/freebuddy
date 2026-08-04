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

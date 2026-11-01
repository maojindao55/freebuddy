import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  registerDocStudioMainWindow,
  unregisterDocStudioMainWindow,
  isDocStudioMainWindowSender,
  addDocStudioEmbeddedConversation,
  removeDocStudioEmbeddedConversation,
  clearDocStudioEmbeddedConversations,
  listDocStudioEmbeddedConversations,
  isDocStudioConversationEmbedded
} from "../dist-electron/docStudioWindowRegistry.js";

// Docking is a per-conversation record set: switching the main window to
// another conversation must keep the record so clicking back re-docks, and
// records are only removed by an explicit pop-out, conversation deletion or
// main-window teardown. Open-conversation routing consults these records, so
// every path must leave them exact.
test("embedded dock records survive conversation switches and clear on pop-out, deletion and teardown", () => {
  clearDocStudioEmbeddedConversations();

  // Baseline: nothing docked.
  assert.deepEqual(listDocStudioEmbeddedConversations(), []);
  assert.equal(isDocStudioConversationEmbedded("conv-1"), false);

  // Docking a conversation records it.
  addDocStudioEmbeddedConversation("conv-1");
  assert.deepEqual(listDocStudioEmbeddedConversations(), ["conv-1"]);
  assert.equal(isDocStudioConversationEmbedded("conv-1"), true);
  assert.equal(isDocStudioConversationEmbedded("conv-2"), false);

  // Switching the main window to another conversation (docking it) keeps the
  // previous record: clicking back must re-dock instead of popping a
  // standalone window.
  addDocStudioEmbeddedConversation("conv-2");
  assert.deepEqual(listDocStudioEmbeddedConversations(), ["conv-1", "conv-2"]);
  assert.equal(isDocStudioConversationEmbedded("conv-1"), true);
  assert.equal(isDocStudioConversationEmbedded("conv-2"), true);

  // Docking the same conversation twice stays a single record.
  addDocStudioEmbeddedConversation("conv-2");
  assert.deepEqual(listDocStudioEmbeddedConversations(), ["conv-1", "conv-2"]);

  // Explicit pop-out (docStudio:openConversation) removes exactly that
  // conversation's record; the other dock stays.
  removeDocStudioEmbeddedConversation("conv-1");
  assert.deepEqual(listDocStudioEmbeddedConversations(), ["conv-2"]);
  assert.equal(isDocStudioConversationEmbedded("conv-1"), false);
  assert.equal(isDocStudioConversationEmbedded("conv-2"), true);

  // Removing an unknown conversation is a no-op, and empty ids never record.
  removeDocStudioEmbeddedConversation("conv-unknown");
  assert.deepEqual(listDocStudioEmbeddedConversations(), ["conv-2"]);
  addDocStudioEmbeddedConversation("");
  assert.deepEqual(listDocStudioEmbeddedConversations(), ["conv-2"]);

  // Only the registered main window's webContents going away clears all
  // docks; an unrelated id must not disturb them.
  registerDocStudioMainWindow(4242);
  assert.equal(isDocStudioMainWindowSender({ id: 4242 }), true);
  unregisterDocStudioMainWindow(9999);
  assert.deepEqual(listDocStudioEmbeddedConversations(), ["conv-2"]);
  unregisterDocStudioMainWindow(4242);
  assert.equal(isDocStudioMainWindowSender({ id: 4242 }), false);
  assert.deepEqual(listDocStudioEmbeddedConversations(), []);
  assert.equal(isDocStudioConversationEmbedded("conv-2"), false);
});

test("deleting a conversation drops its embedded dock record", async (t) => {
  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
    new Database(":memory:").close();
  } catch {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const db = new Database(":memory:");
  t.after(() => db.close());
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, deleteConversation, getConversation } =
    await import("../dist-electron/cli/conversations.js");

  clearDocStudioEmbeddedConversations();

  const doc = createConversation({
    id: "docked-doc-studio",
    title: "Docked document",
    agentId: "cli-qoder-acp",
    agentName: "Qoder",
    adapter: "qoder-acp",
    kind: "doc-studio",
    metadata: { docStudioFilePath: "/tmp/freebuddy-dock-test.docx" }
  });
  assert.equal(getConversation(doc.id)?.kind, "doc-studio");
  addDocStudioEmbeddedConversation(doc.id);
  assert.equal(isDocStudioConversationEmbedded(doc.id), true);

  // Deletion (cli:deleteConversation and the butler conversation_delete tool
  // both funnel through deleteConversation) must clear the dock record.
  deleteConversation(doc.id);
  assert.equal(getConversation(doc.id), undefined);
  assert.equal(isDocStudioConversationEmbedded(doc.id), false);
  assert.deepEqual(listDocStudioEmbeddedConversations(), []);
});

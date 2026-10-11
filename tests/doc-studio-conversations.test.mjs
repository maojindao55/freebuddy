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

test("DocStudio conversations retain their file and legacy mappings become reopenable", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = new Database(":memory:");
  t.after(() => db.close());
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { createConversation, getConversation, markDocStudioConversation } =
    await import("../dist-electron/cli/conversations.js");
  const { getSetting, setSetting } = await import("../dist-electron/cli/settings.js");
  const { migrateLegacyDocStudioConversations, resolveDocStudioOfficeFile } =
    await import("../dist-electron/officeEngineToolService.js");

  const filePath = path.resolve("documents", "draft.docx");
  createConversation({
    id: "new-doc-studio",
    title: "Draft",
    agentId: "cli-qoder-acp",
    agentName: "Qoder",
    adapter: "qoder-acp",
    kind: "doc-studio",
    metadata: { docStudioFilePath: filePath }
  });
  assert.equal(resolveDocStudioOfficeFile("new-doc-studio"), filePath);

  const legacy = createConversation({
    id: "legacy-doc-studio",
    title: "Older analysis",
    agentId: "cli-qoder-acp",
    agentName: "Qoder",
    adapter: "qoder-acp"
  });
  setSetting("docStudio.conversationByFile", JSON.stringify({ [filePath]: legacy.id }));
  migrateLegacyDocStudioConversations();
  const upgraded = getConversation(legacy.id);
  assert.equal(upgraded?.kind, "doc-studio");
  assert.equal(upgraded?.metadata?.docStudioFilePath, filePath);
  assert.equal(upgraded?.updatedAt, legacy.updatedAt);
  assert.equal(resolveDocStudioOfficeFile("legacy-doc-studio"), filePath);
  // Per-conversation metadata wins when the same file has a newer mapped chat.
  assert.equal(resolveDocStudioOfficeFile("new-doc-studio"), filePath);

  const blank = createConversation({
    id: "blank-doc-studio",
    title: "New document",
    agentId: "cli-qoder-acp",
    agentName: "Qoder",
    adapter: "qoder-acp",
    kind: "doc-studio"
  });
  assert.equal(resolveDocStudioOfficeFile(blank.id), null);
  assert.equal(markDocStudioConversation(blank.id, filePath), true);
  assert.equal(resolveDocStudioOfficeFile(blank.id), filePath);
  assert.equal(getSetting("docStudio.conversationByFile") !== null, true);

  createConversation({
    id: "game-session",
    title: "Game",
    agentId: "cli-qoder-acp",
    agentName: "Qoder",
    adapter: "qoder-acp",
    kind: "game"
  });
  assert.equal(markDocStudioConversation("game-session", filePath), false);
  assert.equal(getConversation("game-session")?.kind, "game");
});

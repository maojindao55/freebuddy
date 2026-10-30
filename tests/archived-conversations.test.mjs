import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("archived conversations are managed from a Settings tab", () => {
  const modal = read("../src/components/Settings/SettingsModal.tsx");
  const tab = read("../src/components/Settings/ArchivedConversationsTab.tsx");
  const list = read("../src/components/CLI/ConversationList.tsx");
  const store = read("../src/store/conversationStore.ts");
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  const css = read("../styles.css");

  // Settings tab registration, icon and grouping.
  assert.match(modal, /key: "archived", labelKey: "settings\.tabs\.archived"/);
  assert.match(modal, /archived: Archive/);
  assert.match(modal, /items: \["feed", "usage", "archived"\]/);
  assert.match(modal, /activeTab === "archived"/);
  assert.match(modal, /<ArchivedConversationsTab \/>/);

  // The tab loads the archived list on demand and never re-adds rows to the
  // main store until restore.
  assert.match(tab, /cliClient\.listConversations\(\{\s*archived: true/);
  assert.match(tab, /archiveConversation\(conversation\.id, false, conversation\)/);
  assert.match(tab, /deleteConversation\(conversation\.id\)/);
  assert.match(tab, /settings\.archived\.searchPlaceholder/);
  assert.match(tab, /settings\.archived\.restore/);

  // Sidebar rows keep main's integrated form: archive lives in the hover
  // quick actions and in the context menu, delete stays inside the menu.
  // The PR's standalone inline archive/menu buttons were dropped when the
  // row was rebased onto main's row-level context menu (#222).
  assert.match(list, /conv-action-button/);
  assert.match(list, /handleArchive\(\)/);
  assert.match(list, /archiveConversation\(conversation\.id, true\)/);
  assert.match(list, /key: "archive"/);
  assert.match(list, /key: "delete"/);
  assert.ok(
    !/conv-delete-button/.test(list),
    "the inline delete X button must be gone from sidebar rows"
  );
  assert.ok(
    !/conv-item-archive|conv-item-menu/.test(list),
    "the PR's inline archive/overflow buttons must not come back"
  );

  // Store: archive drops the row (and switches away when active); restore
  // re-inserts it at the top. Un-archiving without the archived row would be
  // invisible in the list, so the overload makes `restored` required exactly
  // when archived is false.
  assert.match(store, /archiveConversation\(id: string, archived: true\): Promise<void>/);
  assert.match(
    store,
    /archiveConversation\(\s*id: string,\s*archived: false,\s*restored: Conversation\s*\): Promise<void>/
  );
  assert.match(store, /activeId: s\.activeId === id \? next\[0\]\?\.id : s\.activeId/);
  assert.match(store, /\[\s*\{\s*\.\.\.restored, archived: false \},/);

  // Locales carry every key in both languages.
  for (const locale of [en, zh]) {
    assert.equal(locale.settings.tabs.archived.length > 0, true);
    for (const key of [
      "title",
      "subtitle",
      "searchPlaceholder",
      "count",
      "empty",
      "loading",
      "retry",
      "restore"
    ]) {
      assert.equal(typeof locale.settings.archived[key], "string");
    }
  }

  // Styles: only the settings list remains; the inline row button styles
  // were dropped together with the buttons.
  assert.match(css, /\.archived-conversations-list/);
  assert.doesNotMatch(css, /\.conv-item-archive/);
});

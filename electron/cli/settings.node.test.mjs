import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

const settings = await import("../../dist-electron/cli/settings.js");
const { migrate, setDbForTest } = await import("../../dist-electron/cli/db.js");

test("system language remains deterministic when Electron Node mode has no app API", () => {
  const database = new Database(":memory:");
  migrate(database);
  setDbForTest(database);
  try {
    assert.equal(settings.getLanguagePreference(), "system");
    assert.equal(settings.getLanguage(), "en");
    settings.setSetting("language", "zh-CN");
    assert.equal(settings.getLanguage(), "zh-CN");
    settings.setSetting("language", "unexpected");
    assert.equal(settings.getLanguagePreference(), "system");
    assert.equal(settings.getLanguage(), "en");
  } finally {
    setDbForTest(null);
    database.close();
  }
});

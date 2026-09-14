import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

const store = await import("../../dist-electron/cli/store.js");
const { migrate, setDbForTest } = await import("../../dist-electron/cli/db.js");

test("store domain helpers load in Electron Node mode without safeStorage", () => {
  const database = new Database(":memory:");
  migrate(database);
  setDbForTest(database);
  try {
    assert.deepEqual(store.listOverrides(), []);
  } finally {
    setDbForTest(null);
    database.close();
  }
});

test("missing safeStorage fails closed instead of selecting the base64 fallback", () => {
  assert.throws(() => store.encryptSecret("secret"), /safeStorage API is unavailable/);
  assert.equal(store.decryptSecret("safe:AA=="), undefined);
});

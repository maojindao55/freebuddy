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

test("createUser makes the first user the owner and verifies login", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  const { setDbForTest, createUser, verifyUserLogin, getLocalUserId, listUsers } =
    await import("../dist-electron/cli/users.js");
  setDbForTest(db);

  const { user: owner, password } = createUser({ username: "buddy" });
  assert.equal(owner.username, "buddy");
  assert.equal(owner.isOwner, true);
  assert.ok(password.length >= 8);
  assert.equal(getLocalUserId(), owner.id);
  assert.equal(listUsers().length, 1);

  assert.deepEqual(verifyUserLogin("buddy", password)?.id, owner.id);
  assert.equal(verifyUserLogin("buddy", "wrong"), null);
  assert.equal(verifyUserLogin("nobody", password), null);
});

test("createUser rejects duplicate / invalid usernames; second user is not owner", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  const { setDbForTest, createUser } = await import("../dist-electron/cli/users.js");
  setDbForTest(db);
  createUser({ username: "buddy" });

  const second = createUser({ username: "alice" });
  assert.equal(second.user.isOwner, false);

  assert.throws(() => createUser({ username: "buddy" }), /username_taken/);
  assert.throws(() => createUser({ username: "ab" }), /invalid_username/);
  assert.throws(() => createUser({ username: "bad name!" }), /invalid_username/);
  assert.throws(() => createUser({ username: "x".repeat(33) }), /invalid_username/);
});

test("deleteUser refuses the owner; resetUserPassword rotates the password", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  const { setDbForTest, createUser, deleteUser, resetUserPassword, verifyUserLogin, getUserById } =
    await import("../dist-electron/cli/users.js");
  setDbForTest(db);
  const { user: owner } = createUser({ username: "buddy" });
  const { user: alice, password: alicePw } = createUser({ username: "alice" });

  assert.throws(() => deleteUser(owner.id), /cannot_delete_owner/);
  assert.equal(deleteUser(alice.id), true);
  assert.equal(getUserById(alice.id), null);

  const reset = resetUserPassword(owner.id);
  assert.equal(verifyUserLogin("buddy", "freshly-generated-not-this"), null);
  assert.deepEqual(verifyUserLogin("buddy", reset.password)?.id, owner.id);
  assert.equal(verifyUserLogin("buddy", alicePw), null);
});

test("bootstrapOwnerFromLegacyPassword migrates the old single password", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  const { hashPassword } = await import("../dist-electron/shared/passwordHash.js");
  const legacyHash = hashPassword("legacy-secret");
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("remote.password", legacyHash);

  const { setDbForTest, bootstrapOwnerFromLegacyPassword, getOwnerUser, verifyUserLogin } =
    await import("../dist-electron/cli/users.js");
  setDbForTest(db);

  bootstrapOwnerFromLegacyPassword();
  const owner = getOwnerUser();
  assert.equal(owner?.username, "buddy");
  assert.equal(owner?.isOwner, true);
  assert.deepEqual(verifyUserLogin("buddy", "legacy-secret")?.id, owner.id);

  // idempotent: running again does not create a second owner
  bootstrapOwnerFromLegacyPassword();
  assert.equal(getOwnerUser()?.id, owner.id);
});

test("createUser defaults strictIsolation off; setUserStrictIsolation toggles members only", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  const {
    setDbForTest,
    createUser,
    setUserStrictIsolation,
    getUserById,
    listUsers
  } = await import("../dist-electron/cli/users.js");
  setDbForTest(db);

  const { user: owner } = createUser({ username: "buddy" });
  const { user: alice } = createUser({ username: "alice" });
  assert.equal(owner.strictIsolation, false);
  assert.equal(alice.strictIsolation, false);

  const enabled = createUser({ username: "carol", strictIsolation: true });
  assert.equal(enabled.user.strictIsolation, true);

  const toggled = setUserStrictIsolation(alice.id, true);
  assert.equal(toggled?.strictIsolation, true);
  assert.equal(getUserById(alice.id)?.strictIsolation, true);
  assert.equal(setUserStrictIsolation(alice.id, false)?.strictIsolation, false);

  assert.throws(
    () => setUserStrictIsolation(owner.id, true),
    /cannot_set_owner_strict_isolation/
  );
  assert.equal(
    listUsers().find((u) => u.id === owner.id)?.strictIsolation,
    false
  );

  const cols = db
    .prepare("PRAGMA table_info(remote_users)")
    .all()
    .map((row) => row.name);
  assert.ok(cols.includes("strict_isolation"));
});

test("getUserRoots/setUserRoots store per-user workspace roots", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  const { setDbForTest, createUser, getUserRoots, setUserRoots } =
    await import("../dist-electron/cli/users.js");
  setDbForTest(db);
  const { user: owner } = createUser({ username: "buddy" });
  const { user: alice } = createUser({ username: "alice" });

  assert.deepEqual(getUserRoots(owner.id), [], "defaults to empty");

  const ownerRoots = [
    path.resolve("/home/owner/projects"),
    path.resolve("/srv/repos")
  ].sort();
  const aliceRoot = path.resolve("/home/alice");
  const onlyRoot = path.resolve("/only");

  setUserRoots(owner.id, ["/home/owner/projects", "/srv/repos"]);
  setUserRoots(alice.id, ["/home/alice"]);

  assert.deepEqual(getUserRoots(owner.id), ownerRoots);
  assert.deepEqual(getUserRoots(alice.id), [aliceRoot], "isolated per user");

  // replace (not append)
  setUserRoots(owner.id, ["/only"]);
  assert.deepEqual(getUserRoots(owner.id), [onlyRoot]);
  assert.deepEqual(getUserRoots(alice.id), [aliceRoot], "alice unaffected");
});

test("migrateGlobalRootsToOwner moves the legacy global setting to the owner", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const db = makeDb();
  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  const { setDbForTest, createUser, migrateGlobalRootsToOwner, getUserRoots } =
    await import("../dist-electron/cli/users.js");
  setDbForTest(db);
  const { user: owner } = createUser({ username: "buddy" });

  const legacyRoots = [
    path.resolve("/legacy/a"),
    path.resolve("/legacy/b")
  ].sort();

  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(
    "remote.workspaceRoots",
    JSON.stringify(["/legacy/a", "/legacy/b"])
  );

  migrateGlobalRootsToOwner(owner.id);
  assert.deepEqual(getUserRoots(owner.id), legacyRoots);

  // idempotent: re-running does not duplicate
  migrateGlobalRootsToOwner(owner.id);
  assert.deepEqual(getUserRoots(owner.id), legacyRoots);
});

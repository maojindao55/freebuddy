import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

test("startup recovery fails orphaned running tasks and leaves finished ones", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  t.after(() => {
    setDbForTest(null);
    db.close();
  });
  const insert = db.prepare(
    `INSERT INTO cli_tasks
       (id, agent_id, agent_name, adapter, status, prompt, error_message, created_at, updated_at)
     VALUES (?, 'agent', 'Agent', 'dsh-acp', ?, 'prompt', ?, '2026-08-18T15:54:55.835Z', '2026-08-18T15:54:55.835Z')`
  );
  insert.run("stale", "running", null);
  insert.run("explained", "running", "already failed over");
  insert.run("finished", "done", null);

  const { recoverInterruptedTasks } = await import("../dist-electron/cli/conversations.js");
  assert.equal(recoverInterruptedTasks(), 2);
  assert.equal(recoverInterruptedTasks(), 0);

  const rows = db
    .prepare(`SELECT id, status, error_message, ended_at FROM cli_tasks ORDER BY id`)
    .all();
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.stale.status, "failed");
  assert.equal(byId.stale.error_message, "Interrupted by app restart");
  assert.ok(byId.stale.ended_at);
  assert.equal(byId.explained.status, "failed");
  assert.equal(byId.explained.error_message, "already failed over");
  assert.equal(byId.finished.status, "done");
  assert.equal(byId.finished.ended_at, null);
});

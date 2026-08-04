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

test("CLI tasks and tool sessions are scoped to the caller", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const { insertTask: insertRuntimeTask } =
    await import("../dist-electron/cli/runtimeShared.js");
  const { listTasks, getTask } = await import("../dist-electron/cli/tasks.js");
  const { saveToolSession, getToolSession } =
    await import("../dist-electron/cli/store.js");

  const insertTask = db.prepare(
    `INSERT INTO cli_tasks
       (id, agent_id, agent_name, adapter, status, prompt, owner_id,
        created_at, updated_at)
     VALUES (?, 'agent', 'Agent', 'codex', 'done', 'prompt', ?, '0', '0')`
  );
  insertTask.run("alice-task", "alice");
  insertTask.run("bob-task", "bob");

  assert.deepEqual(
    runAsCaller("alice", () => listTasks().map((task) => task.id)),
    ["alice-task"]
  );
  assert.equal(runAsCaller("alice", () => getTask("bob-task")), undefined);
  assert.equal(
    runAsCaller("owner", () => listTasks().length, true),
    2,
    "desktop administrator retains visibility"
  );

  runAsCaller("alice", () =>
    saveToolSession("agent", "/workspace", "codex", "alice-session")
  );
  runAsCaller("bob", () =>
    saveToolSession("agent", "/workspace", "codex", "bob-session")
  );
  assert.equal(
    runAsCaller("alice", () => getToolSession("agent", "/workspace")?.sessionId),
    "alice-session"
  );
  assert.equal(
    runAsCaller("bob", () => getToolSession("agent", "/workspace")?.sessionId),
    "bob-session"
  );

  runAsCaller("alice", () =>
    insertRuntimeTask(
      {
        sessionId: "alice-running-task",
        agentId: "agent",
        agentName: "Agent",
        adapter: "codex",
        cwd: "/workspace",
        prompt: "Run the task"
      },
      "/tmp/alice-running-task.jsonl"
    )
  );
  const runningTask = runAsCaller("alice", () =>
    getTask("alice-running-task")
  );
  assert.equal(runningTask?.status, "running");
  assert.equal(runningTask?.ownerId, "alice");
  assert.equal(runningTask?.cwd, "/workspace");

  setDbForTest(null);
  db.close();
});

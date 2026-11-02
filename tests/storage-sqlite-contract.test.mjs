import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryWorkflowRepository } from "../packages/workflow-runtime/dist/index.js";
import {
  createSqliteWorkflowRepository,
  createSqliteDelegationRepository
} from "../packages/storage-sqlite/dist/index.js";

test("memory and sqlite workflow repositories share create/get/update contracts", async (t) => {
  const memory = createMemoryWorkflowRepository();
  const created = memory.createRun({
    id: "run-1",
    name: "n",
    goal: "g",
    maxLoops: 1,
    planJson: "{}",
    runtimeVersion: "1.0.0",
    runtimeApiVersion: "1.0.0"
  });
  assert.equal(memory.getRun("run-1")?.name, "n");
  memory.updateRun("run-1", { status: "running" });
  assert.equal(memory.getRun("run-1")?.status, "running");
  memory.createStep({
    id: "step-1",
    workflowRunId: "run-1",
    phaseId: "p",
    stepId: "s",
    title: "t",
    agentId: "a",
    agentName: "a",
    adapter: "claude",
    mode: "research",
    prompt: "p"
  });
  assert.equal(memory.getSteps("run-1").length, 1);
  memory.resetStepsForLoop("run-1", ["p"]);
  assert.equal(memory.getSteps("run-1")[0]?.status, "pending");
  assert.equal(created.runtimeVersion, "1.0.0");

  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
    new Database(":memory:").close();
  } catch {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, owner_id TEXT);
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT, name TEXT, goal TEXT, status TEXT,
      cwd TEXT, template TEXT, loop_index INTEGER, max_loops INTEGER, plan_json TEXT,
      team_id TEXT, team_snapshot_json TEXT, plan_version INTEGER, kind TEXT,
      runtime_version TEXT, runtime_api_version TEXT, summary TEXT,
      created_at TEXT, updated_at TEXT, ended_at TEXT
    );
    CREATE TABLE workflow_steps (
      id TEXT PRIMARY KEY, workflow_run_id TEXT, phase_id TEXT, step_id TEXT, title TEXT,
      agent_id TEXT, agent_name TEXT, adapter TEXT, mode TEXT, status TEXT, prompt TEXT,
      depends_on TEXT, target_paths TEXT, summary TEXT, result_json TEXT, cli_task_id TEXT,
      tool_session_id TEXT, started_at TEXT, ended_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE workflow_teams (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, icon TEXT, enabled INTEGER,
      source TEXT, kind TEXT, roles_json TEXT, template_json TEXT, policy_json TEXT,
      delegation_meta_json TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE delegation_events (
      id TEXT PRIMARY KEY, run_id TEXT, parent_event_id TEXT, agent_id TEXT, agent_name TEXT,
      role_label TEXT, task_text TEXT, depth INTEGER, status TEXT, result_summary TEXT,
      result_json TEXT, can_write INTEGER, accepted_at TEXT, started_at TEXT, ended_at TEXT,
      verdict TEXT, verdict_summary TEXT
    );
  `);
  const sqlite = createSqliteWorkflowRepository({
    db,
    owner: { ownerUserId: null, isAdmin: true }
  });
  sqlite.createRun({
    id: "sql-1",
    name: "n",
    goal: "g",
    maxLoops: 1,
    planJson: "{}",
    runtimeVersion: "bundled",
    runtimeApiVersion: "1.0.0"
  });
  assert.equal(sqlite.getRun("sql-1")?.runtimeVersion, "bundled");
  const delegation = createSqliteDelegationRepository({
    db,
    owner: { ownerUserId: null, isAdmin: true }
  });
  const del = delegation.createRun({
    goal: "delegate",
    status: "running",
    teamId: "t",
    teamSnapshotJson: "{}",
    runtimeVersion: "1.0.0"
  });
  assert.equal(del.kind, "delegation");

  sqlite.createStep({
    id: "step-dup",
    workflowRunId: "sql-1",
    phaseId: "p",
    stepId: "s",
    title: "t",
    agentId: "a",
    agentName: "a",
    adapter: "claude",
    mode: "research",
    prompt: "p"
  });
  sqlite.createStep({
    id: "step-dup",
    workflowRunId: "sql-1",
    phaseId: "p",
    stepId: "s",
    title: "t",
    agentId: "a",
    agentName: "a",
    adapter: "claude",
    mode: "research",
    prompt: "p"
  });
  assert.equal(sqlite.getSteps("sql-1").length, 1);

  const { createMemoryDelegationRepository } = await import(
    "../packages/delegation-runtime/dist/index.js"
  );
  const memA = createMemoryDelegationRepository();
  const memB = createMemoryDelegationRepository();
  const firstRun = memA.createRun({
    goal: "first",
    status: "running",
    teamId: "t",
    teamSnapshotJson: "{}"
  });
  const secondRun = memB.createRun({
    goal: "second",
    status: "running",
    teamId: "t",
    teamSnapshotJson: "{}"
  });
  assert.notEqual(firstRun.id, secondRun.id);
  delegation.createRun({
    id: firstRun.id,
    goal: firstRun.goal,
    status: "running",
    teamId: "t",
    teamSnapshotJson: "{}"
  });
  delegation.createRun({
    id: secondRun.id,
    goal: secondRun.goal,
    status: "running",
    teamId: "t",
    teamSnapshotJson: "{}"
  });
  assert.equal(delegation.getRun(firstRun.id)?.goal, "first");
  assert.equal(delegation.getRun(secondRun.id)?.goal, "second");
  db.close();
});

test("sqlite insertDelegationEvent rethrows foreign key failures", async (t) => {
  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
    new Database(":memory:").close();
  } catch {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT, name TEXT, goal TEXT, status TEXT,
      cwd TEXT, template TEXT, loop_index INTEGER, max_loops INTEGER, plan_json TEXT,
      team_id TEXT, team_snapshot_json TEXT, plan_version INTEGER, kind TEXT,
      runtime_version TEXT, runtime_api_version TEXT, summary TEXT,
      created_at TEXT, updated_at TEXT, ended_at TEXT
    );
    CREATE TABLE delegation_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_event_id TEXT, agent_id TEXT,
      agent_name TEXT, role_label TEXT, task_text TEXT, depth INTEGER, status TEXT,
      result_summary TEXT, result_json TEXT, can_write INTEGER, accepted_at TEXT,
      started_at TEXT, ended_at TEXT, verdict TEXT, verdict_summary TEXT,
      FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );
  `);
  const {
    createDelegationRun,
    insertDelegationEvent,
    getDelegationEvent
  } = await import("../packages/storage-sqlite/dist/index.js");
  const ctx = { db, owner: { ownerUserId: null, isAdmin: true } };
  const event = {
    id: "fk-miss",
    runId: "no-such-run",
    parentEventId: null,
    agentId: "a",
    agentName: "a",
    roleLabel: "a",
    taskText: "t",
    depth: 0,
    canWrite: false,
    status: "pending"
  };
  assert.throws(
    () => insertDelegationEvent(ctx, event),
    (error) => String(error?.code ?? error).includes("CONSTRAINT")
  );
  assert.equal(getDelegationEvent(ctx, "fk-miss"), undefined);
  const runId = createDelegationRun(ctx, { goal: "g", teamId: "t", teamSnapshotJson: "{}" });
  const dup = { ...event, id: "dup-event", runId };
  assert.equal(insertDelegationEvent(ctx, dup), "dup-event");
  assert.equal(insertDelegationEvent(ctx, dup), "dup-event");
  assert.equal(getDelegationEvent(ctx, "dup-event")?.runId, runId);
  db.close();
});

test("sqlite delegation reopen resets attempt start time and clears end time", async (t) => {
  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
    new Database(":memory:").close();
  } catch {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT, name TEXT, goal TEXT, status TEXT,
      cwd TEXT, template TEXT, loop_index INTEGER, max_loops INTEGER, plan_json TEXT,
      team_id TEXT, team_snapshot_json TEXT, plan_version INTEGER, kind TEXT,
      runtime_version TEXT, runtime_api_version TEXT, summary TEXT,
      created_at TEXT, updated_at TEXT, ended_at TEXT
    );
    CREATE TABLE delegation_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_event_id TEXT, agent_id TEXT,
      agent_name TEXT, role_label TEXT, task_text TEXT, depth INTEGER, status TEXT,
      result_summary TEXT, result_json TEXT, can_write INTEGER, accepted_at TEXT,
      started_at TEXT, ended_at TEXT, verdict TEXT, verdict_summary TEXT
    );
  `);
  const {
    createDelegationRun,
    getDelegationEvent,
    insertDelegationEvent,
    transitionDelegationEvent
  } = await import("../packages/storage-sqlite/dist/index.js");
  let now = "2026-09-02T10:00:00.000Z";
  const ctx = {
    db,
    owner: { ownerUserId: null, isAdmin: true },
    nowIso: () => now
  };
  const runId = createDelegationRun(ctx, {
    goal: "g",
    teamId: "t",
    teamSnapshotJson: "{}"
  });
  const eventId = insertDelegationEvent(ctx, {
    runId,
    parentEventId: null,
    agentId: "a",
    agentName: "a",
    roleLabel: "a",
    taskText: "g",
    depth: 0,
    canWrite: true,
    status: "running"
  });
  now = "2026-09-02T10:10:00.000Z";
  assert.equal(transitionDelegationEvent(ctx, eventId, "failed", "empty"), true);
  now = "2026-09-02T15:00:00.000Z";
  assert.equal(
    transitionDelegationEvent(ctx, eventId, "running", null, { allowReopen: true }),
    true
  );
  const reopened = getDelegationEvent(ctx, eventId);
  assert.equal(reopened?.startedAt, "2026-09-02T15:00:00.000Z");
  assert.equal(reopened?.endedAt, null);
  now = "2026-09-02T16:00:00.000Z";
  assert.equal(
    transitionDelegationEvent(ctx, eventId, "running", null, { allowReopen: true }),
    true
  );
  assert.equal(
    getDelegationEvent(ctx, eventId)?.startedAt,
    "2026-09-02T15:00:00.000Z",
    "a queued follow-up must not reset an already-running attempt"
  );
  db.close();
});

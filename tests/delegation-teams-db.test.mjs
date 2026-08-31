import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

async function withDb(fn) {
  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  try {
    await fn(db);
  } finally {
    setDbForTest(null);
    db.close();
  }
}

test("migration adds kind and delegation_meta_json to workflow_teams", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb((db) => {
    const cols = db.prepare("PRAGMA table_info(workflow_teams)").all().map((c) => c.name);
    assert.ok(cols.includes("kind"), "workflow_teams.kind missing");
    assert.ok(cols.includes("delegation_meta_json"), "workflow_teams.delegation_meta_json missing");
  });
});

test("migration adds kind to workflow_runs", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb((db) => {
    const cols = db.prepare("PRAGMA table_info(workflow_runs)").all().map((c) => c.name);
    assert.ok(cols.includes("kind"), "workflow_runs.kind missing");
  });
});

test("migration creates delegation_events table with expected columns", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb((db) => {
    const cols = db.prepare("PRAGMA table_info(delegation_events)").all().map((c) => c.name);
    for (const name of [
      "id", "run_id", "parent_event_id", "agent_id", "agent_name", "role_label",
      "task_text", "depth", "status", "result_summary", "can_write",
      "accepted_at", "started_at", "ended_at", "verdict", "verdict_summary", "result_json"
    ]) {
      assert.ok(cols.includes(name), `delegation_events.${name} missing`);
    }
    const indexes = db.prepare("PRAGMA index_list('delegation_events')").all().map((i) => i.name);
    assert.ok(indexes.includes("idx_delegation_events_run"), "idx_delegation_events_run index missing");
  });
});

test("migration creates host_idempotency_keys created_at index", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb((db) => {
    const indexes = db.prepare("PRAGMA index_list('host_idempotency_keys')").all().map((i) => i.name);
    assert.ok(
      indexes.includes("idx_host_idempotency_keys_created_at"),
      "idx_host_idempotency_keys_created_at missing"
    );
  });
});

test("delegation event terminal states reject late executor writes", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const {
      createDelegationRun,
      getDelegationEvent,
      insertDelegationEvent,
      transitionDelegationEvent
    } = await import("../dist-electron/cli/delegationRuns.js");
    const runId = createDelegationRun({ goal: "g", teamId: "t", teamSnapshotJson: "{}" });
    const eventId = insertDelegationEvent({
      runId,
      parentEventId: null,
      agentId: "a",
      agentName: "A",
      roleLabel: "A",
      taskText: "slow task",
      depth: 0,
      canWrite: false,
      status: "pending"
    });

    assert.equal(transitionDelegationEvent(eventId, "running"), true);
    assert.equal(transitionDelegationEvent(eventId, "cancelled", "用户停止"), true);
    assert.equal(
      transitionDelegationEvent(eventId, "done", "late success"),
      false,
      "a late executor result must not overwrite cancellation"
    );
    assert.equal(getDelegationEvent(eventId)?.status, "cancelled");
    assert.equal(getDelegationEvent(eventId)?.resultSummary, "用户停止");
  });
});

test("delegation team CRUD round-trips roster, policy, entryRoleId", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { insertDelegationTeam, getDelegationTeam, listDelegationTeams, updateDelegationTeam, deleteDelegationTeam } =
      await import("../dist-electron/cli/delegationTeams.js");

    const roster = [
      { id: "r-impl", label: "实现", agentId: "cli-codex-acp", capability: "写代码", instructions: "直接实现并验证", canWrite: true },
      { id: "r-rev", label: "评审", agentId: "cli-claude-agent-acp", capability: "审代码", canWrite: false }
    ];
    const created = insertDelegationTeam({
      id: "team-del-1", name: "Impl+Review", sharedInstructions: "完成前必须验证", enabled: true, source: "user",
      entryRoleId: "r-impl", roster,
      policy: {
        allowWrites: true, requireApprovalBeforeDelegateWrite: true,
        maxDepth: 3, delegateTimeoutMs: 600000, maxConcurrentDelegates: 1,
        stopOnDelegateFailure: false
      }
    });
    assert.equal(created.kind, "delegation");
    assert.equal(created.entryRoleId, "r-impl");
    assert.equal(created.sharedInstructions, "完成前必须验证");
    assert.equal(created.roster.length, 2);

    const fetched = getDelegationTeam("team-del-1");
    assert.deepEqual(fetched?.roster, roster);

    assert.ok(listDelegationTeams().some((x) => x.id === "team-del-1"));

    updateDelegationTeam("team-del-1", { entryRoleId: "r-rev", name: "Renamed" });
    assert.equal(getDelegationTeam("team-del-1")?.entryRoleId, "r-rev");
    assert.equal(getDelegationTeam("team-del-1")?.name, "Renamed");
    assert.equal(getDelegationTeam("team-del-1")?.sharedInstructions, "完成前必须验证");

    updateDelegationTeam("team-del-1", { sharedInstructions: "更新后的共享规则" });
    assert.equal(getDelegationTeam("team-del-1")?.entryRoleId, "r-rev");
    assert.equal(getDelegationTeam("team-del-1")?.sharedInstructions, "更新后的共享规则");

    assert.equal(deleteDelegationTeam("team-del-1"), true);
    assert.equal(getDelegationTeam("team-del-1"), undefined);
  });
});

test("delegation team storage rejects invalid create and update policies", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { insertDelegationTeam, updateDelegationTeam } = await import(
      "../dist-electron/cli/delegationTeams.js"
    );
    const roster = [
      {
        id: "writer",
        label: "Writer",
        agentId: "cli-codex-acp",
        capability: "Write code",
        canWrite: true
      }
    ];
    const policy = {
      allowWrites: true,
      requireApprovalBeforeDelegateWrite: true,
      maxDepth: 3,
      delegateTimeoutMs: 600000,
      maxConcurrentDelegates: 1,
      stopOnDelegateFailure: false
    };

    assert.throws(
      () =>
        insertDelegationTeam({
          id: "team-invalid-create",
          name: "Invalid",
          enabled: true,
          source: "user",
          entryRoleId: "writer",
          roster,
          policy: { ...policy, allowWrites: false }
        }),
      /Writable roles require policy\.allowWrites/
    );

    insertDelegationTeam({
      id: "team-valid-update",
      name: "Valid",
      enabled: true,
      source: "user",
      entryRoleId: "writer",
      roster,
      policy
    });
    assert.throws(
      () => updateDelegationTeam("team-valid-update", {
        policy: { ...policy, allowWrites: false }
      }),
      /Writable roles require policy\.allowWrites/
    );
  });
});

test("listWorkflowTeams excludes delegation teams", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { insertDelegationTeam } = await import("../dist-electron/cli/delegationTeams.js");
    const { listWorkflowTeams } = await import("../dist-electron/cli/workflowTeams.js");

    insertDelegationTeam({
      id: "team-del-isolate", name: "Del", enabled: true, source: "user",
      entryRoleId: "r-1", roster: [{ id: "r-1", label: "x", agentId: "a", capability: "y", canWrite: false }],
      policy: {
        allowWrites: true, requireApprovalBeforeDelegateWrite: false,
        maxDepth: 2, delegateTimeoutMs: 1000, maxConcurrentDelegates: 1,
        stopOnDelegateFailure: false
      }
    });
    const ids = listWorkflowTeams().map((t) => t.id);
    assert.ok(!ids.includes("team-del-isolate"), "delegation team leaked into workflow list");
  });
});

test("seedBuiltinDelegationTeams is idempotent and appears in list", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { seedBuiltinDelegationTeams, getDelegationTeam, listDelegationTeams, updateDelegationTeam } =
      await import("../dist-electron/cli/delegationTeams.js");

    seedBuiltinDelegationTeams();
    const team = getDelegationTeam("team-delegation-impl-review");
    assert.ok(team, "builtin delegation team missing after seed");
    assert.equal(team?.source, "builtin");
    assert.ok(team?.roster.length >= 2);
    assert.ok(listDelegationTeams().some((x) => x.id === "team-delegation-impl-review"));

    // user customization preserved across re-seed
    const customized = team?.roster.map((r) =>
      r.id === "r-impl"
        ? {
            ...r,
            agentId: "cli-claude-agent-acp",
            instructions: "始终先实现再验证",
            skillIds: ["skill-debug"]
          }
        : r
    );
    updateDelegationTeam("team-delegation-impl-review", { roster: customized });

    seedBuiltinDelegationTeams();
    const reseated = getDelegationTeam("team-delegation-impl-review");
    const impl = reseated?.roster.find((r) => r.id === "r-impl");
    assert.equal(impl?.agentId, "cli-claude-agent-acp", "user agent binding not preserved on re-seed");
    assert.deepEqual(impl?.skillIds, ["skill-debug"], "user skillIds not preserved on re-seed");
    assert.equal(impl?.instructions, "始终先实现再验证", "role instructions not preserved on re-seed");
  });
});

test("createDelegationRun inserts a kind=delegation run row", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { createDelegationRun, getDelegationRun } =
      await import("../dist-electron/cli/delegationRuns.js");
    const id = createDelegationRun({
      goal: "实现登录页",
      cwd: "/repo",
      teamId: "team-del-1",
      teamSnapshotJson: JSON.stringify({ id: "team-del-1" })
    });
    const run = getDelegationRun(id);
    assert.ok(run);
    assert.equal(run.kind, "delegation");
    assert.equal(run.goal, "实现登录页");
    assert.equal(run.status, "running");
    assert.equal(run.teamId, "team-del-1");
  });
});

test("delegation run and event reads are scoped to the conversation owner", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
    const { createConversation } = await import("../dist-electron/cli/conversations.js");
    const {
      callerCanAccessDelegationRun,
      createDelegationRun,
      getDelegationRun,
      insertDelegationEvent,
      listDelegationEvents
    } = await import("../dist-electron/cli/delegationRuns.js");
    const conversationId = "conv-owned-delegation";
    runAsCaller("alice", () => {
      createConversation({
        id: conversationId,
        title: "owned",
        agentId: "a",
        agentName: "A",
        adapter: "codex-acp"
      });
    });
    const runId = createDelegationRun({
      goal: "g",
      teamId: "t",
      teamSnapshotJson: "{}",
      conversationId
    });
    insertDelegationEvent({
      runId,
      parentEventId: null,
      agentId: "a",
      agentName: "A",
      roleLabel: "entry",
      taskText: "g",
      depth: 0,
      canWrite: true,
      status: "running"
    });

    runAsCaller("bob", () => {
      assert.equal(callerCanAccessDelegationRun(runId), false);
      assert.equal(getDelegationRun(runId), undefined);
      assert.deepEqual(listDelegationEvents(runId), []);
    });
    runAsCaller("alice", () => {
      assert.equal(callerCanAccessDelegationRun(runId), true);
      assert.equal(getDelegationRun(runId)?.id, runId);
      assert.equal(listDelegationEvents(runId).length, 1);
    });
    runAsCaller("admin", () => {
      assert.equal(getDelegationRun(runId)?.id, runId);
    }, true);
  });
});

test("read-only delegation roles are enforced by workspace policy, not OS sandbox", () => {
  const runtime = fs.readFileSync(
    new URL("../electron/cli/runtime.ts", import.meta.url),
    "utf8"
  );
  const sandbox = fs.readFileSync(
    new URL("../electron/cli/sandboxRuntime.ts", import.meta.url),
    "utf8"
  );
  const acpRuntime = fs.readFileSync(
    new URL("../electron/cli/acpRuntime.ts", import.meta.url),
    "utf8"
  );
  assert.match(runtime, /const processSandboxed = shouldSandboxCurrentCaller\(\);/);
  assert.doesNotMatch(runtime, /shouldSandboxCurrentCaller\(\)\s*\|\|\s*readOnlyWorkspace/);
  assert.match(runtime, /!readOnlyWorkspace[\s\S]*reconcileNativeSkillLinks/);
  assert.match(sandbox, /readOnlyWorkspace \? \[workspaceRoot\] : \[\]/);
  assert.match(sandbox, /denyWrite/);
  assert.match(acpRuntime, /const processSandboxed = shouldSandboxCurrentCaller\(\);/);
  assert.doesNotMatch(
    acpRuntime,
    /shouldSandboxCurrentCaller\(\)\s*\|\|\s*readOnlyWorkspace/
  );
  assert.match(acpRuntime, /readOnlyWorkspace/);
});

test("App wires delegation onRunFinished like workflow completion notifications", () => {
  const src = fs.readFileSync(
    new URL("../src/App.tsx", import.meta.url),
    "utf8"
  );
  assert.match(src, /delegation\?\.onRunFinished/);
  assert.match(src, /handleTeamRunFinished/);
  assert.match(src, /source: "workflow" \| "delegation"/);
  assert.match(src, /eventId: `\$\{source\}:\$\{event\.runId\}`/);
});

test("preload exposes delegation.onRunFinished bridge", () => {
  const src = fs.readFileSync(
    new URL("../electron/preload.ts", import.meta.url),
    "utf8"
  );
  assert.match(src, /delegation:\/\/finished/);
  assert.match(src, /onRunFinished/);
});

test("setDelegationRunStatus notifies finished handler on terminal transition", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const {
      createDelegationRun,
      setDelegationRunStatus,
      bindDelegationRunFinishedNotifier
    } = await import("../dist-electron/cli/delegationRuns.js");

    const events = [];
    bindDelegationRunFinishedNotifier((event) => {
      events.push(event);
    });

    const id = createDelegationRun({
      goal: "ship feature X",
      teamId: "t",
      teamSnapshotJson: "{}",
      conversationId: "conv-1"
    });

    setDelegationRunStatus(id, "running");
    setDelegationRunStatus(id, "blocked");
    assert.equal(events.length, 0, "non-terminal must not notify");

    setDelegationRunStatus(id, "completed");
    assert.equal(events.length, 1);
    assert.equal(events[0].runId, id);
    assert.equal(events[0].conversationId, "conv-1");
    assert.equal(events[0].status, "completed");
    assert.match(events[0].name, /ship feature/);

    setDelegationRunStatus(id, "completed");
    assert.equal(events.length, 1, "repeat terminal must not re-notify");

    const id2 = createDelegationRun({
      goal: "fail me",
      teamId: "t",
      teamSnapshotJson: "{}",
      conversationId: "conv-2"
    });
    setDelegationRunStatus(id2, "failed");
    assert.equal(events.length, 2);
    assert.equal(events[1].status, "failed");

    const id3 = createDelegationRun({
      goal: "kill me",
      teamId: "t",
      teamSnapshotJson: "{}",
      conversationId: "conv-3"
    });
    setDelegationRunStatus(id3, "killed");
    assert.equal(events.length, 2, "killed must not notify (user stop)");

    bindDelegationRunFinishedNotifier(null);
  });
});

test("setDelegationRunStatus sets ended_at on terminal statuses", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { createDelegationRun, setDelegationRunStatus, getDelegationRun } =
      await import("../dist-electron/cli/delegationRuns.js");
    const id = createDelegationRun({ goal: "g", teamId: "t", teamSnapshotJson: "{}" });

    setDelegationRunStatus(id, "blocked");
    assert.equal(getDelegationRun(id)?.endedAt, null, "non-terminal status must not set ended_at");

    setDelegationRunStatus(id, "partial");
    assert.ok(getDelegationRun(id)?.endedAt, "terminal 'partial' must set ended_at");
    assert.equal(getDelegationRun(id)?.status, "partial");
  });
});

test("getDelegationRun returns undefined for unknown id and for non-delegation rows", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");
    const { getDb } = await import("../dist-electron/cli/db.js");

    assert.equal(getDelegationRun("does-not-exist"), undefined);

    // insert a plain workflow-kind run and ensure it is NOT returned by the delegation getter
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO workflow_runs (id, conversation_id, name, goal, status, template, loop_index, max_loops, plan_json, kind, created_at, updated_at)
       VALUES (?, NULL, 'wf', 'g', 'completed', 'review-loop', 0, 1, '{}', 'workflow', ?, ?)`
    ).run("wf-run-1", now, now);
    assert.equal(getDelegationRun("wf-run-1"), undefined, "workflow-kind run leaked into delegation getter");
  });
});

test("delegation events CRUD builds a parent-linked tree", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { createDelegationRun, insertDelegationEvent, updateDelegationEvent, listDelegationEvents } =
      await import("../dist-electron/cli/delegationRuns.js");
    const runId = createDelegationRun({
      goal: "g", teamId: "t", teamSnapshotJson: "{}"
    });

    const root = insertDelegationEvent({
      runId, parentEventId: null, agentId: "cli-codex-acp", agentName: "Codex",
      roleLabel: "实现", taskText: "根任务", depth: 0, canWrite: true, status: "running"
    });
    const child = insertDelegationEvent({
      runId, parentEventId: root, agentId: "cli-claude-agent-acp", agentName: "Claude",
      roleLabel: "评审", taskText: "审 auth", depth: 1, canWrite: false, status: "running"
    });

    updateDelegationEvent(child, { status: "done", resultSummary: "LGTM" });

    const events = listDelegationEvents(runId);
    assert.equal(events.length, 2);
    const childEvent = events.find((e) => e.id === child);
    assert.equal(childEvent?.status, "done");
    assert.equal(childEvent?.resultSummary, "LGTM");
    assert.equal(childEvent?.parentEventId, root);
    const rootEvent = events.find((e) => e.id === root);
    assert.equal(rootEvent?.depth, 0);
  });
});

test("delegation events cascade-delete with their run", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { createDelegationRun, insertDelegationEvent, listDelegationEvents } =
      await import("../dist-electron/cli/delegationRuns.js");
    const { getDb } = await import("../dist-electron/cli/db.js");
    const runId = createDelegationRun({ goal: "g", teamId: "t", teamSnapshotJson: "{}" });
    insertDelegationEvent({
      runId, parentEventId: null, agentId: "a", agentName: "A",
      roleLabel: "x", taskText: "t", depth: 0, canWrite: false, status: "running"
    });
    getDb().prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
    assert.equal(listDelegationEvents(runId).length, 0);
  });
});

test("insertDelegationEvent rethrows foreign key failures and is idempotent on primary key", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  await withDb(async () => {
    const { createDelegationRun, insertDelegationEvent, getDelegationEvent } =
      await import("../dist-electron/cli/delegationRuns.js");
    const missingId = "missing-fk-event";
    assert.throws(
      () =>
        insertDelegationEvent({
          id: missingId,
          runId: "no-such-run",
          parentEventId: null,
          agentId: "a",
          agentName: "A",
          roleLabel: "x",
          taskText: "t",
          depth: 0,
          canWrite: false,
          status: "pending"
        }),
      (error) => {
        const code = error?.code ?? "";
        return String(code).startsWith("SQLITE_CONSTRAINT") || /constraint/i.test(String(error));
      }
    );
    assert.equal(getDelegationEvent(missingId), undefined);

    const runId = createDelegationRun({ goal: "g", teamId: "t", teamSnapshotJson: "{}" });
    const event = {
      id: "dup-event",
      runId,
      parentEventId: null,
      agentId: "a",
      agentName: "A",
      roleLabel: "x",
      taskText: "t",
      depth: 0,
      canWrite: false,
      status: "pending"
    };
    const first = insertDelegationEvent(event);
    const second = insertDelegationEvent(event);
    assert.equal(first, "dup-event");
    assert.equal(second, "dup-event");
    assert.equal(getDelegationEvent("dup-event")?.runId, runId);
  });
});

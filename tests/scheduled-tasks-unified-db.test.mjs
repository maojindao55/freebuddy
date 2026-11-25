import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let Database;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = undefined;
}

async function setup(t) {
  if (!Database) {
    t.skip("Run with scripts/run-electron-node-test.mjs for the native SQLite binding");
    return null;
  }
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const database = await import("../dist-electron/cli/db.js");
  database.migrate(db);
  database.setDbForTest(db);
  const conversations = await import("../dist-electron/cli/conversations.js");
  const scheduled = await import("../dist-electron/cli/scheduledTasks.js");
  const attachments = await import("../dist-electron/cli/attachments.js");
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");

  scheduled.resetScheduledTaskDispatchClaimsForTest();
  const createdManagedFiles = [];

  const createManagedFile = (name) => {
    const dir = attachments.getManagedAttachmentsDir();
    const filePath = path.join(dir, `test-sched-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
    fs.writeFileSync(filePath, "fake-image-bytes");
    createdManagedFiles.push(filePath);
    return {
      id: `att-${name}`,
      kind: "image",
      name,
      path: filePath,
      managed: true
    };
  };

  t.after(() => {
    scheduled.resetScheduledTaskDispatchClaimsForTest();
    database.setDbForTest(null);
    db.close();
    for (const filePath of createdManagedFiles) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore cleanup error
      }
    }
  });

  const as = (user, fn) => runAsCaller(user, fn);
  const createConv = (id = "conv-1", user = "alice") =>
    as(user, () =>
      conversations.createConversation({
        id,
        title: `Chat ${id}`,
        agentId: "cli-codex-acp",
        agentName: "Codex",
        adapter: "codex-acp"
      })
    );

  return { db, database, conversations, scheduled, attachments, as, createConv, createManagedFile };
}

test("conversation_message scheduled sends persist rich context and replace previous ephemeral send per conversation", async (t) => {
  const c = await setup(t);
  if (!c) return;

  c.createConv("conv-1", "alice");
  const att1 = c.createManagedFile("first.png");
  const att2 = c.createManagedFile("second.png");
  const future1 = Date.now() + 60 * 60_000;
  const future2 = Date.now() + 2 * 60 * 60_000;

  const skills = [
    {
      id: "skill-tdd",
      name: "TDD",
      description: "Write tests first",
      version: "1.0.0",
      source: "builtin",
      rootPath: "/skills/tdd",
      contentHash: "abc123"
    }
  ];
  const refs = [{ id: "conv-0", title: "Previous chat", agentName: "Codex" }];

  const first = c.as("alice", () =>
    c.scheduled.createScheduledTask({
      title: "Continue auth fix",
      prompt: "",
      agentId: "cli-codex-acp",
      scheduleType: "once",
      timeLocal: "09:00",
      executionMode: "continuous",
      targetKind: "conversation_message",
      targetConversationId: "conv-1",
      triggerKind: "quota_reset",
      fireAtMs: future1,
      cleanupAfterRun: true,
      attachments: [att1],
      payload: {
        messageSkills: skills,
        conversationReferences: refs,
        approvalMode: "auto"
      },
      enabled: true
    })
  );

  assert.equal(first.ok, true);
  assert.equal(first.task.targetKind, "conversation_message");
  assert.equal(first.task.targetConversationId, "conv-1");
  assert.equal(first.task.triggerKind, "quota_reset");
  assert.equal(first.task.fireAtMs, future1);
  assert.equal(first.task.cleanupAfterRun, true);
  assert.equal(first.task.attachments?.length, 1);
  assert.deepEqual(first.task.payload?.messageSkills, skills);
  assert.deepEqual(first.task.payload?.conversationReferences, refs);
  assert.equal(c.attachments.countManagedAttachmentReferences(att1.path), 1);
  assert.equal(fs.existsSync(att1.path), true);

  // Scheduling a second one-time message on the same conversation replaces the first and frees att1.
  const second = c.as("alice", () =>
    c.scheduled.createScheduledTask({
      title: "Second prompt",
      prompt: "Run tests after quota resets",
      agentId: "cli-codex-acp",
      scheduleType: "once",
      timeLocal: "10:00",
      executionMode: "continuous",
      targetKind: "conversation_message",
      targetConversationId: "conv-1",
      triggerKind: "delay",
      fireAtMs: future2,
      cleanupAfterRun: true,
      attachments: [att2],
      enabled: true
    })
  );

  assert.equal(second.ok, true);
  const all = c.as("alice", () => c.scheduled.listScheduledTasks());
  assert.equal(all.length, 1);
  assert.equal(all[0].id, second.task.id);
  assert.equal(c.attachments.countManagedAttachmentReferences(att1.path), 0);
  assert.equal(fs.existsSync(att1.path), false, "replaced unreferenced managed attachment is cleaned up");
  assert.equal(c.attachments.countManagedAttachmentReferences(att2.path), 1);
  assert.equal(fs.existsSync(att2.path), true);
});

test("delete with preserveAttachments keeps managed file for back-to-draft; normal delete and conversation deletion clean up", async (t) => {
  const c = await setup(t);
  if (!c) return;

  c.createConv("conv-draft", "alice");
  const attDraft = c.createManagedFile("draft.png");
  const createdDraft = c.as("alice", () =>
    c.scheduled.createScheduledTask({
      title: "Draft send",
      prompt: "Check screenshot",
      agentId: "cli-codex-acp",
      scheduleType: "once",
      timeLocal: "09:00",
      executionMode: "continuous",
      targetKind: "conversation_message",
      targetConversationId: "conv-draft",
      fireAtMs: Date.now() + 30 * 60_000,
      attachments: [attDraft],
      enabled: true
    })
  );
  assert.equal(createdDraft.ok, true);

  // Back to draft: remove scheduled task row while preserving the attachment on disk.
  const deletedForDraft = c.as("alice", () =>
    c.scheduled.deleteScheduledTask(createdDraft.task.id, { preserveAttachments: true })
  );
  assert.equal(deletedForDraft, true);
  assert.equal(fs.existsSync(attDraft.path), true, "preserveAttachments keeps managed file on disk");

  // Re-schedule, then delete conversation: task row and unreferenced attachment are cleaned up.
  const attDel = c.createManagedFile("conv-del.png");
  const createdDel = c.as("alice", () =>
    c.scheduled.createScheduledTask({
      title: "Conv delete test",
      prompt: "Hello",
      agentId: "cli-codex-acp",
      scheduleType: "once",
      timeLocal: "09:00",
      executionMode: "continuous",
      targetKind: "conversation_message",
      targetConversationId: "conv-draft",
      fireAtMs: Date.now() + 30 * 60_000,
      attachments: [attDel],
      enabled: true
    })
  );
  assert.equal(createdDel.ok, true);
  assert.equal(c.attachments.countManagedAttachmentReferences(attDel.path), 1);

  c.as("alice", () => c.conversations.deleteConversation("conv-draft"));
  assert.equal(c.as("alice", () => c.scheduled.listScheduledTasks().length), 0);
  assert.equal(fs.existsSync(attDel.path), false, "deleting conversation removes scheduled task managed attachments");
});

test("atomic dispatch claims prevent duplicate sends, enforce ownership, and clean up ephemeral tasks on sent", async (t) => {
  const c = await setup(t);
  if (!c) return;

  c.createConv("conv-claim", "alice");
  const att = c.createManagedFile("claim.png");
  const future = Date.now() + 60_000;

  const created = c.as("alice", () =>
    c.scheduled.createScheduledTask({
      title: "Claim test",
      prompt: "Send when due",
      agentId: "cli-codex-acp",
      scheduleType: "once",
      timeLocal: "09:00",
      executionMode: "continuous",
      targetKind: "conversation_message",
      targetConversationId: "conv-claim",
      fireAtMs: future,
      cleanupAfterRun: true,
      attachments: [att],
      enabled: true
    })
  );
  assert.equal(created.ok, true);

  // Not due yet -> rejected.
  assert.deepEqual(
    c.as("alice", () => c.scheduled.claimScheduledTaskDispatch(created.task.id)),
    { ok: false, reason: "not_due" }
  );

  // Trigger now via runScheduledTask (same path as Send Now button).
  const triggered = await c.as("alice", () =>
    c.scheduled.runScheduledTask(created.task.id, undefined)
  );
  assert.equal(triggered, true);

  // Bob cannot claim Alice's scheduled message.
  assert.deepEqual(
    c.as("bob", () => c.scheduled.claimScheduledTaskDispatch(created.task.id)),
    { ok: false, reason: "not_found" }
  );

  // First window wins the claim; second window gets busy.
  const firstClaim = c.as("alice", () =>
    c.scheduled.claimScheduledTaskDispatch(created.task.id)
  );
  assert.equal(firstClaim.ok, true);
  assert.equal(firstClaim.task.lastStatus, "running");

  // Active dispatch lease blocks deletion so managed attachments cannot be dropped mid-send.
  assert.equal(
    c.as("alice", () => c.scheduled.deleteScheduledTask(created.task.id)),
    false
  );
  assert.ok(c.scheduled.getScheduledTask(created.task.id));
  assert.equal(fs.existsSync(att.path), true);

  const secondClaim = c.as("alice", () =>
    c.scheduled.claimScheduledTaskDispatch(created.task.id)
  );
  assert.deepEqual(secondClaim, { ok: false, reason: "busy" });

  // Wrong token cannot complete.
  assert.equal(
    c.as("alice", () =>
      c.scheduled.completeScheduledTaskDispatch({
        id: created.task.id,
        claimToken: "wrong-token",
        outcome: "sent"
      })
    ),
    false
  );

  // Transition to waiting releases claim cleanly so a subsequent tick can claim again.
  assert.equal(
    c.as("alice", () =>
      c.scheduled.completeScheduledTaskDispatch({
        id: created.task.id,
        claimToken: firstClaim.claimToken,
        outcome: "waiting"
      })
    ),
    true
  );
  assert.equal(c.scheduled.getScheduledTask(created.task.id)?.lastStatus, "waiting");

  // Re-claim and complete as sent after message is persisted with the attachment.
  const retryClaim = c.as("alice", () =>
    c.scheduled.claimScheduledTaskDispatch(created.task.id)
  );
  assert.equal(retryClaim.ok, true);
  c.as("alice", () =>
    c.conversations.appendMessage({
      id: "msg-1",
      conversationId: "conv-claim",
      role: "user",
      status: "sent",
      content: "Send when due",
      attachments: [att]
    })
  );
  assert.equal(
    c.as("alice", () =>
      c.scheduled.completeScheduledTaskDispatch({
        id: created.task.id,
        claimToken: retryClaim.claimToken,
        outcome: "sent"
      })
    ),
    true
  );
  assert.equal(c.scheduled.getScheduledTask(created.task.id), undefined, "ephemeral once task deleted after send");
  assert.equal(fs.existsSync(att.path), true, "attachment referenced by conversation_messages stays on disk");
});

test("startup recovery marks overdue one-time conversation messages missed, keeps future ones, and drops orphans", async (t) => {
  const c = await setup(t);
  if (!c) return;

  c.createConv("conv-future", "alice");
  c.createConv("conv-overdue", "alice");
  const now = Date.now();

  const futureTask = c.as("alice", () =>
    c.scheduled.createScheduledTask({
      title: "Future send",
      prompt: "Still ahead",
      agentId: "cli-codex-acp",
      scheduleType: "once",
      timeLocal: "12:00",
      executionMode: "continuous",
      targetKind: "conversation_message",
      targetConversationId: "conv-future",
      fireAtMs: now + 3 * 60 * 60_000,
      enabled: true
    })
  );
  const overdueTask = c.as("alice", () =>
    c.scheduled.createScheduledTask({
      title: "Overdue send",
      prompt: "Missed while closed",
      agentId: "cli-codex-acp",
      scheduleType: "once",
      timeLocal: "08:00",
      executionMode: "continuous",
      targetKind: "conversation_message",
      targetConversationId: "conv-overdue",
      fireAtMs: now + 60_000,
      enabled: true
    })
  );
  assert.equal(futureTask.ok, true);
  assert.equal(overdueTask.ok, true);

  // Simulate an orphan row referencing a deleted conversation.
  c.db
    .prepare(
      `INSERT INTO scheduled_tasks
         (id, title, prompt, agent_id, time_local, schedule_type, execution_mode,
          target_kind, target_conversation_id, fire_at_ms, enabled, next_run_at,
          last_status, owner_id, created_at, updated_at)
       VALUES ('orphan-1', 'Orphan', 'p', 'cli-codex-acp', '09:00', 'once', 'continuous',
               'conversation_message', 'deleted-conv', ?, 1, ?, 'idle', 'alice', ?, ?)`
    )
    .run(now + 60_000, new Date(now + 60_000).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());

  // Simulate reopening FreeBuddy 2 hours later.
  c.scheduled.recoverScheduledTasksOnStartup(now + 2 * 60 * 60_000);

  const recoveredFuture = c.scheduled.getScheduledTask(futureTask.task.id);
  const recoveredOverdue = c.scheduled.getScheduledTask(overdueTask.task.id);
  assert.equal(recoveredFuture?.enabled, true);
  assert.equal(recoveredFuture?.lastStatus, "idle");
  assert.equal(recoveredFuture?.fireAtMs, now + 3 * 60 * 60_000);

  assert.equal(recoveredOverdue?.enabled, false);
  assert.equal(recoveredOverdue?.lastStatus, "missed");

  assert.equal(c.scheduled.getScheduledTask("orphan-1"), undefined, "orphan conversation_message removed on startup");

  // Archiving a conversation pauses its active scheduled message.
  c.as("alice", () => c.conversations.archiveConversation("conv-future", true));
  const archivedTask = c.scheduled.getScheduledTask(futureTask.task.id);
  assert.equal(archivedTask?.enabled, false);
  assert.equal(archivedTask?.lastStatus, "missed");
});

test("migrate upgrades legacy scheduled_tasks table before creating idx_scheduled_tasks_target_conv", async (t) => {
  if (!Database) {
    t.skip("Run with scripts/run-electron-node-test.mjs for the native SQLite binding");
    return;
  }
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  t.after(() => db.close());

  db.exec(`
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      time_local TEXT NOT NULL,
      schedule_type TEXT NOT NULL DEFAULT 'daily',
      schedule_date TEXT,
      weekdays TEXT,
      month_day INTEGER,
      cwd TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'new_conversation',
      config_option_overrides TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      last_conversation_id TEXT,
      last_workflow_run_id TEXT,
      owner_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO scheduled_tasks
      (id, title, prompt, agent_id, time_local, created_at, updated_at)
    VALUES
      ('legacy-1', 'Daily sync', 'Check status', 'cli-codex-acp', '09:00', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);

  const database = await import("../dist-electron/cli/db.js");
  assert.doesNotThrow(() => database.migrate(db));

  const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all().map((c) => c.name);
  assert.ok(cols.includes("target_conversation_id"));
  assert.ok(cols.includes("target_kind"));

  const indexes = db.prepare("PRAGMA index_list(scheduled_tasks)").all().map((idx) => idx.name);
  assert.ok(indexes.includes("idx_scheduled_tasks_target_conv"));

  const row = db.prepare("SELECT id, target_kind, trigger_kind FROM scheduled_tasks WHERE id = 'legacy-1'").get();
  assert.deepEqual(row, {
    id: "legacy-1",
    target_kind: "new_conversation",
    trigger_kind: "schedule"
  });
});

test("runScheduledTask rejects archived target conversations and keeps them missed", async (t) => {
  const c = await setup(t);
  if (!c) return;

  c.createConv("conv-arch", "alice");
  const created = c.as("alice", () =>
    c.scheduled.createScheduledTask({
      title: "Archived target",
      prompt: "Should not run",
      agentId: "cli-codex-acp",
      scheduleType: "once",
      timeLocal: "09:00",
      executionMode: "continuous",
      targetKind: "conversation_message",
      targetConversationId: "conv-arch",
      fireAtMs: Date.now() + 30 * 60_000,
      enabled: true
    })
  );
  assert.equal(created.ok, true);

  c.as("alice", () => c.conversations.archiveConversation("conv-arch", true));
  const paused = c.scheduled.getScheduledTask(created.task.id);
  assert.equal(paused?.enabled, false);
  assert.equal(paused?.lastStatus, "missed");

  const accepted = await c.as("alice", () =>
    c.scheduled.runScheduledTask(created.task.id, undefined)
  );
  assert.equal(accepted, false);

  const after = c.scheduled.getScheduledTask(created.task.id);
  assert.equal(after?.enabled, false);
  assert.equal(after?.lastStatus, "missed");
  assert.equal(after?.lastError, "scheduledTasks.errors.conversationUnavailable");
});

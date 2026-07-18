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

test("usage sessions backfill, reject ambiguous ownership and aggregate by agent/model", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  const db = new Database(":memory:");
  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  const {
    backfillAgentUsageSessions,
    getAgentUsageSummary,
    setUsageScanState,
    setUsageDbForTest,
    storeTokscaleUsagePeriodReport,
    storeTokscaleUsageReport
  } = await import("../dist-electron/cli/usageStore.js");
  setUsageDbForTest(db);

  const insertTask = db.prepare(
    `INSERT INTO cli_tasks
       (id, agent_id, agent_name, adapter, status, prompt, tool_session_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'done', 'test', ?, ?, ?)`
  );
  const codexUuid = "019f1048-c7e7-78d3-8ec6-a9e6b5c48ac4";
  insertTask.run("t1", "agent-a", "Agent A", "codex-acp", codexUuid, "1", "1");
  insertTask.run("t2", "agent-a", "Agent A", "opencode-acp", "ses_open", "2", "2");
  insertTask.run("t3", "cursor", "Cursor", "cursor-agent-acp", "cursor-session", "3", "3");
  assert.equal(backfillAgentUsageSessions(), 2);

  const first = storeTokscaleUsageReport(
    {
      entries: [
        {
          client: "codex",
          sessionId: `rollout-date-${codexUuid}`,
          sessionKey: codexUuid,
          modelId: "gpt-5.5",
          providerId: "openai",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 20,
          cacheWriteTokens: 0,
          reasoningTokens: 1,
          messageCount: 1,
          estimatedCostUsd: 0.1
        },
        {
          client: "opencode",
          sessionId: "ses_open",
          sessionKey: "ses_open",
          modelId: "claude-sonnet-4",
          providerId: "anthropic",
          inputTokens: 30,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 4,
          reasoningTokens: 0,
          messageCount: 2,
          estimatedCostUsd: 0.2
        },
        {
          client: "codex",
          sessionId: "unrelated",
          sessionKey: "unrelated",
          modelId: "gpt-5.5",
          providerId: "openai",
          inputTokens: 999,
          outputTokens: 999,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          messageCount: 1,
          estimatedCostUsd: 99
        }
      ]
    },
    "scan-1"
  );
  assert.deepEqual(first, {
    reportEntries: 3,
    attributedEntries: 2,
    attributedSessions: 2
  });

  let summary = getAgentUsageSummary();
  assert.equal(summary.linkedSessionCount, 2);
  assert.equal(summary.attributedSessionCount, 2);
  assert.deepEqual(summary.coverageGaps, [
    {
      adapter: "cursor-agent-acp",
      sessionCount: 1,
      reason: "session_attribution_unavailable"
    }
  ]);
  assert.deepEqual(
    summary.byAgentModel.map((row) => [row.modelId, row.inputTokens]),
    [
      ["claude-sonnet-4", 30],
      ["gpt-5.5", 10]
    ]
  );

  const todayReport = {
    entries: [
      {
        client: "codex",
        sessionId: codexUuid,
        sessionKey: codexUuid,
        modelId: "gpt-5.5",
        providerId: "openai",
        inputTokens: 7,
        outputTokens: 1,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
        messageCount: 1,
        estimatedCostUsd: 0.01
      }
    ]
  };
  storeTokscaleUsagePeriodReport("today", todayReport, "today-scan");
  setUsageScanState("today", "ok", {
    startedAt: "today-start",
    completedAt: "today-end"
  });
  const today = getAgentUsageSummary("today");
  assert.equal(today.period, "today");
  assert.equal(today.usageSessionCount, 1);
  assert.equal(today.attributedSessionCount, 2);
  assert.equal(today.byAgentModel.length, 1);
  assert.equal(today.byAgentModel[0].inputTokens, 7);
  assert.equal(today.scan?.completedAt, "today-end");
  const week = getAgentUsageSummary("week");
  assert.equal(week.usageSessionCount, 0);
  assert.deepEqual(week.byAgentModel, []);

  // Reusing a native session under another agent makes ownership unsafe. The
  // existing usage is retained but excluded from attributed aggregates.
  insertTask.run("t4", "agent-b", "Agent B", "codex-acp", codexUuid, "4", "4");
  backfillAgentUsageSessions();
  summary = getAgentUsageSummary();
  assert.equal(summary.ambiguousSessionCount, 1);
  assert.equal(summary.attributedSessionCount, 1);
  assert.deepEqual(summary.byAgentModel.map((row) => row.modelId), ["claude-sonnet-4"]);

  setUsageDbForTest(null);
  db.close();
});

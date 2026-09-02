import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

let Database, bindingAvailable = true;
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
  const { seedBuiltinSkills } = await import("../dist-electron/cli/skills.js");
  seedBuiltinSkills();
  try {
    await fn();
  } finally {
    setDbForTest(null);
    db.close();
  }
}

const roster = [
  { id: "r-impl", label: "实现", agentId: "cli-codex-acp", capability: "写", canWrite: true },
  { id: "r-rev", label: "评审", agentId: "cli-claude-agent-acp", capability: "审", canWrite: false }
];
const policy = {
  allowWrites: true,
  requireApprovalBeforeDelegateWrite: false,
  maxDepth: 3,
  delegateTimeoutMs: 600000,
  maxConcurrentDelegates: 1,
  stopOnDelegateFailure: false
};
const snap = { roster, policy, entryRoleId: "r-impl" };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("followUp after completed run parks on delegate and wakes with result", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { dispatchDelegateAction } = await import("../dist-electron/cli/delegationDispatch.js");
    const { getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");

    const entryPrompts = [];
    const sessionIds = [];
    let phase = "initial";
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({
        adapter: id.includes("claude") ? "claude-agent-acp" : "codex-acp",
        agentName: id,
        skillIds: []
      }),
      runAgent: async (args) => {
        sessionIds.push(args.sessionId);
        if (args.delegation.depth === 0) {
          entryPrompts.push(args.prompt);
          if (phase === "followUp" && entryPrompts.filter((p) => p.includes("委派评审")).length >= 1) {
            // Only delegate once on the follow-up task turn (not on wake).
            if (!args.prompt.includes("委派结果返回")) {
              await dispatchDelegateAction(
                {
                  token: "t",
                  taskSessionId: "s",
                  runId: args.delegation.runId,
                  parentEventId: args.delegation.parentEventId,
                  depth: 0,
                  selfAgentId: "r-impl",
                  selfLabel: "实现"
                },
                "delegate",
                { teammate_id: "r-rev", task: "审查锤子升级改动并给风险列表" }
              );
            }
          }
          return { summary: `entry ${entryPrompts.length}`, exitCode: 0, error: null };
        }
        return { summary: "REVIEW: hammer costs schema drift", exitCode: 0, error: null };
      }
    });

    const runId = await rt.start({
      goal: "开发一个功能",
      teamId: "t",
      teamSnapshot: snap,
      cwd: "/r"
    });
    await tick(30);
    assert.equal(getDelegationRun(runId).status, "completed");
    const afterStart = entryPrompts.length;

    phase = "followUp";
    await rt.followUp(runId, "委派评审");
    await tick(80);

    assert.ok(entryPrompts.length > afterStart + 1, "follow-up must park then wake");
    const wake = entryPrompts.find((p) => p.includes("委派结果返回"));
    assert.ok(wake, "wake prompt required after follow-up delegate settles");
    assert.ok(wake.includes("hammer costs"), "wake must carry review result");
    assert.equal(getDelegationRun(runId).status, "completed");
    // cli_tasks.id === sessionId; reusing across follow-up/wake marks the run failed
    // (UNIQUE constraint) — regression for delrun_mspc69xn_93qqdw.
    assert.equal(
      new Set(sessionIds).size,
      sessionIds.length,
      `each agent turn needs a unique sessionId, got ${JSON.stringify(sessionIds)}`
    );
    assert.ok(
      sessionIds.every((id) => id.startsWith(`del-${runId}-`)),
      "sessionIds should stay under the run prefix"
    );
  });
});

test("followUp wake prompt carries submit_verdict needs_changes and re-delegate guidance", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { dispatchDelegateAction } = await import("../dist-electron/cli/delegationDispatch.js");
    const { getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");

    const entryPrompts = [];
    const verdictSummary = "hammer toast must use design tokens";
    let phase = "initial";
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({
        adapter: id.includes("claude") ? "claude-agent-acp" : "codex-acp",
        agentName: id,
        skillIds: []
      }),
      runAgent: async (args) => {
        if (args.delegation.depth === 0) {
          entryPrompts.push(args.prompt);
          if (phase === "followUp" && !args.prompt.includes("委派结果返回")) {
            await dispatchDelegateAction(
              {
                token: "t",
                taskSessionId: "s",
                runId: args.delegation.runId,
                parentEventId: args.delegation.parentEventId,
                depth: 0,
                selfAgentId: "r-impl",
                selfLabel: "实现"
              },
              "delegate",
              { teammate_id: "r-rev", task: "审查锤子升级改动并给风险列表" }
            );
          }
          return { summary: `entry ${entryPrompts.length}`, exitCode: 0, error: null };
        }
        await dispatchDelegateAction(
          {
            token: "t",
            taskSessionId: "s",
            runId: args.delegation.runId,
            parentEventId: args.delegation.parentEventId,
            depth: args.delegation.depth,
            selfAgentId: args.delegation.selfAgentId,
            selfLabel: args.delegation.selfLabel
          },
          "submit_verdict",
          { verdict: "needs_changes", summary: verdictSummary }
        );
        return { summary: "REVIEW: hammer costs schema drift", exitCode: 0, error: null };
      }
    });

    const runId = await rt.start({
      goal: "开发一个功能",
      teamId: "t",
      teamSnapshot: snap,
      cwd: "/r"
    });
    await tick(30);
    assert.equal(getDelegationRun(runId).status, "completed");

    phase = "followUp";
    await rt.followUp(runId, "委派评审");
    await tick(80);

    const wake = entryPrompts.find((p) => p.includes("委派结果返回"));
    assert.ok(wake, "wake prompt required after follow-up delegate settles");
    assert.match(wake, /needs_changes|结构化结论/);
    assert.match(wake, /delegate/);
    assert.match(wake, /复审|不要宣布收尾|收尾之前/);
    assert.ok(wake.includes(verdictSummary), "wake must carry submitted verdict summary");
    assert.equal(getDelegationRun(runId).status, "completed");
  });
});

test("followUp after completed entry reopens without reusing entry sessionId", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");

    const sessionIds = [];
    const scopes = [];
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: () => ({
        adapter: "codex-acp",
        agentName: "codex",
        skillIds: []
      }),
      runAgent: async (args) => {
        sessionIds.push(args.sessionId);
        scopes.push(args.toolSessionScope);
        return { summary: "ok", exitCode: 0, error: null };
      }
    });

    const runId = await rt.start({
      goal: "先做完",
      teamId: "t",
      teamSnapshot: snap,
      cwd: "/r"
    });
    assert.equal(getDelegationRun(runId).status, "completed");
    const first = sessionIds[0];
    assert.ok(first);

    await rt.followUp(runId, "委派审核");
    assert.equal(getDelegationRun(runId).status, "completed");
    assert.equal(sessionIds.length, 2);
    assert.notEqual(sessionIds[1], first, "follow-up must mint a new cli task id");
    assert.equal(scopes[0], `delegation:${runId}:entry`);
    assert.equal(scopes[1], scopes[0], "tool session scope stays stable for resume");
  });
});

test("followUp after a failed entry restores the original task for a fresh session", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const prompts = [];
    let turn = 0;
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: () => ({ adapter: "dsh-acp", agentName: "DeepSeek", skillIds: [] }),
      runAgent: async (args) => {
        prompts.push(args.prompt);
        turn += 1;
        return turn === 1
          ? { summary: "", exitCode: 0, error: "Agent returned no output.", hasOutput: false }
          : { summary: "done", exitCode: 0, error: null, hasOutput: true };
      }
    });

    const runId = await rt.start({
      goal: "制作五张短视频封面并完成验收",
      teamId: "t",
      teamSnapshot: snap,
      cwd: "/r"
    });
    await rt.followUp(runId, "继续");

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Original task:\n制作五张短视频封面并完成验收/);
    assert.match(prompts[1], /Latest user instruction:\n继续/);
  });
});

test("followUp during an initial park is queued without prematurely completing the run", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { dispatchDelegateAction } = await import("../dist-electron/cli/delegationDispatch.js");
    const { getDelegationRun, listDelegationEvents } = await import(
      "../dist-electron/cli/delegationRuns.js"
    );

    const entryPrompts = [];
    let releaseChild;
    const childGate = new Promise((resolve) => { releaseChild = resolve; });
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({
        adapter: id.includes("claude") ? "claude-agent-acp" : "codex-acp",
        agentName: id,
        skillIds: []
      }),
      runAgent: async (args) => {
        if (args.delegation.depth === 0) {
          entryPrompts.push(args.prompt);
          if (entryPrompts.length === 1) {
            await dispatchDelegateAction(
              {
                token: "t",
                taskSessionId: "s",
                runId: args.delegation.runId,
                parentEventId: args.delegation.parentEventId,
                depth: 0,
                selfAgentId: "r-impl",
                selfLabel: "实现"
              },
              "delegate",
              { teammate_id: "r-rev", task: "review the initial change" }
            );
          }
          return { summary: "entry", exitCode: 0, error: null };
        }
        await childGate;
        return { summary: "review complete", exitCode: 0, error: null };
      }
    });

    const runId = rt.prepareRun({
      goal: "implement",
      teamId: "t",
      teamSnapshot: snap,
      cwd: "/r"
    });
    const entryDrive = rt.runEntry(runId, "implement");
    await tick(30);

    await rt.followUp(runId, "also verify the release notes");
    assert.equal(entryPrompts.length, 1, "parked follow-up must not re-enter the entry agent");
    assert.equal(getDelegationRun(runId).status, "running");
    assert.equal(
      listDelegationEvents(runId).find((event) => event.depth === 0)?.status,
      "running"
    );

    releaseChild();
    await entryDrive;

    assert.equal(entryPrompts.length, 2);
    assert.match(entryPrompts[1], /review complete/);
    assert.match(entryPrompts[1], /also verify the release notes/);
    assert.equal(getDelegationRun(runId).status, "completed");
  });
});

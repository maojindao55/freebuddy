import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

let Database, bindingAvailable = true;
try { Database = (await import("better-sqlite3")).default; new Database(":memory:").close(); } catch { bindingAvailable = false; }

async function withDb(fn) {
  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db); setDbForTest(db);
  const { seedBuiltinSkills } = await import("../dist-electron/cli/skills.js");
  seedBuiltinSkills();
  try { await fn(); } finally { setDbForTest(null); db.close(); }
}

const roster = [
  { id: "r-impl", label: "实现", agentId: "cli-codex-acp", capability: "写", canWrite: true },
  { id: "r-rev", label: "评审", agentId: "cli-claude-agent-acp", capability: "审", canWrite: false }
];
const policy = { allowWrites: true, requireApprovalBeforeDelegateWrite: true, maxDepth: 3, delegateTimeoutMs: 600000, maxConcurrentDelegates: 1, stopOnDelegateFailure: false };
const snap = { roster, policy, entryRoleId: "r-impl" };

test("context provider returns the run's roster/policy", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime, DELEGATION_SKILL_ID } = await import("../dist-electron/cli/delegationRuntime.js");
    const rt = new DelegationRuntime({ webContents: undefined, resolveAgent: () => undefined, runAgent: async () => ({ summary: "", exitCode: 0, error: null }) });
    const runId = rt.prepareRun({ goal: "g", teamId: "t", teamSnapshot: snap, cwd: "/r" });
    const ctx = rt.getContext(runId);
    assert.deepEqual(ctx.roster, roster);
    assert.equal(ctx.policy.requireApprovalBeforeDelegateWrite, true);
    assert.equal(DELEGATION_SKILL_ID, "delegation");
  });
});

test("write-approval gate blocks until resolved true/false", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");
    const rt = new DelegationRuntime({ webContents: undefined, resolveAgent: () => undefined, runAgent: async () => ({ summary: "", exitCode: 0, error: null }) });
    const runId = rt.prepareRun({ goal: "g", teamId: "t", teamSnapshot: snap, cwd: "/r" });
    const teammate = roster[0];
    const promise = rt.requestWriteApproval(runId, teammate);
    const pending = rt.listPendingApprovals();
    assert.equal(pending.length, 1);
    rt.resolveWriteApproval(pending[0].approvalId, true);
    assert.equal(await promise, true);
    assert.equal(getDelegationRun(runId).status, "running");

    const promise2 = rt.requestWriteApproval(runId, teammate);
    const a2 = rt.listPendingApprovals()[0];
    rt.resolveWriteApproval(a2.approvalId, false);
    assert.equal(await promise2, false);
    assert.equal(getDelegationRun(runId).status, "running", "a denial must unblock the parent run");
  });
});

test("stopRun rejects pending write approvals", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: () => undefined,
      runAgent: async () => ({ summary: "", exitCode: 0, error: null })
    });
    const runId = rt.prepareRun({ goal: "g", teamId: "t", teamSnapshot: snap, cwd: "/r" });
    const approval = rt.requestWriteApproval(runId, roster[0]);
    assert.equal(rt.listPendingApprovals().length, 1);

    rt.stopRun(runId);

    assert.equal(await approval, false);
    assert.equal(rt.listPendingApprovals().length, 0);
    assert.equal(getDelegationRun(runId).status, "killed");
  });
});

test("run start creates run row + root event and spawns entry via runAgent", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { listDelegationEvents } = await import("../dist-electron/cli/delegationRuns.js");
    let spawned;
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({ adapter: "codex-acp", agentName: "Codex", skillIds: [] }),
      runAgent: async (args) => { spawned = args; return { summary: "done", exitCode: 0, error: null }; }
    });
    const runId = await rt.start({ goal: "实现X", teamId: "t", teamSnapshot: snap, cwd: "/r", conversationId: undefined });
    assert.ok(runId);
    assert.equal(spawned.agentId, "cli-codex-acp");
    assert.ok(spawned.prompt.includes("实现X"));
    assert.ok(spawned.skills?.some((s) => s.id === "delegation"));
    assert.equal(spawned.delegation.runId, runId);
    assert.equal(spawned.delegation.depth, 0);
    const root = listDelegationEvents(runId).find((e) => e.depth === 0);
    assert.ok(root);
  });
});

test("entry prompt receives shared instructions and its own role instructions", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    let prompt = "";
    const instructedRoster = roster.map((role) =>
      role.id === "r-impl"
        ? { ...role, instructions: "直接执行任务，不要等待用户再次确认开始。" }
        : role
    );
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: () => ({ adapter: "codex-acp", agentName: "Codex", skillIds: [] }),
      runAgent: async (args) => {
        prompt = args.prompt;
        return { summary: "完成", exitCode: 0, error: null, hasOutput: true, diagnostic: null };
      }
    });
    await rt.start({
      goal: "实现X",
      teamId: "t",
      teamSnapshot: {
        roster: instructedRoster,
        sharedInstructions: "必须交付可验证结果。",
        policy,
        entryRoleId: "r-impl"
      },
      cwd: "/r"
    });
    assert.match(prompt, /必须交付可验证结果/);
    assert.match(prompt, /不要等待用户再次确认开始/);
  });
});

test("an observed empty turn fails instead of completing the delegation run", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { getDelegationRun, listDelegationEvents } = await import(
      "../dist-electron/cli/delegationRuns.js"
    );
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: () => ({ adapter: "codex-acp", agentName: "Codex", skillIds: [] }),
      runAgent: async () => ({
        summary: "(no assistant response or artifact)",
        exitCode: 0,
        error: null,
        hasOutput: false,
        diagnostic: "Agent ended after a failed tool call without a final response or artifact: Skill is not active: hyperframes"
      })
    });
    const runId = await rt.start({ goal: "实现X", teamId: "t", teamSnapshot: snap, cwd: "/r" });
    assert.equal(getDelegationRun(runId)?.status, "failed");
    const root = listDelegationEvents(runId).find((event) => event.depth === 0);
    assert.equal(root?.status, "failed");
    assert.match(root?.resultSummary ?? "", /Skill is not active: hyperframes/);
  });
});

test("an accepted delegation is valid evidence for an otherwise empty turn", async () => {
  const { resolveTurnCompletionError } = await import("@freebuddy/delegation-runtime");
  const emptyTurn = {
    summary: "(no assistant response or artifact)",
    error: null,
    hasOutput: false,
    diagnostic: null
  };
  assert.equal(resolveTurnCompletionError(emptyTurn, true), null);
  assert.match(resolveTurnCompletionError(emptyTurn, false), /without assistant text/i);
});

test("prepareRun returns runId immediately; runEntry spawns the entry agent", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { listDelegationEvents } = await import("../dist-electron/cli/delegationRuns.js");
    let spawned = null;
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({ adapter: "codex-acp", agentName: "Codex", skillIds: [] }),
      runAgent: async (args) => { spawned = args; return { summary: "done", exitCode: 0, error: null }; }
    });
    const runId = rt.prepareRun({ goal: "实现X", teamId: "t", teamSnapshot: snap, cwd: "/r" });
    // prepareRun returned immediately without spawning
    assert.equal(spawned, null);
    await rt.runEntry(runId, "实现X");
    assert.equal(spawned.agentId, "cli-codex-acp");
    assert.equal(spawned.delegation.depth, 0);
    assert.ok(listDelegationEvents(runId).some((e) => e.depth === 0));
  });
});

test("recoverInterruptedDelegationRuns marks running delegation runs as failed", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { recoverInterruptedDelegationRuns } = await import("../dist-electron/cli/delegationRuntime.js");
    const { createDelegationRun, getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");
    const runId = createDelegationRun({ goal: "g", teamId: "t", teamSnapshotJson: "{}" });
    assert.equal(getDelegationRun(runId).status, "running");
    const count = recoverInterruptedDelegationRuns();
    assert.equal(count, 1);
    assert.equal(getDelegationRun(runId).status, "failed");
    // a second call finds nothing left to recover
    assert.equal(recoverInterruptedDelegationRuns(), 0);
  });
});

test("recoverInterruptedDelegationRuns sweeps both running and blocked delegation runs", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime, recoverInterruptedDelegationRuns } = await import("../dist-electron/cli/delegationRuntime.js");
    const { createDelegationRun, setDelegationRunStatus, getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");
    // ensure the global runtime's setDelegateDeps doesn't interfere; recovery is a pure-DB fn
    new DelegationRuntime({ webContents: undefined, resolveAgent: () => undefined, runAgent: async () => ({ summary: "", exitCode: 0, error: null }) });
    const runningId = createDelegationRun({ goal: "g1", teamId: "t", teamSnapshotJson: "{}" });
    const blockedId = createDelegationRun({ goal: "g2", teamId: "t", teamSnapshotJson: "{}" });
    setDelegationRunStatus(blockedId, "blocked");
    const n = recoverInterruptedDelegationRuns();
    assert.ok(n >= 2);
    assert.equal(getDelegationRun(runningId)?.status, "failed");
    assert.equal(getDelegationRun(blockedId)?.status, "failed");
  });
});

test("stopRun kills: a completing runEntry must not overwrite killed status", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");
    let releaseAgent;
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({ adapter: "codex-acp", agentName: "Codex", skillIds: [] }),
      runAgent: () => new Promise((resolve) => { releaseAgent = () => resolve({ summary: "done", exitCode: 0, error: null }); })
    });
    const runId = rt.prepareRun({ goal: "实现X", teamId: "t", teamSnapshot: snap, cwd: "/r" });
    const entryPromise = rt.runEntry(runId, "实现X");
    // runAgent is now pending; stop the run, then let the agent finish successfully.
    rt.stopRun(runId);
    assert.equal(getDelegationRun(runId).status, "killed");
    releaseAgent();
    await entryPromise;
    assert.equal(getDelegationRun(runId).status, "killed");
  });
});

const rosterWithModels = [
  { id: "r-impl", label: "实现", agentId: "cli-codex-acp", capability: "写", canWrite: true, model: "gpt-5.1", modelOptionId: "model" },
  { id: "r-rev", label: "评审", agentId: "cli-claude-agent-acp", capability: "审", canWrite: false, model: "claude-sonnet-4", modelOptionId: "model" }
];
const snapWithModels = { roster: rosterWithModels, policy, entryRoleId: "r-impl" };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("entry agent runAgent receives configOptionOverrides from entry roster model", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    let spawned = null;
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({ adapter: "codex-acp", agentName: "Codex", skillIds: [] }),
      runAgent: async (args) => { spawned = args; return { summary: "done", exitCode: 0, error: null }; }
    });
    const runId = rt.prepareRun({ goal: "实现X", teamId: "t", teamSnapshot: snapWithModels, cwd: "/r" });
    await rt.runEntry(runId, "实现X");
    assert.equal(spawned.agentId, "cli-codex-acp");
    assert.deepEqual(spawned.configOptionOverrides, { model: "gpt-5.1" });
  });
});

test("delegated teammate runAgent receives configOptionOverrides from teammate model", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { dispatchDelegateAction } = await import("../dist-electron/cli/delegationDispatch.js");
    let spawned = null;
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({ adapter: "claude-agent-acp", agentName: "Claude", skillIds: [] }),
      runAgent: async (args) => { spawned = args; return { summary: "LGTM", exitCode: 0, error: null }; }
    });
    const runId = rt.prepareRun({ goal: "实现X", teamId: "t", teamSnapshot: snapWithModels, cwd: "/r" });
    const binding = { token: "t", taskSessionId: "sess-entry", runId, parentEventId: "evt-root", depth: 0, selfAgentId: "r-impl", selfLabel: "实现" };
    const res = await dispatchDelegateAction(binding, "delegate", { teammate_id: "r-rev", task: "审 auth" });
    assert.equal(res.status, "pending");
    await tick(50);
    assert.equal(spawned.agentId, "cli-claude-agent-acp");
    assert.deepEqual(spawned.configOptionOverrides, { model: "claude-sonnet-4" });
    assert.equal(spawned.workspaceAccess, "read-only");
  });
});

test("delegation agent turns restore the run owner context", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { getCallerUserId, isCallerAdmin, runAsCaller } = await import(
      "../dist-electron/cli/callerContext.js"
    );
    const { createUser } = await import("../dist-electron/cli/users.js");
    const { user: owner } = createUser({ username: "buddy" });

    const observed = [];
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: () => ({ adapter: "codex-acp", agentName: "Codex", skillIds: [] }),
      runAgent: async () => {
        observed.push({
          userId: getCallerUserId(),
          isAdmin: isCallerAdmin()
        });
        return { summary: "done", exitCode: 0, error: null };
      }
    });
    const runId = runAsCaller(owner.id, () =>
      rt.prepareRun({ goal: "g", teamId: "t", teamSnapshot: snap, cwd: "/r" })
    );

    await rt.runEntry(runId, "g");

    assert.deepEqual(observed, [{ userId: owner.id, isAdmin: true }]);
  });
});

test("entry agent without model omits configOptionOverrides", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    let spawned = null;
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({ adapter: "codex-acp", agentName: "Codex", skillIds: [] }),
      runAgent: async (args) => { spawned = args; return { summary: "done", exitCode: 0, error: null }; }
    });
    const runId = rt.prepareRun({ goal: "实现X", teamId: "t", teamSnapshot: snap, cwd: "/r" });
    await rt.runEntry(runId, "实现X");
    assert.equal(spawned.configOptionOverrides, undefined);
  });
});

test("entry uses isolated toolSessionScope; entry and delegate scopes differ", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { dispatchDelegateAction } = await import("../dist-electron/cli/delegationDispatch.js");
    const scopes = {};
    let entryScope = null;
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({ adapter: id.includes("claude") ? "claude-agent-acp" : "codex-acp", agentName: id, skillIds: [] }),
      runAgent: async (args) => {
        scopes[args.sessionId] = args.toolSessionScope;
        if (args.delegation.depth === 0 && !entryScope) {
          entryScope = args.toolSessionScope;
          // delegate to r-rev so we can also capture the teammate scope
          await dispatchDelegateAction(
            { token: "t", taskSessionId: "s", runId: args.delegation.runId, parentEventId: args.delegation.parentEventId, depth: 0, selfAgentId: "r-impl", selfLabel: "实现" },
            "delegate", { teammate_id: "r-rev", task: "审" }
          );
        }
        return { summary: "", exitCode: 0, error: null };
      }
    });
    const runId = await rt.start({ goal: "实现X", teamId: "t", teamSnapshot: snap, cwd: "/r" });
    await tick(50);
    assert.equal(entryScope, `delegation:${runId}:entry`);
    const teammateScope = Object.values(scopes).find((v) => v && v !== entryScope);
    assert.match(String(teammateScope), new RegExp(`^delegation:${runId}:`));
    assert.notEqual(teammateScope, entryScope);
  });
});

test("entry parks on pending delegate and is resumed with the result (wake prompt)", async (t) => {
  if (!bindingAvailable) { t.skip(); return; }
  await withDb(async () => {
    const { DelegationRuntime } = await import("../dist-electron/cli/delegationRuntime.js");
    const { dispatchDelegateAction } = await import("../dist-electron/cli/delegationDispatch.js");
    const { getDelegationRun } = await import("../dist-electron/cli/delegationRuns.js");
    const entryPrompts = [];
    const rt = new DelegationRuntime({
      webContents: undefined,
      resolveAgent: (id) => ({ adapter: id.includes("claude") ? "claude-agent-acp" : "codex-acp", agentName: id, skillIds: [] }),
      runAgent: async (args) => {
        // entry turns (depth 0) vs teammate turns (depth >= 1)
        if (args.delegation.depth === 0) {
          entryPrompts.push(args.prompt);
          if (entryPrompts.length === 1) {
            // first entry turn fires a real delegate to the reviewer teammate
            await dispatchDelegateAction(
              { token: "t", taskSessionId: "s", runId: args.delegation.runId, parentEventId: args.delegation.parentEventId, depth: 0, selfAgentId: "r-impl", selfLabel: "实现" },
              "delegate", { teammate_id: "r-rev", task: "审 auth" }
            );
          }
          return { summary: `entry turn ${entryPrompts.length}`, exitCode: 0, error: null };
        }
        // teammate (reviewer) returns a review result
        return { summary: "REVIEW: Not ready, bomb not synthesizable", exitCode: 0, error: null };
      }
    });
    const runId = await rt.start({ goal: "实现X", teamId: "t", teamSnapshot: snap, cwd: "/r" });
    await tick(50);
    // entry must have been woken for a second turn carrying the review result
    assert.equal(entryPrompts.length, 2, "entry should park then wake exactly once");
    assert.ok(entryPrompts[1].includes("委派结果返回"), "second turn must use the wake prompt");
    assert.ok(entryPrompts[1].includes("Not ready, bomb"), "wake prompt must carry the delegate result");
    assert.equal(getDelegationRun(runId).status, "completed");
  });
});

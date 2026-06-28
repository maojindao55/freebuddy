import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../dist-electron/cli/businessRuntimeCore.js");

function makeRun(opts = {}) {
  const surfaces = opts.surfaces ?? [
    { id: "server", role: "provider", deps: [], verify: ["true"] },
    { id: "client", role: "consumer", deps: ["server"], verify: ["true"] }
  ];
  return {
    id: "run-1",
    workspaceId: "ws-1",
    workspaceSnapshot: {
      id: "ws-1",
      name: "WS",
      surfaces: surfaces.map((s) => ({
        id: s.id,
        name: s.id,
        kind: "server",
        repoPath: `/tmp/abs/repo-${s.id}`,
        defaultAgentId: "cli-codex-acp",
        allowedPaths: ["src"],
        verifyCommands: [],
        responsibilities: [],
        contractRole: s.role,
        enabled: true
      })),
      policy: {
        requireAssignmentApproval: true,
        requireCommitApproval: true,
        blockCommitOnVerificationFailure: true,
        requireCleanRepoBeforeRun: opts.requireClean ?? false,
        branchNameTemplate: "fb/{{runSlug}}/{{surfaceKey}}"
      }
    },
    goal: "test goal",
    status: "running",
    assignmentPlan: {
      surfaces: surfaces.map((s) => ({
        surfaceId: s.id,
        agentId: "cli-codex-acp",
        repoPath: `/tmp/abs/repo-${s.id}`,
        tasks: ["do thing"],
        dependsOnSurfaceIds: s.deps,
        writes: true,
        verifyCommands: s.verify
      })),
      dependencies: [],
      needsContractDraft: false,
      summary: "x"
    },
    contractDraft: undefined,
    surfaceRuns: surfaces.map((s) => ({
      id: `sr-${s.id}`,
      surfaceId: s.id,
      agentId: "cli-codex-acp",
      repoPath: `/tmp/abs/repo-${s.id}`,
      status: "pending",
      taskSummary: "",
      verificationResults: []
    })),
    commitGate: undefined,
    createdAt: "",
    updatedAt: ""
  };
}

function makeDeps(opts = {}) {
  const state = { surfaceRuns: [], status: "running" };
  let active = 0;
  let maxActive = 0;
  const cliRunCalls = [];
  const deps = {
    async cliRun(args) {
      cliRunCalls.push(args.sessionId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (opts.cliDelay) await new Promise((r) => setTimeout(r, opts.cliDelay));
      active -= 1;
      if (opts.cliFail && opts.cliFail(args)) throw new Error("cli boom");
    },
    async ensureCleanRepo() {
      return opts.cleanRepo ?? { ok: true, summary: "clean" };
    },
    async runVerifyCommand(cwd, command) {
      if (opts.verifyFail && opts.verifyFail(cwd)) {
        return {
          command,
          cwd,
          status: "failed",
          exitCode: 1,
          summary: "fail",
          startedAt: "",
          endedAt: ""
        };
      }
      return {
        command,
        cwd,
        status: "passed",
        exitCode: 0,
        summary: "ok",
        startedAt: "",
        endedAt: ""
      };
    },
    patchSurfaceRuns(updater) {
      state.surfaceRuns = updater(state.surfaceRuns);
    },
    setStatus(status) {
      state.status = status;
    }
  };
  return { deps, state, cliRunCalls, maxActive: () => maxActive };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("startBusinessRun: independent surfaces run concurrently and succeed", async () => {
  const run = makeRun({
    surfaces: [
      { id: "alpha", role: "none", deps: [], verify: [] },
      { id: "beta", role: "none", deps: [], verify: [] }
    ]
  });
  const ctx = makeDeps({ cliDelay: 20 });
  ctx.state.surfaceRuns = run.surfaceRuns.map((s) => ({ ...s }));

  const result = await core.startBusinessRunCore(run, ctx.deps);

  assert.equal(result.ok, true);
  assert.equal(ctx.state.status, "awaiting_commit_approval");
  assert.equal(ctx.cliRunCalls.length, 2);
  assert.equal(ctx.maxActive(), 2, "both surfaces overlapped in the same wave");
  for (const sr of ctx.state.surfaceRuns) {
    assert.equal(sr.status, "done");
  }
});

test("startBusinessRun: a verification failure fails the run and blocks dependent waves", async () => {
  const run = makeRun({
    surfaces: [
      { id: "server", role: "provider", deps: [], verify: ["true"] },
      { id: "client", role: "consumer", deps: ["server"], verify: ["true"] }
    ]
  });
  const ctx = makeDeps({
    verifyFail: (cwd) => cwd.includes("repo-server")
  });
  ctx.state.surfaceRuns = run.surfaceRuns.map((s) => ({ ...s }));

  const result = await core.startBusinessRunCore(run, ctx.deps);

  assert.equal(result.ok, false);
  assert.equal(ctx.state.status, "failed");
  const server = ctx.state.surfaceRuns.find((s) => s.surfaceId === "server");
  const client = ctx.state.surfaceRuns.find((s) => s.surfaceId === "client");
  assert.equal(server.status, "failed");
  assert.ok(
    !ctx.cliRunCalls.some((id) => id.includes("client")),
    "dependent client wave never ran after server verification failed"
  );
  assert.equal(client.status, "pending");
});

test("startBusinessRun: dirty repo blocks the run before any agent runs", async () => {
  const run = makeRun({ requireClean: true });
  const ctx = makeDeps({
    cleanRepo: { ok: false, summary: "repo has uncommitted changes" }
  });
  ctx.state.surfaceRuns = run.surfaceRuns.map((s) => ({ ...s }));

  const result = await core.startBusinessRunCore(run, ctx.deps);

  assert.equal(result.ok, false);
  assert.equal(ctx.state.status, "failed");
  assert.equal(ctx.cliRunCalls.length, 0);
  const blocked = ctx.state.surfaceRuns.find((s) => s.surfaceId === "server");
  assert.equal(blocked.status, "blocked");
});

test("startBusinessRun: a cliRun exception marks the surface failed", async () => {
  const run = makeRun({
    surfaces: [{ id: "solo", role: "none", deps: [], verify: [] }]
  });
  const ctx = makeDeps({ cliFail: () => true });
  ctx.state.surfaceRuns = run.surfaceRuns.map((s) => ({ ...s }));

  const result = await core.startBusinessRunCore(run, ctx.deps);

  assert.equal(result.ok, false);
  assert.equal(ctx.state.status, "failed");
  assert.equal(ctx.state.surfaceRuns[0].status, "failed");
});

test("startBusinessRun: allowedPaths and contract are injected into the prompt", async () => {
  const run = makeRun({
    surfaces: [{ id: "solo", role: "none", deps: [], verify: [] }]
  });
  run.contractDraft = {
    id: "c1",
    title: "Membership contract",
    providerSurfaceIds: ["server"],
    consumerSurfaceIds: ["client"],
    endpoints: [
      { method: "POST", path: "/api/x", request: "r", response: "s", errors: [] }
    ],
    dataRules: ["rule a"],
    permissionRules: ["perm b"]
  };
  const captured = [];
  const ctx = makeDeps({});
  ctx.deps.cliRun = async (args) => {
    captured.push(args.prompt);
  };
  ctx.state.surfaceRuns = run.surfaceRuns.map((s) => ({ ...s }));

  await core.startBusinessRunCore(run, ctx.deps);

  const prompt = captured[0];
  assert.match(prompt, /STRICT SCOPE/);
  assert.match(prompt, /src/);
  assert.match(prompt, /Membership contract/);
  assert.match(prompt, /POST \/api\/x/);
  assert.match(prompt, /rule a/);
  assert.match(prompt, /perm b/);
});

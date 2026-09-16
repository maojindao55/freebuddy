import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import ts from "typescript";
import * as acp from "../dist-electron/cli/acp.js";
import { DelegationOrchestrator, createMemoryDelegationRepository } from "../packages/delegation-runtime/dist/index.js";

// Execute the actual runtime with fake transport and desktop services. Unlike
// source-pattern tests, this exercises cancellation, pending RPCs and return.
const source = fs.readFileSync(new URL("../electron/cli/acpRuntime.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
const require = createRequire(import.meta.url);

async function runScenario(t, mode) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const running = new Map();
  const events = [], requests = [], traces = [];
  const timers = new Set();
  let killCount = 0;
  const close = () => {
    if (child.exitCode != null) return;
    child.exitCode = 1;
    child.stdin.destroy();
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 1);
  };
  const reply = (msg, result) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const msg = JSON.parse(chunk.toString());
      requests.push(msg.method);
      callback();
      queueMicrotask(() => {
        if (msg.method === "initialize") reply(msg, {
          protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, close: {} } }
        });
        else if (msg.method === "session/new") reply(msg, { sessionId: "fake-session" });
        else if (msg.method === "session/prompt") {
          if (mode.startsWith("yield")) running.get("test-turn").yield();
          else reply(msg, { stopReason: "end_turn" });
        } else if (msg.method === "session/cancel") {
          if (mode === "yield-close") close();
          // yield-silent deliberately never replies or exits until killed.
        } else if (msg.method === "session/list") {
          if (mode === "exit-during-list") close();
          else if (mode !== "silent-cleanup") reply(msg, { sessions: [] });
        } else if (msg.method === "session/close" && mode !== "silent-cleanup") reply(msg, {});
      });
    }
  });
  const noop = () => {};
  const services = {
    createAcpTerminalManager: () => ({ dispose: noop }),
    logMain: () => ({ info: (...args) => traces.push(args), warn: (...args) => traces.push(args), error: (...args) => traces.push(args) }),
    selectAcpSessionStartMode: acp.selectAcpSessionStartMode,
    getLanguage: () => "en-US",
    killProcessTree: () => { killCount++; close(); },
    formatAcpAgentExitMessage: (code) => `Agent exited ${code}`
  };
  const exports = {};
  const context = {
    exports, process, console, Buffer,
    setTimeout: (fn, delay) => {
      // Accelerate only teardown timers; preserve the inactivity watchdog.
      const timer = setTimeout(fn, [250, 500, 2000].includes(delay) ? 10 : delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout,
    require: (name) => {
      if (name.startsWith("node:")) return require(name);
      if (name === "./acp.js") return acp;
      return new Proxy(services, { get: (obj, key) => key === "__esModule" ? true : obj[key] ?? noop });
    }
  };
  t.after(() => { for (const timer of timers) clearTimeout(timer); close(); });
  vm.runInNewContext(compiled, context);
  const turn = exports.runAcpAgent({
    child, pid: 1, webContents: {},
    args: { sessionId: "test-turn", agentId: "test", adapter: "codex-acp", prompt: "test" },
    logStream: null, running, capturedSessions: new Map(), emit: event => events.push(event),
    agentCommand: { bin: "fake", args: [], env: {} }, restartAgent: async () => { throw new Error("unexpected restart"); }
  });
  let deadline;
  try {
    await Promise.race([turn, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("ACP turn did not return to scheduler")), 1000);
    })]);
  } finally { clearTimeout(deadline); }
  await new Promise(resolve => setTimeout(resolve, 30));
  return { events, requests, traces, running, killCount };
}

for (const mode of ["yield-close", "yield-silent"]) {
  test(`delegation ${mode} returns without cleanup RPCs and reaps its process`, async t => {
    const result = await runScenario(t, mode);
    assert.deepEqual(result.requests, ["initialize", "session/new", "session/prompt", "session/cancel"]);
    assert.equal(result.events.filter(e => e.type === "done").length, 1);
    assert.equal(result.events.find(e => e.type === "done").exitCode, 0);
    assert.equal(result.events.some(e => e.type === "error"), false);
    assert.equal(result.running.size, 0);
    if (mode === "yield-silent") assert.equal(result.killCount, 1);
  });
}

test("process exit during metadata cleanup never sends close to the dead connection", async t => {
  const result = await runScenario(t, "exit-during-list");
  assert.equal(result.requests.includes("session/list"), true);
  assert.equal(result.requests.includes("session/close"), false);
  assert.equal(result.events.filter(e => e.type === "done").length, 1);
});

test("silent metadata and close requests time out without blocking normal completion", async t => {
  const result = await runScenario(t, "silent-cleanup");
  assert.equal(result.events.find(e => e.type === "done").exitCode, 0);
  assert.equal(result.traces.filter(entry => entry[1] === "cleanup request timed out").length, 2);
});

test("normal ACP completion still receives metadata and closes its session", async t => {
  const result = await runScenario(t, "normal");
  assert.deepEqual(result.requests.slice(-2), ["session/list", "session/close"]);
  assert.equal(result.events.find(e => e.type === "done").exitCode, 0);
  assert.equal(result.traces.some(entry => entry[1] === "cleanup request timed out"), false);
});

test("ACP yield returns far enough for the parent to park and consume a completed child", async t => {
  const repository = createMemoryDelegationRepository();
  const run = repository.createRun({ goal: "test", status: "running", teamId: "team", teamSnapshotJson: "{}" });
  const insert = (parentEventId, depth) => repository.insertEvent({
    runId: run.id, parentEventId, depth, agentId: "agent", agentName: "Agent",
    roleLabel: "planner", taskText: "test", canWrite: false, status: "running"
  });
  const rootId = insert(null, 0);
  let childId, turns = 0, orchestrator;
  let parkedResolve;
  const parked = new Promise(resolve => { parkedResolve = resolve; });
  orchestrator = new DelegationOrchestrator({
    runId: run.id, repository, entryRoleId: "planner",
    roster: [{ id: "planner", agentId: "agent", label: "planner", canWrite: false }],
    policy: { maxDepth: 3 },
    trace(event) { if (event === "wait registered") parkedResolve(); },
    async spawnTurn({ kind, prompt }) {
      turns++;
      if (turns === 1) {
        childId = insert(rootId, 1);
        orchestrator.noteChildEnqueued({ childEventId: childId, parentEventId: rootId, depth: 1 });
        orchestrator.noteChildStarted(childId);
        await runScenario(t, "yield-close");
        return { summary: "delegated", error: null, hasOutput: true };
      }
      assert.equal(kind, "wake");
      assert.match(prompt, /review passed/);
      return { summary: "complete", error: null, hasOutput: true };
    }
  });
  orchestrator.bindEntry(rootId);
  const drive = orchestrator.runNodeLoop({ nodeId: rootId, depth: 0, selfAgentId: "planner", selfLabel: "planner", initialPrompt: "test" });
  let deadline;
  try {
    await Promise.race([parked, drive.then(() => { throw new Error("parent ended before parking"); }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("parent did not park")), 1500); })]);
    assert.equal(orchestrator.state.nodes[rootId].status, "parked");
    repository.updateEvent(childId, { status: "done", resultSummary: "review passed", verdict: "pass" });
    orchestrator.onEventSettled(childId);
    await drive;
    assert.equal(turns, 2);
    assert.equal(repository.getRun(run.id).status, "completed");
  } finally { clearTimeout(deadline); }
});

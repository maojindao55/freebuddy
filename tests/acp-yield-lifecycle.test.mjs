import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import ts from "typescript";
import * as acp from "../dist-electron/cli/acp.js";
import { RunMetricsCollector } from "../dist-electron/cli/runMetricsCollector.js";
import { PiRunUsageReader } from "../dist-electron/cli/piRunUsage.js";
import { DelegationOrchestrator, createMemoryDelegationRepository } from "../packages/delegation-runtime/dist/index.js";

// Execute the actual runtime with fake transport and desktop services. Unlike
// source-pattern tests, this exercises cancellation, pending RPCs and return.
const source = fs.readFileSync(new URL("../electron/cli/acpRuntime.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
const require = createRequire(import.meta.url);

async function runScenario(t, mode, adapter = "codex-acp", warm) {
  const child = warm?.child ?? new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout ??= new PassThrough();
  child.stderr ??= new PassThrough();
  const running = new Map();
  const events = [], requests = [], traces = [];
  const timers = new Set();
  const isPi = mode.startsWith("pi-");
  const piDataDir = isPi ? fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-acp-metrics-")) : undefined;
  const piSessionFile = piDataDir && path.join(piDataDir, "pi-agent", "sessions", "--project--", "date_fake-session.jsonl");
  if (piSessionFile) {
    fs.mkdirSync(path.dirname(piSessionFile), { recursive: true });
    fs.writeFileSync(piSessionFile, JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 } } }) + "\n");
    t.after(() => fs.rmSync(piDataDir, { recursive: true, force: true }));
  }
  let metricClock = 100;
  const metricSnapshots = [];
  const metrics = new RunMetricsCollector("test-turn", snapshot => metricSnapshots.push(snapshot), () => metricClock);
  const notify = update => child.stdout.write(JSON.stringify({
    jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-session", update }
  }) + "\n");
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
        if (msg.method === "initialize") {
          metricClock = 500;
          notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pre-prompt replay" } });
          reply(msg, { protocolVersion: 1, ...(mode.startsWith("warm") ? { _meta: { freebuddy: { persistentSession: true } } } : {}), agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } });
        }
        else if (msg.method === "session/new" || msg.method === "session/load") reply(msg, { sessionId: "fake-session" });
        else if (msg.method === "session/prompt") {
          if (isPi) {
            fs.appendFileSync(piSessionFile, JSON.stringify({ type: "custom", customType: "freebuddy-generation-metrics", data: { version: 1, outputTokens: 20, durationMs: 500 } }) + "\n");
            fs.appendFileSync(piSessionFile, JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 50, output: 20, cacheRead: 100, cacheWrite: 5, reasoning: 3 } } }) + "\n");
            notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new Pi body" } });
            if (mode === "pi-cancel") running.get("test-turn").cancel();
            else if (mode === "pi-yield") running.get("test-turn").yield();
            else reply(msg, { stopReason: "end_turn", ...(mode === "pi-upstream" ? { usage: { inputTokens: 250, outputTokens: 40 } } : {}) });
          } else if (mode.startsWith("yield")) running.get("test-turn").yield();
          else if (mode === "cancel") running.get("test-turn").cancel();
          else if (mode.startsWith("unified-")) {
            notify({ sessionUpdate: "usage_update", used: 9_000, size: 128_000, outputTokens: 9_999 });
            metricClock = 1_000;
            notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } });
            if (mode !== "unified-buffered") {
              metricClock = 1_500;
              notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } });
            }
            if (mode === "unified-tools") {
              metricClock = 2_000;
              notify({ sessionUpdate: "tool_call", toolCallId: "tool", title: "Tool", status: "pending" });
              metricClock = 10_000;
              notify({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" });
              metricClock = 12_000;
              notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } });
              metricClock = 13_000;
              notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tool" } });
              metricClock = 14_000;
            } else metricClock = 2_000;
            reply(msg, { stopReason: "end_turn", ...(mode !== "unified-missing-usage" ? { usage: { inputTokens: 10, outputTokens: 120 } } : {}) });
          } else if (mode.startsWith("warm")) {
            metricClock = 1_000;
            notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new warm body" } });
            metricClock = 2_000;
            reply(msg, { stopReason: mode === "warm-cancel" ? "cancelled" : "end_turn", usage: { inputTokens: 100, outputTokens: 20, thoughtTokens: 10 },
              _meta: { metrics: { usageScope: "turn", modelCallDurationMs: 500 } } });
          } else if (mode === "metrics") {
            metricClock = 700;
            notify({ sessionUpdate: "agent_message_chunk", messageId: "historical", content: { type: "text", text: "historical reply" } });
            metricClock = 800;
            notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
            metricClock = 1_280;
            notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new body" } });
            metricClock = 1_500;
            reply(msg, { stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 40 } });
          } else reply(msg, { stopReason: mode === "cancel-result" ? "cancelled" : "end_turn" });
        } else if (msg.method === "session/cancel") {
          if (["yield-close", "cancel", "pi-cancel", "pi-yield"].includes(mode)) close();
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
    PiRunUsageReader,
    getDataDir: () => piDataDir,
    persistFileEditItems: (_sessionId, items) => items,
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
  const warmConnection = mode.startsWith("warm") ? warm ?? { child, fingerprint: "same", conversationId: "chat", requestId: 0, dispose: noop } : undefined;
  let parked = false;
  const turn = exports.runAcpAgent({
    child, pid: 1, webContents: {},
    warmConnection, parkConnection: warmConnection ? () => { parked = true; } : undefined,
    args: { sessionId: "test-turn", agentId: "test", adapter: isPi ? "pi-acp" : adapter, prompt: "test", knownStreamMessageIds: ["historical"] },
    toolSessionId: warm?.sessionId ?? (mode === "metrics" ? "fake-session" : undefined),
    logStream: null, running, capturedSessions: new Map(), emit: event => events.push(event), metrics,
    agentCommand: { bin: "fake", args: [], env: {} }, restartAgent: async () => { throw new Error("unexpected restart"); }
  });
  let deadline;
  try {
    await Promise.race([turn, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("ACP turn did not return to scheduler")), 1000);
    })]);
  } finally { clearTimeout(deadline); }
  await new Promise(resolve => setTimeout(resolve, 30));
  return { events, requests, traces, running, killCount, metricSnapshots, warmConnection, parked, child };
}

for (const mode of ["yield-close", "yield-silent"]) {
  test(`delegation ${mode} returns without cleanup RPCs and reaps its process`, async t => {
    const result = await runScenario(t, mode);
    assert.deepEqual(result.requests, ["initialize", "session/new", "session/prompt", "session/cancel"]);
    assert.equal(result.events.filter(e => e.type === "done").length, 1);
    assert.equal(result.events.find(e => e.type === "done").exitCode, 0);
    assert.equal(result.events.some(e => e.type === "error"), false);
    assert.equal(result.running.size, 0);
    assert.equal(result.metricSnapshots.at(-1).status, "yielded");
    if (mode === "yield-silent") assert.equal(result.killCount, 1);
  });
}


test("ACP metrics exclude initialization and resumed replay, measure before UI delivery, and retain turn usage", async t => {
  const result = await runScenario(t, "metrics");
  const final = result.metricSnapshots.at(-1);
  assert.equal(final.status, "done");
  assert.equal(final.firstTextLatencyMs, 780);
  assert.equal(final.elapsedMs, 1_400);
  assert.equal(final.inputTokens, 0);
  assert.equal(final.outputTokens, 40);
  assert.equal(final.speedSource, "observed");
  assert.equal(final.tokensPerSecond, 40 * 1000 / 700);
  assert.equal(result.events.some(event => event.type === "items" && event.items.some(item => item.content === "historical reply")), false);
});

for (const adapter of ["codex-acp", "claude-agent-acp", "opencode-acp", "gemini-acp", "qoder-acp", "dsh-acp"]) {
  test(`${adapter} automatically derives stream speed from real prompt usage without a reported rate`, async t => {
    const result = await runScenario(t, "unified-stream", adapter);
    const final = result.metricSnapshots.at(-1);
    assert.equal(final.tokensPerSecond, 120);
    assert.equal(final.speedSource, "observed");
    assert.equal(final.automaticSpeed, true);
    assert.equal(final.generationDurationMs, 1_000);
  });
}

test("ACP common timing excludes tools and cleanup; buffered / unreported usage remains unavailable", async t => {
  const tool = await runScenario(t, "unified-tools");
  assert.equal(tool.metricSnapshots.at(-1).tokensPerSecond, 40);
  assert.equal(tool.metricSnapshots.at(-1).generationDurationMs, 3_000);
  for (const mode of ["unified-buffered", "unified-missing-usage"]) {
    const result = await runScenario(t, mode);
    assert.equal(result.metricSnapshots.at(-1).tokensPerSecond, undefined);
  }
});

for (const mode of ["cancel", "cancel-result"]) {
  test(`ACP ${mode} preserves cancellation separately from process exit`, async t => {
    const result = await runScenario(t, mode);
    assert.equal(result.metricSnapshots.at(-1).status, "cancelled");
  });
}


for (const [mode, status] of [["pi-usage", "done"], ["pi-cancel", "cancelled"], ["pi-yield", "yielded"], ["pi-upstream", "done"]]) {
  test(`${mode} persists only this prompt's native Pi usage before terminal metrics`, async t => {
    const result = await runScenario(t, mode);
    const final = result.metricSnapshots.at(-1);
    assert.equal(final.status, status);
    assert.equal(final.inputTokens, mode === "pi-upstream" ? 250 : 155);
    assert.equal(final.outputTokens, mode === "pi-upstream" ? 40 : 20);
    assert.equal(final.tokensPerSecond, 40);
    assert.equal(final.speedSource, "measured");
    assert.equal(final.automaticSpeed, true);
    const usageIndex = result.events.findIndex(event => event.type === "items" && event.items?.some(item => item.kind === "usage" && item.usageScope === "turn"));
    const doneIndex = result.events.findIndex(event => event.type === "done");
    assert.ok(usageIndex >= 0 && usageIndex < doneIndex);
    assert.equal(result.events.slice(doneIndex + 1).some(event => event.type === "items" && event.items?.some(item => item.usageScope === "turn")), false);
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


test("AGY warm turns retain ACP transport, skip repeated initialize, and keep per-turn metrics", async t => {
  const first = await runScenario(t, "warm", "agy-acp");
  assert.equal(first.parked, true);
  assert.equal(first.child.stdin.writableEnded, false);
  assert.equal(first.child.listenerCount("close"), 0);
  assert.deepEqual(first.requests, ["initialize", "session/new", "session/prompt", "session/list"]);
  const firstRequestId = first.warmConnection.requestId;
  const second = await runScenario(t, "warm", "agy-acp", first.warmConnection);
  assert.equal(second.child, first.child);
  assert.equal(second.parked, true);
  assert.deepEqual(second.requests, ["session/load", "session/prompt", "session/list"]);
  assert.ok(second.warmConnection.requestId > firstRequestId);
  assert.equal(second.metricSnapshots.at(-1).tokensPerSecond, 40);
  assert.equal(second.metricSnapshots.at(-1).outputTokens, 20);
  assert.equal(second.metricSnapshots.at(-1).speedSource, "call-average");
  assert.equal(second.child.listenerCount("close"), 0);
  assert.equal(second.child.stdout.listenerCount("data"), 0);
  assert.equal(second.child.stderr.listenerCount("data"), 0);
});


test("cancelled AGY turns are reaped instead of entering the warm pool", async t => {
  const result = await runScenario(t, "warm-cancel", "agy-acp");
  assert.equal(result.parked, false);
  assert.equal(result.child.stdin.writableEnded, true);
  assert.equal(result.metricSnapshots.at(-1).status, "cancelled");
  assert.ok(result.requests.includes("session/close"));
});

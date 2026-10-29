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
import * as acpLocalDiff from "../dist-electron/cli/acpLocalDiff.js";
import * as piTurn from "../dist-electron/cli/piTurn.js";
import * as acpEmbeddedTerminal from "../dist-electron/cli/acpEmbeddedTerminal.js";
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

async function runScenario(t, mode, adapter = "codex-acp", warm, captureOptions) {
  const child = warm?.child ?? new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout ??= new PassThrough();
  child.stderr ??= new PassThrough();
  const running = new Map();
  const events = [], requests = [], traces = [];
  const captureOrder = [];
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
      const failingMethod = {
        "stdin-initialize-error": "initialize",
        "stdin-prompt-error": "session/prompt",
        "stdin-list-error": "session/list",
        "stdin-probe-error": "session/list",
        "stdin-sync-error": "session/prompt",
        "stdin-cancel-error": "session/cancel",
        "yield-stdin-error": "session/cancel"
      }[mode];
      if ((failingMethod && msg.method === failingMethod) || msg.id === "server-request") {
        // Node invokes the write callback AND emits an error on the stream.
        // The process still looks alive when the write is submitted.
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        if (mode === "stdin-sync-error") throw error;
        callback(error);
        return;
      }
      callback();
      queueMicrotask(() => {
        if (msg.method === "initialize") {
          metricClock = 500;
          notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pre-prompt replay" } });
          reply(msg, { protocolVersion: 1, ...(mode.startsWith("warm") ? { _meta: { freebuddy: { persistentSession: true } } } : {}),
            ...(mode.startsWith("pi-v1-") ? { _meta: { piAcp: { lifecycleStatusVersion: 1, promptOutcomeVersion: 1 } } } : {}),
            agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } });
        }
        else if (msg.method === "session/new" || msg.method === "session/load") reply(msg, { sessionId: "fake-session" });
        else if (msg.method === "session/prompt") {
          if (captureOptions) { assert.ok(captureOrder.includes("prepared")); captureOrder.push("prompt"); }
          if (mode === "pi-terminal-metadata") {
            notify({ sessionUpdate: "tool_call", toolCallId: "pi-tool", kind: "execute", title: "git status --short", status: "in_progress",
              content: [{ type: "terminal", terminalId: "pi-tool" }], _meta: { terminal_info: { terminal_id: "pi-tool", cwd: "C:/project" } } });
            notify({ sessionUpdate: "tool_call_update", toolCallId: "pi-tool", status: "in_progress",
              _meta: { terminal_output: { terminal_id: "pi-tool", data: "first line\n" } } });
            notify({ sessionUpdate: "tool_call_update", toolCallId: "pi-tool", status: "completed", _meta: {
              terminal_output: { terminal_id: "pi-tool", data: "last line\n" }, terminal_exit: { terminal_id: "pi-tool", exit_code: 0, signal: null }
            } });
            notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Command complete." } });
            reply(msg, { stopReason: "end_turn" });
          } else if (mode.startsWith("pi-v1-")) {
            // The modern adapter owns completion validation. Stale native metadata
            // cannot override its wire outcome or supply an error description.
            fs.appendFileSync(piSessionFile, JSON.stringify({ type: "message", message: {
              role: "assistant", content: [{ type: "thinking", thinking: "stale private reasoning" }], stopReason: "error", errorMessage: "stale native failure"
            } }) + "\n");
            const status = (type, phase, detail = {}) => notify({ sessionUpdate: "session_info_update", _meta: {
              piAcp: { status: { version: 1, type, phase, ...detail } }
            } });
            status("retry", "started", { attempt: 1, maxAttempts: 3, delayMs: 2000 });
            status("retry", "succeeded");
            status("compaction", "started");
            status("compaction", "succeeded");
            if (mode === "pi-v1-error") {
              status("retry", "failed");
              child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "The model ended with thinking but no answer." } }) + "\n");
            } else {
              notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Retrying (attempt 1/3, waiting 2s)..." } });
              reply(msg, { stopReason: mode === "pi-v1-limit" ? "max_tokens" : mode === "pi-v1-cancel" ? "cancelled" : "end_turn" });
            }
          } else if (mode === "limit-requests") reply(msg, { stopReason: "max_turn_requests" });
          else if (isPi) {
            const thinkingOnly = mode === "pi-thinking-only" || mode === "pi-thinking-after-tool" || mode === "pi-cancel-thinking";
            const nativeError = mode === "pi-retry-exhausted";
            const piBody = mode === "pi-malformed"
              ? "<thinking>unfinished</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>" : "new Pi body";
            if (mode.startsWith("pi-retry")) {
              fs.appendFileSync(piSessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 free_campaign_global_limit" } }) + "\n");
              notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Retrying (attempt 1/3, waiting 2s)..." } });
              notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Retry finished, resuming." } });
            }
            if (mode === "pi-thinking-after-tool") {
              notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking the PR." } });
              notify({ sessionUpdate: "tool_call", toolCallId: "fetch", title: "Fetch", status: "pending" });
              notify({ sessionUpdate: "tool_call_update", toolCallId: "fetch", status: "completed" });
            }
            fs.appendFileSync(piSessionFile, JSON.stringify({ type: "custom", customType: "freebuddy-generation-metrics", data: { version: 1, outputTokens: 20, durationMs: 500 } }) + "\n");
            if (!nativeError && mode !== "pi-no-native-thinking") fs.appendFileSync(piSessionFile, JSON.stringify({ type: "message", message: {
              role: "assistant", content: thinkingOnly ? [{ type: "thinking", thinking: "private reasoning" }] : [{ type: "text", text: piBody }],
              stopReason: mode === "pi-length" ? "length" : "stop", usage: { input: 50, output: 20, cacheRead: 100, cacheWrite: 5, reasoning: 3 }
            } }) + "\n");
            if (!nativeError) notify({ sessionUpdate: thinkingOnly || mode === "pi-no-native-thinking" ? "agent_thought_chunk" : "agent_message_chunk", content: { type: "text", text: thinkingOnly ? "private reasoning" : piBody } });
            if (mode === "pi-outstanding-tool") notify({ sessionUpdate: "tool_call", toolCallId: "pending", title: "Tool", status: "in_progress" });
            if (mode === "pi-cancel" || mode === "pi-cancel-thinking") running.get("test-turn").cancel();
            else if (mode === "pi-yield") running.get("test-turn").yield();
            else reply(msg, { stopReason: "end_turn", ...(mode === "pi-upstream" ? { usage: { inputTokens: 250, outputTokens: 40 } } : {}) });
          } else if (mode === "failed") child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "fixture prompt failed" } }) + "\n");
          else if (mode.startsWith("yield")) running.get("test-turn").yield();
          else if (mode === "cancel" || mode === "stdin-cancel-error") running.get("test-turn").cancel();
          else if (mode === "stdin-probe-error") { /* Wait for the inactivity probe. */ }
          else if (mode === "stdin-stream-error") child.stdin.emit("error", new Error("write EPIPE"));
          else if (mode === "stdin-permission-error" || mode === "stdin-terminal-error" || mode === "stdin-unsupported-error") {
            const method = { "stdin-permission-error": "session/request_permission",
              "stdin-terminal-error": "terminal/output", "stdin-unsupported-error": "unsupported/method" }[mode];
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "server-request", method,
              params: { sessionId: "fake-session", options: [{ optionId: "allow-once", kind: "allow_once" }] }
            }) + "\n");
          }
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
          } else if (mode.startsWith("first-tool")) {
            metricClock = 800;
            notify({ sessionUpdate: "tool_call", toolCallId: "first-tool", title: "Tool", status: "in_progress",
              ...(mode === "first-tool-plan" ? { rawInput: { todos: [{ content: "Plan", status: "in_progress" }] } } : {}) });
            metricClock = 10_000;
            notify({ sessionUpdate: "tool_call_update", toolCallId: "first-tool", status: "completed" });
            metricClock = 12_000;
            notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "body after tool" } });
            metricClock = 13_000;
            reply(msg, { stopReason: "end_turn" });
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
          if (["yield-close", "cancel", "pi-cancel", "pi-cancel-thinking", "pi-yield"].includes(mode)) close();
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
    prepareTurnFileCapture: async input => {
      captureOrder.push("prepare");
      assert.equal(input.taskId, "test-turn");
      await new Promise(resolve => setImmediate(resolve));
      captureOrder.push("prepared");
      if (captureOptions.failPrepare) throw new Error("capture failed");
      return { taskId: input.taskId };
    },
    finalizeTurnFileCapture: async () => {
      captureOrder.push("finalize");
      await new Promise(resolve => setImmediate(resolve));
      captureOrder.push("sealed");
    },
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
      // Accelerate teardown, and the watchdog only for the failed-probe case.
      const timer = setTimeout(fn, [250, 500, 2000].includes(delay) ||
        (mode === "stdin-probe-error" && delay === 10 * 60 * 1000) ? 10 : delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout,
    require: (name) => {
      if (name.startsWith("node:")) return require(name);
      if (name === "./acp.js") return acp;
      if (name === "./acpLocalDiff.js") return acpLocalDiff;
      if (name === "./piTurn.js") return piTurn;
      if (name === "./acpEmbeddedTerminal.js") return acpEmbeddedTerminal;
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
    args: { sessionId: "test-turn", agentId: "test", adapter: isPi ? "pi-acp" : adapter, approvalMode: "auto", prompt: "test", knownStreamMessageIds: ["historical"],
      ...(captureOptions ? { conversationId: "conversation", cwd: "C:/project" } : {}) },
    toolSessionId: warm?.sessionId ?? (mode === "metrics" ? "fake-session" : undefined),
    logStream: null, running, capturedSessions: new Map(), emit: event => { events.push(event); if (event.type === "done") captureOrder.push("done"); }, metrics,
    agentCommand: { bin: "fake", args: [], env: {} }, restartAgent: async () => { throw new Error("unexpected restart"); }
  });
  let deadline;
  try {
    await Promise.race([turn, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("ACP turn did not return to scheduler")), 1000);
    })]);
  } finally { clearTimeout(deadline); }
  await new Promise(resolve => setTimeout(resolve, 30));
  return { events, requests, traces, running, killCount, metricSnapshots, warmConnection, parked, child, captureOrder };
}

test("Pi display-only terminal metadata reaches live output and exit events", async t => {
  const result = await runScenario(t, "pi-terminal-metadata");
  assert.equal(result.events.find(event => event.type === "done").exitCode, 0);
  const terminal = result.events.filter(event => event.type === "terminal-update");
  assert.equal(terminal.length, 3);
  assert.equal(terminal.at(-1).output, "first line\nlast line\n");
  assert.equal(terminal.at(-1).exitCode, 0);
  assert.equal(terminal.at(-1).running, false);
  const call = result.events.flatMap(event => event.type === "items" ? event.items : []).find(item => item.kind === "tool-call");
  assert.equal(call.tool, "git status --short");
  assert.equal(call.input, undefined);
  assert.equal(result.requests.includes("terminal/create"), false);
});

test("modern Pi status uses diagnostics while completion follows ACP without native inference", async t => {
  const result = await runScenario(t, "pi-v1-success");
  assert.equal(result.events.find(e => e.type === "done").exitCode, 0);
  assert.equal(result.metricSnapshots.at(-1).status, "done");
  const diagnostics = result.events.filter(e => e.type === "stderr").map(e => e.content).join("");
  assert.match(diagnostics, /retrying in 2s/);
  assert.match(diagnostics, /Context compaction completed/);
  assert.doesNotMatch(diagnostics, /stale native failure/);
  const texts = result.events.flatMap(e => e.type === "items" ? e.items : []).filter(i => i.kind === "text");
  assert.deepEqual(texts.map(i => i.content), ["Retrying (attempt 1/3, waiting 2s)..."]);
});

for (const mode of ["pi-v1-error", "pi-v1-limit", "limit-requests"]) {
  test(`ACP incomplete outcomes propagate to failed metrics (${mode})`, async t => {
    const result = await runScenario(t, mode);
    assert.notEqual(result.events.find(e => e.type === "done").exitCode, 0);
    assert.equal(result.metricSnapshots.at(-1).status, "failed");
    assert.match(result.events.find(e => e.type === "error").message,
      mode === "pi-v1-error" ? /thinking but no answer/ : /limit.*did not complete/);
  });
}

test("modern Pi cancelled outcome remains cancelled", async t => {
  const result = await runScenario(t, "pi-v1-cancel");
  assert.equal(result.metricSnapshots.at(-1).status, "cancelled");
  assert.deepEqual(result.events.filter(e => e.type === "error"), []);
});

for (const mode of ["pi-thinking-only", "pi-thinking-after-tool", "pi-retry-exhausted", "pi-length", "pi-malformed", "pi-no-native-thinking", "pi-outstanding-tool"]) {
  test(`${mode} ends as failed even when the bridge returns end_turn`, async t => {
    const result = await runScenario(t, mode);
    assert.equal(result.events.filter(e => e.type === "done").length, 1);
    assert.notEqual(result.events.find(e => e.type === "done").exitCode, 0);
    assert.equal(result.metricSnapshots.at(-1).status, "failed");
    assert.equal(result.events.some(e => e.type === "error"), true);
    if (mode === "pi-retry-exhausted") assert.match(result.events.find(e => e.type === "error").message, /429 free_campaign_global_limit/);
  });
}

test("Pi retry notices use diagnostics and a recovered reply still succeeds", async t => {
  const result = await runScenario(t, "pi-retry-recovered");
  assert.equal(result.events.find(e => e.type === "done").exitCode, 0);
  assert.equal(result.metricSnapshots.at(-1).status, "done");
  const text = result.events.flatMap(e => e.type === "items" ? e.items : []).filter(i => i.kind === "text");
  assert.equal(text.some(i => /Retrying|Retry finished/.test(i.content)), false);
  assert.equal(text.some(i => i.content === "new Pi body"), true);
  assert.equal(result.events.some(e => e.type === "stderr" && /429 free_campaign_global_limit/.test(e.content)), true);
});

test("user cancellation of Pi thinking remains cancelled without an incomplete-answer error", async t => {
  const result = await runScenario(t, "pi-cancel-thinking");
  assert.equal(result.metricSnapshots.at(-1).status, "cancelled");
  assert.deepEqual(result.events.filter(e => e.type === "error"), []);
});

for (const mode of ["complete", "cancel", "yield-silent", "warm", "failed"]) {
  test(`file versions seal before done and scheduler return (${mode})`, async t => {
    const result = await runScenario(t, mode, "codex-acp", undefined, {});
    assert.deepEqual(result.captureOrder, ["prepare", "prepared", "prompt", "finalize", "sealed", "done"]);
    assert.equal(result.events.filter(event => event.type === "done").length, 1);
  });
}
test("baseline failure degrades capture without failing an ACP turn", async t => {
  const result = await runScenario(t, "complete", "codex-acp", undefined, { failPrepare: true });
  assert.deepEqual(result.captureOrder, ["prepare", "prepared", "prompt", "done"]);
  assert.equal(result.events.some(event => event.type === "error"), false);
});

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
  assert.equal(final.firstOutputLatencyMs, 300);
  assert.equal(final.firstOutputKind, "thinking");
  assert.equal(final.elapsedMs, 1_400);
  assert.equal(final.inputTokens, 0);
  assert.equal(final.outputTokens, 40);
  assert.equal(final.speedSource, "observed");
  assert.equal(final.tokensPerSecond, 40 * 1000 / 700);
  assert.equal(result.events.some(event => event.type === "items" && event.items.some(item => item.content === "historical reply")), false);
});

for (const mode of ["first-tool", "first-tool-plan"]) {
  test(`${mode} ends first-output waiting before tool execution, including requests rendered as plans`, async t => {
    const result = await runScenario(t, mode, "agy-acp");
    const final = result.metricSnapshots.at(-1);
    assert.equal(final.firstOutputLatencyMs, 300);
    assert.equal(final.firstOutputKind, "tool-call");
    assert.equal(final.firstTextLatencyMs, 11_500);
    assert.equal(final.status, "done");
  });
}

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

test("cancelled prompt results skip metadata and session-close RPCs", async t => {
  const result = await runScenario(t, "cancel-result");
  assert.deepEqual(result.requests, ["initialize", "session/new", "session/prompt"]);
  assert.equal(result.events.filter(event => event.type === "done").length, 1);
  assert.equal(result.metricSnapshots.at(-1).status, "cancelled");
});

for (const mode of ["stdin-initialize-error", "stdin-prompt-error", "stdin-cancel-error", "yield-stdin-error",
  "stdin-sync-error", "stdin-stream-error", "stdin-permission-error", "stdin-terminal-error", "stdin-unsupported-error", "stdin-probe-error"]) {
  test(`ACP ${mode} handles stream errors and returns to the scheduler`, async t => {
    const result = await runScenario(t, mode);
    assert.equal(result.events.filter(event => event.type === "done").length, 1);
    assert.equal(result.running.size, 0);
    assert.equal(result.requests.includes("session/list"), mode === "stdin-probe-error");
    assert.equal(result.requests.includes("session/close"), false);
    if (mode === "yield-stdin-error") {
      assert.equal(result.events.some(event => event.type === "error"), false);
      assert.equal(result.metricSnapshots.at(-1).status, "yielded");
    } else {
      assert.ok(result.events.some(event => event.type === "error" && /EPIPE/.test(event.message)));
    }
    // An error can arrive after logical completion/detachment during teardown.
    assert.doesNotThrow(() => result.child.stdin.emit("error", new Error("late write EPIPE")));
    assert.equal(result.events.filter(event => event.type === "done").length, 1);
  });
}

test("broken stdin during metadata cleanup settles without waiting for the timeout", async t => {
  const result = await runScenario(t, "stdin-list-error");
  assert.equal(result.events.find(event => event.type === "done").exitCode, 0);
  assert.equal(result.events.some(event => event.type === "error"), false);
  assert.equal(result.requests.includes("session/close"), false);
  assert.equal(result.traces.some(entry => entry[1] === "cleanup request timed out"), false);
});


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
  assert.equal(first.metricSnapshots.at(-1).firstOutputLatencyMs, 500);
  assert.equal(second.metricSnapshots.at(-1).firstOutputLatencyMs, 900);
  assert.equal(second.metricSnapshots.at(-1).firstOutputKind, "text");
  assert.equal(second.child.listenerCount("close"), 0);
  assert.equal(second.child.stdout.listenerCount("data"), 0);
  assert.equal(second.child.stderr.listenerCount("data"), 0);
});


test("cancelled AGY turns are reaped instead of entering the warm pool", async t => {
  const result = await runScenario(t, "warm-cancel", "agy-acp");
  assert.equal(result.parked, false);
  assert.equal(result.child.stdin.writableEnded, true);
  assert.equal(result.metricSnapshots.at(-1).status, "cancelled");
  assert.equal(result.requests.includes("session/list"), false);
  assert.equal(result.requests.includes("session/close"), false);
});

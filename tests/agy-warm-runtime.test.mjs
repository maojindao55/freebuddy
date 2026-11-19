import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import ts from "typescript";
import * as acp from "../dist-electron/cli/acp.js";
import * as acpLocalDiff from "../dist-electron/cli/acpLocalDiff.js";
import * as acpEmbeddedTerminal from "../dist-electron/cli/acpEmbeddedTerminal.js";
import * as acpToolActivity from "../dist-electron/cli/acpToolActivity.js";
import * as backgroundExecution from "../dist-electron/cli/backgroundExecution.js";
import * as antigravity from "../dist-electron/shared/antigravity.js";
import * as antigravitySessions from "../dist-electron/cli/antigravitySessions.js";
import * as cliStream from "@freebuddy/cli-stream";
import { AcpProcessPool } from "../dist-electron/cli/acpProcessPool.js";
import { RunMetricsCollector } from "../dist-electron/cli/runMetricsCollector.js";
import { localDiffFixture } from "./fixtures/agy-local-diff.mjs";

const require = createRequire(import.meta.url);
function load(file, services) {
  const compiled = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, process, console, Buffer,
    setTimeout: services.setTimeout ?? setTimeout, clearTimeout: services.clearTimeout ?? clearTimeout,
    require: name => {
      if (name === "node:fs" && services.fs) return services.fs;
      if (name.startsWith("node:")) return require(name);
      if (name === "./acp.js") return acp;
      if (name === "./acpLocalDiff.js") return acpLocalDiff;
      if (name === "./acpEmbeddedTerminal.js") return acpEmbeddedTerminal;
      if (name === "./acpToolActivity.js") return acpToolActivity;
      if (name === "./backgroundExecution.js") return backgroundExecution;
      if (name === "../shared/antigravity.js") return antigravity;
      if (name === "./antigravitySessions.js") return antigravitySessions;
      if (name === "./acpIdleMonitor.js" && services.acpIdleMonitor) return services.acpIdleMonitor;
      if (name === "@freebuddy/cli-stream") return cliStream;
      if (name === "cross-spawn") return { __esModule: true, default: services.spawn };
      return new Proxy(services, { get: (object, key) => key === "__esModule" ? true : object[key] ?? (() => {}) });
    }
  });
  return exports;
}

for (const native of [false, true]) test(`FreeBuddy cliRun reuses ${native ? "native" : "bridge"} AGY, preserves MCP routing and rebuilds changed config`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-warm-runtime-"));
  const pool = new AcpProcessPool();
  const logCompletions = [];
  t.after(async () => {
    pool.dispose();
    await Promise.all(logCompletions);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const children = [], events = [], requests = [], captures = [], browser = new Map(), spawnOptions = [];
  const fullText = "# 中文🙂\n".repeat(100000);
  const fixture = localDiffFixture(t, [{ type: "diff", path: "task.md", newText: fullText }]);
  let persistedText;
  let saved, owner = "owner", registrations = 0, rebindings = 0;
  const noop = () => {};
  const services = {
    fs: { ...fs, createWriteStream: (...args) => {
      const stream = fs.createWriteStream(...args);
      logCompletions.push(finished(stream));
      return stream;
    } },
    acpProcessPool: pool, RunMetricsCollector,
    getLogDir: () => root, getDataDir: () => root,
    getCallerUserId: () => owner, getLanguage: () => "en-US",
    getAdapterDefinition: () => ({ capabilities: { toolSession: true } }),
    buildCommand: () => ({ bin: "fake-agy", args: [], protocol: "acp" }),
    resolveCliByokEnv: () => ({}), sanitizeCliAgentEnv: env => env,
    applyManagedNodeEnvironment: env => env,
    getToolSession: () => saved,
    saveToolSession: (_agent, _scope, adapter, sessionId) => { saved = { adapter, sessionId }; },
    prepareTurnFileCapture: async input => {
      captures.push(["prepare", input.taskId]);
      return { taskId: input.taskId };
    },
    finalizeTurnFileCapture: async capture => { captures.push(["seal", capture.taskId]); },
    persistFileEditItems: (_session, items) => items.map(item => item.kind === "tool-call" ? {
      ...item, toolOutputs: item.toolOutputs?.map(output => {
        if (output.kind !== "file-edit") return output;
        // Storage receives the full body while the artifact still exists.
        if (!native) assert.ok(fs.existsSync(fixture.filename));
        persistedText = output.newText;
        return { kind: output.kind, path: output.path, action: output.action, blobKey: "saved-diff" };
      })
    } : item),
    logMain: () => ({ info: noop, warn: noop, error: noop }),
    safeSendToWebContents: (_contents, _channel, event) => events.push(event),
    adapterAcceptsClientMcpServers: () => true,
    getConversation: () => ({ kind: "chat" }),
    getConversationMcpServerIds: () => [],
    createAcpTerminalManager: () => ({ dispose: noop }),
    registerBrowserToolSession: async input => {
      const server = { name: "browser", command: "mock", args: [], env: [{ name: "token", value: `cap-${++registrations}` }] };
      browser.set(input.taskSessionId, server); return server;
    },
    rebindBrowserToolSession: (previous, input) => {
      const server = browser.get(previous); if (!server) return false;
      browser.delete(previous); browser.set(input.taskSessionId, server); rebindings++; return true;
    },
    unregisterBrowserToolSession: task => browser.delete(task),
    killProcessTree: child => child.kill(),
    spawn: (_bin, _args, options) => {
      spawnOptions.push(options);
      const child = new EventEmitter();
      Object.assign(child, { pid: 1000 + children.length, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      let turn = 0;
      const reply = (request, result) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString()); requests.push({ pid: child.pid, ...request }); callback();
        queueMicrotask(() => {
          if (request.method === "initialize") reply(request, { protocolVersion: 1,
            ...(native ? { agentInfo: { name: "Antigravity ACP Server", version: "1.5.9" } }
              : { _meta: { freebuddy: { persistentSession: true } } }),
            agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } });
          else if (["session/new", "session/load"].includes(request.method)) reply(request, { sessionId: `native-${child.pid}` });
          else if (request.method === "session/set_config_option") reply(request, {});
          else if (request.method === "session/prompt") {
            turn++;
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
              sessionId: `native-${child.pid}`, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new reply" } }
            } }) + "\n");
            if (children.length === 1 && turn === 1) {
              child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
                sessionId: `native-${child.pid}`, update: native
                  ? { sessionUpdate: "tool_call_update", toolCallId: "native-edit", status: "completed",
                      content: [{ type: "diff", path: "task.md", oldText: "", newText: fullText }] }
                  : fixture.update
              } }) + "\n");
            }
            reply(request, { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: turn * 10, thoughtTokens: 2 },
              _meta: { metrics: { usageScope: "turn", modelCallDurationMs: 1000 } } });
          } else if (request.method === "session/list") reply(request, { sessions: [] });
          else reply(request, {});
        });
      } });
      child.kill = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 0; child.signalCode = "SIGTERM";
        child.stdin.destroy(); child.stdout.end(); child.stderr.end(); child.emit("close", 0);
      };
      children.push(child); queueMicrotask(() => child.emit("spawn")); return child;
    },
  };
  services.runAcpAgent = load("../electron/cli/acpRuntime.ts", services).runAcpAgent;
  const runtime = load("../electron/cli/runtime.ts", services);
  const wc = { id: 1 };
  const args = { adapter: "agy-acp", binary: native ? "agy" : "agy-acp", agentId: "agent", agentName: "AGY", conversationId: "chat", cwd: root, prompt: "hello", configOptionOverrides: { effort: "medium" } };
  await runtime.cliRun(wc, { ...args, sessionId: "one" });
  assert.equal(persistedText, fullText);
  if (!native) assert.equal(fs.existsSync(fixture.filename), false);
  const editEvent = events.find(event => event.items?.some(item => item.toolOutputs?.some(output => output.blobKey === "saved-diff")));
  assert.ok(editEvent);
  assert.ok(JSON.stringify(editEvent).length < 4096);
  await runtime.cliRun(wc, { ...args, sessionId: "two" });
  const controls = requests.filter(request => request.method === "session/set_config_option");
  assert.deepEqual(controls.map(request => [request.params.configId, request.params.value]),
    Array.from({ length: 2 }, () => [native ? "thought_level" : "effort", "medium"]));
  assert.equal(spawnOptions[0].env.GCM_INTERACTIVE, "0");
  assert.equal(spawnOptions[0].env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(children[0].stdin.listenerCount("error"), 1);
  assert.equal(children.length, 1);
  assert.equal(registrations, 1); assert.equal(rebindings, 1);
  assert.equal(requests.filter(r => r.method === "initialize").length, 1);
  assert.equal(requests.filter(r => r.method === "session/close").length, 0);
  const mcp1 = requests.find(r => r.method === "session/new").params.mcpServers;
  const loadRequests = requests.filter(r => r.method === "session/load");
  if (native) {
    assert.equal(loadRequests.length, 0);
  } else {
    assert.equal(loadRequests.length, 1);
    assert.deepEqual(loadRequests[0].params.mcpServers, mcp1);
  }
  const summaries = events.flatMap(e => e.items ?? []).filter(i => i.runMetrics?.status === "done").map(i => i.runMetrics);
  assert.deepEqual(summaries.map(m => m.outputTokens), [10, 20]);
  assert.deepEqual(summaries.map(m => m.tokensPerSecond), [10, 20]);
  await runtime.cliRun(wc, { ...args, sessionId: "config", env: { AGY_TEST_CONFIG: "changed" } });
  assert.equal(children.length, 2); assert.equal(children[0].exitCode, 0);
  owner = "different-owner";
  await runtime.cliRun(wc, { ...args, sessionId: "owner" });
  assert.equal(children.length, 3);
  await runtime.shutdownCliProcesses();
  assert.deepEqual(captures, ["one", "two", "config", "owner"].flatMap(id => [["prepare", id], ["seal", id]]));
  assert.ok(children.every(child => child.exitCode === 0));
  assert.ok(spawnOptions.every(options => options.windowsHide === (process.platform === "win32")));
  assert.equal(browser.size, 0);
});

test("native AGY warm reuse skips session/load after pending ask_question and fails without parking or auth prompt on empty end_turn", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-agy-empty-turn-"));
  const pool = new AcpProcessPool();
  const logCompletions = [];
  t.after(async () => {
    pool.dispose();
    await Promise.all(logCompletions);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const children = [], events = [], requests = [];
  let saved, turnMode = "ask_question";
  const noop = () => {};
  const services = {
    fs: { ...fs, createWriteStream: (...args) => {
      const stream = fs.createWriteStream(...args);
      logCompletions.push(finished(stream));
      return stream;
    } },
    acpProcessPool: pool, RunMetricsCollector,
    getLogDir: () => root, getDataDir: () => root,
    getCallerUserId: () => "owner", getLanguage: () => "zh-CN",
    getAdapterDefinition: () => ({ capabilities: { toolSession: true } }),
    buildCommand: () => ({ bin: "fake-agy", args: ["acp"], protocol: "acp" }),
    resolveCliByokEnv: () => ({}), sanitizeCliAgentEnv: env => env,
    applyManagedNodeEnvironment: env => env,
    getToolSession: () => saved,
    saveToolSession: (_agent, _scope, adapter, sessionId) => { saved = { adapter, sessionId }; },
    prepareTurnFileCapture: async input => ({ taskId: input.taskId }),
    finalizeTurnFileCapture: async () => {},
    persistFileEditItems: (_session, items) => items,
    logMain: () => ({ info: noop, warn: noop, error: noop }),
    safeSendToWebContents: (_contents, _channel, event) => events.push(event),
    adapterAcceptsClientMcpServers: () => true,
    getConversation: () => ({ kind: "chat" }),
    getConversationMcpServerIds: () => [],
    createAcpTerminalManager: () => ({ dispose: noop }),
    registerBrowserToolSession: async () => ({ name: "browser", command: "mock", args: [] }),
    rebindBrowserToolSession: () => true,
    unregisterBrowserToolSession: noop,
    killProcessTree: child => child.kill(),
    spawn: () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 2000 + children.length, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      const reply = (request, result) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString());
        requests.push({ pid: child.pid, ...request });
        callback();
        queueMicrotask(() => {
          if (request.method === "initialize") {
            reply(request, {
              protocolVersion: 1,
              agentInfo: { name: "Antigravity ACP Server", version: "1.5.9" },
              agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } },
              authMethods: [
                { id: "oauth-personal", name: "Log in with Google" },
                { id: "terminal-login", name: "Log in from the terminal", type: "terminal", args: ["--login"] }
              ]
            });
          } else if (request.method === "session/new" || request.method === "session/load") {
            reply(request, { sessionId: "agy-session-1" });
          } else if (request.method === "session/prompt") {
            if (turnMode === "ask_question") {
              child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
                sessionId: "agy-session-1",
                update: { sessionUpdate: "tool_call", toolCallId: "ask-1", name: "ask_question", status: "in_progress" }
              } }) + "\n");
              child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
                sessionId: "agy-session-1",
                update: { sessionUpdate: "tool_call_update", toolCallId: "ask-1", name: "ask_question", status: "pending" }
              } }) + "\n");
              child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
                sessionId: "agy-session-1",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Choose 1 or 2" } }
              } }) + "\n");
            } else if (turnMode === "answer_ok") {
              child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
                sessionId: "agy-session-1",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Completed after ask_question" } }
              } }) + "\n");
            }
            reply(request, { stopReason: "end_turn" });
          } else if (request.method === "session/list") {
            reply(request, { sessions: [] });
          } else {
            reply(request, {});
          }
        });
      } });
      child.kill = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 0; child.signalCode = "SIGTERM";
        child.stdin.destroy(); child.stdout.end(); child.stderr.end(); child.emit("close", 0);
      };
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }
  };

  services.runAcpAgent = load("../electron/cli/acpRuntime.ts", services).runAcpAgent;
  const runtime = load("../electron/cli/runtime.ts", services);
  const wc = { id: 1 };
  const baseArgs = { adapter: "agy-acp", binary: "agy", agentId: "agent", agentName: "AGY", conversationId: "chat-ask", cwd: root, prompt: "switch branch" };

  // Turn 1 leaves ask_question pending at end_turn and stays warm.
  await runtime.cliRun(wc, { ...baseArgs, sessionId: "t1" });
  assert.equal(children.length, 1);

  // Turn 2 reuses the warm connection without sending session/load, so ask_question can resolve cleanly.
  turnMode = "answer_ok";
  await runtime.cliRun(wc, { ...baseArgs, sessionId: "t2", prompt: "1" });
  assert.equal(children.length, 1);
  assert.equal(requests.filter(r => r.method === "session/load").length, 0);

  // Turn 3 simulates another pending ask_question followed by Turn 4 returning empty end_turn.
  turnMode = "ask_question";
  await runtime.cliRun(wc, { ...baseArgs, sessionId: "t3", prompt: "ask again" });
  turnMode = "empty_end_turn";
  await runtime.cliRun(wc, { ...baseArgs, sessionId: "t4", prompt: "reply" });

  // Turn 4 must fail visibly (not trigger auth or silent exitCode=0) and evict the warm process.
  const t4Events = events.slice(events.findLastIndex(e => e.type === "started"));
  assert.equal(t4Events.some(e => e.type === "authentication"), false);
  const errEvent = t4Events.find(e => e.type === "error");
  assert.ok(errEvent);
  assert.match(errEvent.message, /ask_question/);
  assert.match(errEvent.message, /agy --conversation agy-session-1/);
  assert.equal(t4Events.find(e => e.type === "done").exitCode, -1);
  assert.equal(children[0].exitCode, 0);

  // Turn 5 must spawn a new process (and do a fresh session/load) rather than reusing the evicted one.
  turnMode = "answer_ok";
  await runtime.cliRun(wc, { ...baseArgs, sessionId: "t5", prompt: "retry" });
  assert.equal(children.length, 2);
  assert.equal(requests.filter(r => r.pid === children[1].pid && r.method === "session/load").length, 1);
  await runtime.shutdownCliProcesses();
});

test("native AGY warm idle monitor captures post-end_turn background updates and permissions", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-agy-idle-monitor-"));
  const pool = new AcpProcessPool();
  const logCompletions = [];
  t.after(async () => {
    pool.dispose();
    await Promise.all(logCompletions);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const children = [], requests = [], appended = [], updated = [], ipcMessages = [], resolvers = new Map();
  let saved, ownerRecorded = null, currentChild;
  const noop = () => {};
  const services = {
    fs: { ...fs, createWriteStream: (...args) => {
      const stream = fs.createWriteStream(...args);
      logCompletions.push(finished(stream));
      return stream;
    } },
    acpProcessPool: pool, RunMetricsCollector,
    getLogDir: () => root, getDataDir: () => root,
    getCallerUserId: () => "owner", getLanguage: () => "zh-CN",
    getAdapterDefinition: () => ({ capabilities: { toolSession: true } }),
    buildCommand: () => ({ bin: "fake-agy", args: ["acp"], protocol: "acp" }),
    resolveCliByokEnv: () => ({}), sanitizeCliAgentEnv: env => env,
    applyManagedNodeEnvironment: env => env,
    getToolSession: () => saved,
    saveToolSession: (_agent, _scope, adapter, sessionId) => { saved = { adapter, sessionId }; },
    prepareTurnFileCapture: async input => ({ taskId: input.taskId }),
    finalizeTurnFileCapture: async () => {},
    persistFileEditItems: (_ctx, items) => items,
    appendMessage: input => { appended.push(input); return input; },
    updateMessage: input => { updated.push(input); },
    safeSendToWebContents: (_contents, channel, payload) => { ipcMessages.push({ channel, payload }); },
    registerPermissionResolver: (sessionId, requestId, fn) => { resolvers.set(`${sessionId}:${requestId}`, fn); },
    takePermissionResolver: (sessionId, requestId) => {
      const key = `${sessionId}:${requestId}`;
      const fn = resolvers.get(key);
      resolvers.delete(key);
      return fn;
    },
    clearPermissionResolversForSession: sessionId => {
      for (const k of resolvers.keys()) if (k.startsWith(`${sessionId}:`)) resolvers.delete(k);
    },
    recordSessionOwner: (sessionId, userId) => { ownerRecorded = { sessionId, userId }; },
    clearSessionOwner: noop,
    logMain: () => ({ info: noop, warn: noop, error: noop }),
    adapterAcceptsClientMcpServers: () => true,
    getConversation: () => ({ kind: "chat" }),
    getConversationMcpServerIds: () => [],
    createAcpTerminalManager: () => ({ dispose: noop }),
    registerBrowserToolSession: async () => ({ name: "browser", command: "mock", args: [] }),
    rebindBrowserToolSession: () => true,
    unregisterBrowserToolSession: noop,
    killProcessTree: child => child.kill(),
    spawn: () => {
      const child = new EventEmitter();
      currentChild = child;
      Object.assign(child, { pid: 3000 + children.length, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      const reply = (request, result) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString());
        requests.push(message);
        callback();
        if (!message.method) return;
        queueMicrotask(() => {
          if (message.method === "initialize") {
            reply(message, {
              protocolVersion: 1,
              agentInfo: { name: "Antigravity ACP Server", version: "1.5.10" },
              agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }
            });
          } else if (message.method === "session/new" || message.method === "session/load") {
            reply(message, { sessionId: "agy-1510-session" });
          } else if (message.method === "session/prompt") {
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
              sessionId: "agy-1510-session",
              update: { sessionUpdate: "tool_call", toolCallId: "bg-1", name: "run_command", status: "in_progress", title: "sleep 12" }
            } }) + "\n");
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
              sessionId: "agy-1510-session",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STARTED" } }
            } }) + "\n");
            reply(message, { stopReason: "end_turn" });
          } else if (message.method === "session/list") {
            reply(message, { sessions: [] });
          } else {
            reply(message, {});
          }
        });
      } });
      child.kill = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 0; child.signalCode = "SIGTERM";
        child.stdin.destroy(); child.stdout.end(); child.stderr.end(); child.emit("close", 0);
      };
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }
  };

  services.acpIdleMonitor = load("../electron/cli/acpIdleMonitor.ts", services);
  services.runAcpAgent = load("../electron/cli/acpRuntime.ts", services).runAcpAgent;
  const runtime = load("../electron/cli/runtime.ts", services);
  const wc = { id: 1, isDestroyed: () => false };
  const baseArgs = { adapter: "agy-acp", binary: "agy", agentId: "agent", agentName: "AGY", conversationId: "chat-1510", cwd: root, prompt: "run long command", approvalMode: "ask" };

  // Turn 1 ends while bg-1 is still running; connection parks with idle monitor attached.
  await runtime.cliRun(wc, { ...baseArgs, sessionId: "run-1" });
  assert.equal(appended.length, 0);

  // While parked idle, agy 1.5.10 emits background tool completion, permission request, and wake-up reply.
  currentChild.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "agy-1510-session",
    update: { sessionUpdate: "tool_call_update", toolCallId: "bg-1", name: "run_command", status: "completed", rawOutput: { output: "BG_DONE\n", exit_code: 0 } }
  } }) + "\n");
  currentChild.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "idle-perm-1", method: "session/request_permission", params: {
    sessionId: "agy-1510-session",
    toolCall: { toolCallId: "bg-2", title: "echo second", kind: "execute" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }]
  } }) + "\n");
  await new Promise(resolve => setTimeout(resolve, 25));

  const permEnqueue = ipcMessages.find(m => m.channel === "freebuddy://acp-permission" && m.payload.action === "enqueue");
  assert.ok(permEnqueue);
  assert.ok(ownerRecorded?.sessionId.startsWith("acp-idle-"));
  const resolver = services.takePermissionResolver(permEnqueue.payload.request.sessionId, permEnqueue.payload.request.requestId);
  assert.ok(resolver);
  resolver({ outcome: "selected", optionId: "allow" });
  assert.ok(requests.some(r => r.id === "idle-perm-1" && r.result?.outcome?.optionId === "allow"));

  currentChild.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "agy-1510-session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FINISHED" } }
  } }) + "\n");
  currentChild.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "agy-1510-session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ":BG_DONE" } }
  } }) + "\n");

  // Starting Turn 2 immediately calls stopIdle(), flushing buffered wake-up items synchronously before reusing the process.
  await runtime.cliRun(wc, { ...baseArgs, sessionId: "run-2", prompt: "next" });
  assert.equal(children.length, 1);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].status, "running");
  assert.ok(appended[0].taskId.startsWith("acp-idle-"));
  assert.equal(updated.at(-1).status, "done");
  const finalContent = JSON.parse((updated.at(-1) ?? appended[0]).content);
  assert.equal(finalContent.find(i => i.kind === "tool-call" && i.id === "bg-1").status, "completed");
  assert.equal(finalContent.find(i => i.kind === "text").content, "FINISHED:BG_DONE");

  // A second passive wake-up is cancellable through the normal CLI control
  // path, even though its original session/prompt has already returned.
  currentChild.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "agy-1510-session",
    update: { sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" }
  } }) + "\n");
  assert.equal(appended.at(-1).status, "running");
  assert.equal(runtime.cliKill(appended.at(-1).taskId), true);
  assert.equal(updated.at(-1).status, "killed");
  assert.equal(currentChild.exitCode, 0);

  await runtime.shutdownCliProcesses();
});

function idleMonitorFixture(t, approvalMode = "ask") {
  let now = 0, timerId = 0;
  const timers = new Map(), rows = new Map(), resolvers = new Map(), owners = new Map();
  const running = new Map(), ipc = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4321, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
  });
  const services = {
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: id => timers.delete(id),
    appendMessage: row => rows.set(row.id, { ...row }),
    updateMessage: patch => Object.assign(rows.get(patch.id), patch),
    persistFileEditItems: (_ctx, items) => items,
    recordSessionOwner: (id, owner) => owners.set(id, owner),
    clearSessionOwner: id => owners.delete(id),
    registerPermissionResolver: (_session, id, fn) => resolvers.set(id, fn),
    takePermissionResolver: (_session, id) => { const fn = resolvers.get(id); resolvers.delete(id); return fn; },
    clearPermissionResolversForSession: () => resolvers.clear(),
    safeSendToWebContents: (_wc, channel, payload) => ipc.push({ channel, payload }),
    logMain: () => ({ warn() {} })
  };
  const { createAcpIdleMonitor } = load("../electron/cli/acpIdleMonitor.ts", services);
  const monitor = createAcpIdleMonitor({
    child, running, conversationId: "chat", acpSessionId: "native",
    agentId: "agy", agentName: "AGY", adapter: "agy-acp", binary: "agy", approvalMode,
    ownerUserId: "alice", webContents: { isDestroyed: () => false }
  });
  monitor.startIdle();
  t.after(() => monitor.stopIdle());
  const send = msg => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const update = (value, sessionId = "native") => send({ method: "session/update", params: { sessionId, update: value } });
  const tool = (id, status) => update({ sessionUpdate: "tool_call_update", toolCallId: id, title: "Run command", status });
  const text = value => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = end;
  };
  return { monitor, rows, running, owners, resolvers, ipc, services, update, send, tool, text, advance };
}

test("passive tool gaps keep one running reply until the assistant responds", t => {
  const f = idleMonitorFixture(t);
  f.update({ sessionUpdate: "usage_update", used: 10, size: 100 });
  f.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreign" } }, "other-session");
  assert.equal(f.rows.size, 0);
  f.tool("timer", "completed");
  const row = [...f.rows.values()][0];
  assert.equal(row.status, "running");
  assert.ok(row.taskId.startsWith("acp-idle-"));
  assert.equal(f.owners.get(row.taskId), "alice");
  assert.equal(f.running.get(row.taskId).child.pid, 4321);
  // Reproduce the shared conversation: multiple tools separated by slow
  // model inference, with no new session/prompt RPC to own the wake-up.
  f.advance(15000);
  f.tool("check-ci", "in_progress");
  f.advance(15000);
  f.tool("check-ci", "completed");
  f.advance(15000);
  assert.equal(row.status, "running");
  assert.equal(f.rows.size, 1);
  f.text("All checks finished.");
  f.advance(120);
  assert.equal(row.status, "running");
  f.advance(2000);
  assert.equal(row.status, "done");
  assert.equal(f.running.size, 0);
  assert.equal(f.owners.size, 0);
  assert.equal(JSON.parse(row.content).filter(i => i.kind === "tool-call").length, 2);
  f.tool("next-timer", "completed");
  assert.equal(f.rows.size, 2);
});

test("passive thinking, active tools and permissions prevent premature completion", t => {
  const f = idleMonitorFixture(t);
  f.text("Checking the build.");
  f.advance(1000);
  f.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "working" } });
  f.advance(15000);
  const row = [...f.rows.values()][0];
  assert.equal(row.status, "running");
  f.tool("build", "in_progress");
  f.text("Build still running.");
  f.advance(15000);
  assert.equal(row.status, "running");
  f.tool("build", "completed");
  f.send({ id: "permission-rpc", method: "session/request_permission", params: {
    sessionId: "native", options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }]
  } });
  f.text("Waiting for approval.");
  f.advance(15000);
  assert.equal(row.status, "running");
  assert.equal(f.resolvers.size, 1);
  const [requestId] = f.resolvers.keys();
  f.services.takePermissionResolver(row.taskId, requestId)({ outcome: "selected", optionId: "allow" });
  f.advance(15000);
  assert.equal(row.status, "running");
  f.text("Approved work finished.");
  f.advance(2000);
  assert.equal(row.status, "done");
  assert.equal(f.resolvers.size, 0);
});

for (const status of ["failed", "killed"]) test(`passive ${status} teardown seals the reply and releases controls`, t => {
  const f = idleMonitorFixture(t);
  f.tool("pending", "in_progress");
  const row = [...f.rows.values()][0];
  if (status === "killed") f.running.get(row.taskId).cancel();
  else f.monitor.stopIdle(status);
  assert.equal(row.status, status);
  f.advance(60000);
  assert.equal(row.status, status);
  assert.equal(f.running.size, 0);
  assert.equal(f.owners.size, 0);
});

test("terminal errors from passive replies stay failed", t => {
  const f = idleMonitorFixture(t);
  f.text("\n⚠ FAILED_PRECONDITION (code 400): User location is not supported for the API use.\n");
  const row = [...f.rows.values()][0];
  assert.equal(row.status, "failed");
  f.advance(60000);
  assert.equal(row.status, "failed");
  assert.equal(f.running.size, 0);
});

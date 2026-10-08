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
import { AcpProcessPool } from "../dist-electron/cli/acpProcessPool.js";
import { RunMetricsCollector } from "../dist-electron/cli/runMetricsCollector.js";
import { localDiffFixture } from "./fixtures/agy-local-diff.mjs";

const require = createRequire(import.meta.url);
function load(file, services) {
  const compiled = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, process, console, Buffer, setTimeout, clearTimeout,
    require: name => {
      if (name.startsWith("node:")) return require(name);
      if (name === "./acp.js") return acp;
      if (name === "./acpLocalDiff.js") return acpLocalDiff;
      if (name === "cross-spawn") return { __esModule: true, default: services.spawn };
      return new Proxy(services, { get: (object, key) => key === "__esModule" ? true : object[key] ?? (() => {}) });
    }
  });
  return exports;
}

test("FreeBuddy cliRun reuses AGY through actual ACP lifecycle, preserves MCP routing and rebuilds changed config", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-warm-runtime-"));
  const pool = new AcpProcessPool();
  t.after(() => { pool.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const children = [], events = [], requests = [], browser = new Map();
  const fullText = "# 中文🙂\n".repeat(100000);
  const fixture = localDiffFixture(t, [{ type: "diff", path: "task.md", newText: fullText }]);
  let persistedText;
  let saved, owner = "owner", registrations = 0, rebindings = 0;
  const noop = () => {};
  const services = {
    acpProcessPool: pool, RunMetricsCollector,
    getLogDir: () => root, getDataDir: () => root,
    getCallerUserId: () => owner, getLanguage: () => "en-US",
    getAdapterDefinition: () => ({ capabilities: { toolSession: true } }),
    buildCommand: () => ({ bin: "fake-agy", args: [], protocol: "acp" }),
    resolveCliByokEnv: () => ({}), sanitizeCliAgentEnv: env => env,
    getToolSession: () => saved,
    saveToolSession: (_agent, _scope, adapter, sessionId) => { saved = { adapter, sessionId }; },
    persistFileEditItems: (_session, items) => items.map(item => item.kind === "tool-call" ? {
      ...item, toolOutputs: item.toolOutputs?.map(output => {
        if (output.kind !== "file-edit") return output;
        // Storage receives the full body while the artifact still exists.
        assert.ok(fs.existsSync(fixture.filename));
        persistedText = output.newText;
        return { kind: output.kind, path: output.path, action: output.action, blobKey: "saved-diff" };
      })
    } : item),
    logMain: () => ({ info: noop, warn: noop, error: noop }),
    safeSendToWebContents: (_contents, _channel, event) => events.push(event),
    adapterAcceptsClientMcpServers: () => true,
    getConversation: () => ({ kind: "chat" }),
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
    spawn: () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 1000 + children.length, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      let turn = 0;
      const reply = (request, result) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString()); requests.push({ pid: child.pid, ...request }); callback();
        queueMicrotask(() => {
          if (request.method === "initialize") reply(request, { protocolVersion: 1,
            _meta: { freebuddy: { persistentSession: true } }, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } });
          else if (["session/new", "session/load"].includes(request.method)) reply(request, { sessionId: `native-${child.pid}` });
          else if (request.method === "session/prompt") {
            turn++;
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
              sessionId: `native-${child.pid}`, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new reply" } }
            } }) + "\n");
            if (children.length === 1 && turn === 1) {
              child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
                sessionId: `native-${child.pid}`, update: fixture.update
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
  const args = { adapter: "agy-acp", agentId: "agent", agentName: "AGY", conversationId: "chat", cwd: root, prompt: "hello" };
  await runtime.cliRun(wc, { ...args, sessionId: "one" });
  assert.equal(persistedText, fullText);
  assert.equal(fs.existsSync(fixture.filename), false);
  const editEvent = events.find(event => event.items?.some(item => item.toolOutputs?.some(output => output.blobKey === "saved-diff")));
  assert.ok(editEvent);
  assert.ok(JSON.stringify(editEvent).length < 4096);
  await runtime.cliRun(wc, { ...args, sessionId: "two" });
  assert.equal(children.length, 1);
  assert.equal(registrations, 1); assert.equal(rebindings, 1);
  assert.equal(requests.filter(r => r.method === "initialize").length, 1);
  assert.equal(requests.filter(r => r.method === "session/close").length, 0);
  const mcp1 = requests.find(r => r.method === "session/new").params.mcpServers;
  const mcp2 = requests.find(r => r.method === "session/load").params.mcpServers;
  assert.deepEqual(mcp2, mcp1);
  const summaries = events.flatMap(e => e.items ?? []).filter(i => i.runMetrics?.status === "done").map(i => i.runMetrics);
  assert.deepEqual(summaries.map(m => m.outputTokens), [10, 20]);
  assert.deepEqual(summaries.map(m => m.tokensPerSecond), [10, 20]);
  await runtime.cliRun(wc, { ...args, sessionId: "config", env: { AGY_TEST_CONFIG: "changed" } });
  assert.equal(children.length, 2); assert.equal(children[0].exitCode, 0);
  owner = "different-owner";
  await runtime.cliRun(wc, { ...args, sessionId: "owner" });
  assert.equal(children.length, 3);
  await runtime.shutdownCliProcesses();
  assert.ok(children.every(child => child.exitCode === 0));
  assert.equal(browser.size, 0);
});

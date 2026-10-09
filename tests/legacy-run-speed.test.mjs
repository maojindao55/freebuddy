import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createRequire } from "node:module";
import ts from "typescript";
import * as cliStream from "@freebuddy/cli-stream";
import { RunMetricsCollector } from "../dist-electron/cli/runMetricsCollector.js";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(fs.readFileSync(new URL("../electron/cli/legacyRuntime.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;

function fixture(mode, resumed = false) {
  let at = 0;
  const events = [];
  const metrics = new RunMetricsCollector("run", () => {}, () => at);
  const noop = () => {};
  const services = { ...cliStream, getAdapterDefinition: () => ({ streamMode: mode }) };
  const exports = {};
  vm.runInNewContext(source, {
    exports, process, console, Buffer, setTimeout, clearTimeout,
    require: name => name.startsWith("node:") ? require(name) : new Proxy(services, {
      get: (obj, key) => key === "__esModule" ? true : obj[key] ?? noop
    })
  });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  exports.runLegacyCliAgent({ child, args: { sessionId: "run", adapter: mode, prompt: "fixture" },
    built: {}, pid: 1, logStream: null, running: new Map(), capturedSessions: new Map(), metrics, resumed,
    emit: event => { events.push(event); if (event.type === "done") metrics.finish(); } });
  return {
    metrics, events,
    write: (time, data) => { at = time; child.stdout.write(JSON.stringify(data) + "\n"); },
    close: () => { at = 90_000; child.stdout.end(); child.stderr.end(); child.emit("close", 0); }
  };
}

test("actual legacy Codex host derives speed from deltas and completed-turn usage before process cleanup", () => {
  const f = fixture("codex-json");
  f.write(1_000, { type: "item.updated", item: { type: "agent_message" }, delta: "first" });
  f.write(1_500, { type: "item.updated", item: { type: "agent_message" }, delta: "second" });
  f.write(2_000, { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 50 } });
  f.close();
  assert.equal(f.metrics.snapshot().tokensPerSecond, 50);
  assert.equal(f.metrics.snapshot().speedSource, "observed");
  assert.equal(f.metrics.snapshot().generationDurationMs, 1_000);
});

test("actual legacy Claude host includes streamed tool arguments and excludes tool execution and result latency", () => {
  const f = fixture("claude-json");
  const stream = event => ({ type: "stream_event", event });
  f.write(500, stream({ type: "message_start", message: { id: "call" } }));
  f.write(2_000, stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } }));
  f.write(2_500, stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"fixture"}' } }));
  f.write(3_000, { type: "assistant", message: { id: "call", content: [{ type: "tool_use", id: "read", name: "read", input: { path: "fixture" } }] } });
  f.write(10_000, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "fixture contents" }] } });
  f.write(11_000, stream({ type: "message_start", message: { id: "answer" } }));
  f.write(12_000, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first" } }));
  f.write(13_000, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " second" } }));
  f.write(14_000, { type: "assistant", message: { id: "answer", content: [{ type: "text", text: "first second" }] } });
  f.write(15_000, { type: "result", usage: { input_tokens: 10, output_tokens: 120 } });
  f.close();
  assert.equal(f.metrics.snapshot().tokensPerSecond, 40);
  assert.equal(f.metrics.snapshot().generationDurationMs, 3_000);
  assert.equal(f.metrics.snapshot().firstTextLatencyMs, 12_000);
  assert.equal(f.metrics.snapshot().firstOutputLatencyMs, 2_000);
  assert.equal(f.metrics.snapshot().firstOutputKind, "tool-call");
  assert.equal(f.events.some(event => event.type === "stdout"), true);
});

test("legacy resumed output, buffered responses and unknown-scope counters never become measured tok/s", () => {
  const resumed = fixture("codex-json", true);
  resumed.write(1_000, { type: "agent_message_delta", delta: "replay" });
  resumed.write(1_500, { type: "agent_message_delta", delta: "replay" });
  resumed.write(2_000, { type: "turn.completed", usage: { output_tokens: 50 } });
  resumed.close();
  assert.equal(resumed.metrics.snapshot().tokensPerSecond, undefined);
  const buffered = fixture("claude-json");
  buffered.write(1_000, { type: "assistant", message: { content: [{ type: "text", text: "full response" }] } });
  buffered.write(2_000, { type: "result", usage: { output_tokens: 50 } });
  buffered.close();
  assert.equal(buffered.metrics.snapshot().tokensPerSecond, undefined);
  const unknown = fixture("codex-json");
  unknown.write(1_000, { type: "agent_message_delta", delta: "first" });
  unknown.write(1_500, { type: "agent_message_delta", delta: "second" });
  unknown.write(2_000, { type: "token_count", output_tokens: 99_999 });
  unknown.close();
  assert.equal(unknown.metrics.snapshot().tokensPerSecond, undefined);
});

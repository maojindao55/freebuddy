import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { PI_RUN_METRICS_EXTENSION_SOURCE, ensurePiRunMetricsExtension } from "../dist-electron/cli/piRunMetricsExtension.js";
import { PiRunUsageReader } from "../dist-electron/cli/piRunUsage.js";
import { RunMetricsCollector } from "../dist-electron/cli/runMetricsCollector.js";

function extension(append = () => {}) {
  let clock = 0;
  const hooks = new Map(), records = [];
  const context = { process: { hrtime: { bigint: () => BigInt(Math.round(clock * 1e6)) } } };
  vm.runInNewContext(PI_RUN_METRICS_EXTENSION_SOURCE.replace("export default", "globalThis.install ="), context);
  context.install({
    on: (name, handler) => hooks.set(name, handler),
    appendEntry: (customType, data) => {
      const entry = JSON.parse(JSON.stringify({ type: "custom", customType, data }));
      records.push(entry);
      append(entry);
    }
  });
  const message = { role: "assistant", usage: { output: 20 } };
  return {
    records,
    emit: (name, at, event = {}) => {
      clock = at;
      hooks.get(name)?.({ message, ...event });
    },
    delta: (type, at, delta = "private delta") => {
      clock = at;
      hooks.get("message_update")({ message, assistantMessageEvent: { type, delta } });
    }
  };
}

test("native measurement excludes first-packet wait, UI wait and tools; includes thinking and tool argument generation", () => {
  const e = extension();
  e.emit("message_start", 100);
  e.delta("text_start", 200);
  e.delta("text_delta", 250, "");
  e.delta("thinking_delta", 500);
  e.emit("ui_prompt_start", 600);
  e.emit("ui_prompt_end", 5_600);
  e.delta("toolcall_delta", 6_000);
  e.emit("message_end", 6_500);
  e.emit("message_end", 9_000); // A duplicate end cannot record another sample.
  assert.equal(e.records.length, 1);
  assert.deepEqual(e.records[0].data, { version: 1, outputTokens: 20, durationMs: 1_000 });
  assert.doesNotMatch(JSON.stringify(e.records), /private|delta|thinking|content/);
});

test("buffered, single-delta and sub-millisecond responses have no invented streaming speed", () => {
  for (const deltas of [0, 1, 2]) {
    const e = extension();
    e.emit("message_start", 0);
    for (let index = 0; index < deltas; index++) e.delta("text_delta", 10 + index * 0.1);
    e.emit("message_end", deltas === 2 ? 10.5 : 100);
    assert.equal(e.records[0].data.durationMs, undefined);
  }
});

test("invalid output counters remain unknown, and a broken recorder cannot interrupt a model response", () => {
  for (const output of [undefined, -1, NaN, Infinity, "12", 1.5]) {
    const e = extension();
    e.emit("message_start", 0);
    e.delta("text_delta", 10);
    e.delta("text_delta", 500);
    e.emit("message_end", 1_010, { message: { role: "assistant", usage: { output } } });
    assert.equal(e.records[0].data.outputTokens, undefined);
  }
  const e = extension(() => { throw new Error("disk unavailable"); });
  e.emit("message_start", 0);
  assert.doesNotThrow(() => e.emit("message_end", 100));
  e.emit("agent_end", 200);
  e.emit("message_end", 300);
  assert.equal(e.records.length, 1);
});

test("native entries flow through run checkpoints into a weighted speed without tool gaps or history", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-speed-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, "pi-agent", "sessions", "--project--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "date_native-session.jsonl");
  const append = row => fs.appendFileSync(file, JSON.stringify(row) + "\n");
  const native = output => ({ type: "message", message: { role: "assistant", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output } } });
  append(native(999));
  const reader = new PiRunUsageReader(dataDir);
  reader.begin("native-session");
  const e = extension(append);
  const finish = (output, start, duration) => {
    e.emit("message_start", start - 500);
    e.delta("thinking_delta", start);
    e.delta("text_delta", start + duration / 2);
    e.emit("message_end", start + duration, { message: { role: "assistant", usage: { output } } });
    append(native(output)); // Pi persists the message after extension hooks.
  };
  finish(20, 1_000, 1_000);
  finish(100, 62_000, 2_000); // A minute of tool / inter-call wait is excluded.
  const usage = reader.read();
  assert.deepEqual(usage.generationMeasurement, { outputTokens: 120, durationMs: 3_000, complete: true });
  const metrics = new RunMetricsCollector("run", () => {});
  metrics.enableAutomaticSpeed();
  metrics.observe([usage]);
  metrics.finish();
  assert.equal(metrics.snapshot().tokensPerSecond, 40);
  assert.equal(metrics.snapshot().speedSource, "measured");
  assert.equal(metrics.snapshot().generationDurationMs, 3_000);
  assert.equal(reader.read(), undefined);
  const next = new PiRunUsageReader(dataDir);
  next.begin("native-session");
  assert.equal(next.read(), undefined);
  finish(5, 90_000, 1_000);
  assert.equal(next.read().generationMeasurement.outputTokens, 5);
});

test("missing or mismatched native timing cannot be presented as complete-run speed", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-speed-missing-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, "pi-agent", "sessions", "--project--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "date_native-session.jsonl");
  const reader = new PiRunUsageReader(dataDir);
  reader.begin("native-session");
  fs.writeFileSync(file, [
    { type: "custom", customType: "freebuddy-generation-metrics", data: { version: 1, outputTokens: 20, durationMs: 1_000 } },
    { type: "message", message: { role: "assistant", usage: { input: 0, output: 30, cacheRead: 0, cacheWrite: 0 } } }
  ].map(JSON.stringify).join("\n") + "\n");
  assert.equal(reader.read().generationMeasurement.complete, false);
});

test("managed instrumentation installation is idempotent and upgrades stale source", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-speed-extension-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = ensurePiRunMetricsExtension(dataDir);
  const before = fs.statSync(file).mtimeMs;
  assert.equal(ensurePiRunMetricsExtension(dataDir), file);
  assert.equal(fs.statSync(file).mtimeMs, before);
  fs.writeFileSync(file, "old extension");
  ensurePiRunMetricsExtension(dataDir);
  assert.equal(fs.readFileSync(file, "utf8"), PI_RUN_METRICS_EXTENSION_SOURCE);
});

test("actual Pi RPC process loads managed instrumentation and persists measurable usage with a local simulated provider", { timeout: 20_000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-speed-rpc-"));
  const metricsFile = ensurePiRunMetricsExtension(dataDir);
  const providerFile = path.join(path.dirname(metricsFile), "fixture-provider.js");
  // No HTTP server, credentials or external requests: the real Pi event loop consumes this stream.
  fs.writeFileSync(providerFile, `export default function (pi) {
    pi.registerProvider("speed-fixture", {
      api: "speed-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
      models: [{ id: "fixed", name: "Fixed", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 100 }],
      streamSimple(model) {
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), content: [{ type: "text", text: "" }], stopReason: "stop",
          usage: { input: 10, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: message };
            await new Promise(resolve => setTimeout(resolve, 120));
            message.content[0].text = "first";
            yield { type: "text_delta", contentIndex: 0, delta: "first", partial: message };
            await new Promise(resolve => setTimeout(resolve, 60));
            message.content[0].text += " second";
            yield { type: "text_delta", contentIndex: 0, delta: " second", partial: message };
            yield { type: "done", reason: "stop", message };
          },
          result: async () => message
        };
      }
    });
  }`);
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url)),
    "--mode", "rpc", "--provider", "speed-fixture", "--model", "fixed", "--no-skills", "--no-themes", "--no-tools"
  ], { cwd: dataDir, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(dataDir, "pi-agent"), PI_SKIP_VERSION_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(async () => {
    child.kill();
    await closed;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2_000); });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  child.on("close", code => {
    for (const respond of pending.values()) respond({ success: false, error: `Pi exited ${code}: ${diagnostics}` });
  });
  let resolveSettled;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  lines.on("line", line => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.type === "response") pending.get(value.id)?.(value);
    if (value.type === "agent_settled") resolveSettled();
  });
  const rpc = (id, type, extra = {}) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Pi RPC ${type} timed out (exit ${child.exitCode}): ${diagnostics}`)), 10_000);
    pending.set(id, result => { clearTimeout(timeout); pending.delete(id); resolve(result); });
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
  });
  const state = await rpc("state", "get_state");
  assert.equal(state.success, true);
  const reader = new PiRunUsageReader(dataDir);
  reader.begin(state.data.sessionId);
  const result = await rpc("prompt", "prompt", { message: "fixture prompt" });
  assert.equal(result.success, true);
  await Promise.race([settled, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error("Pi did not settle")), 10_000);
    settled.finally(() => clearTimeout(timeout));
  })]);
  const usage = reader.read();
  assert.equal(usage?.outputTokens, 30);
  assert.equal(usage?.generationMeasurement?.complete, true);
  assert.ok(usage.generationMeasurement.durationMs >= 40);
  assert.ok(usage.generationMeasurement.durationMs < 2_000);
  const metrics = new RunMetricsCollector("run", () => {});
  metrics.observe([usage]);
  assert.equal(metrics.snapshot().speedSource, "measured");
  assert.ok(metrics.snapshot().tokensPerSecond > 0);
});

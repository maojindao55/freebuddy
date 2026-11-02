import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { RunMetricsCollector } from "../dist-electron/cli/runMetricsCollector.js";

const source = fs.readFileSync(new URL("../electron/cli/runtime.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
const require = createRequire(import.meta.url);

function loadRuntime(mode) {
  const delivered = [];
  const noop = () => {};
  const services = {
    RunMetricsCollector,
    getLogDir: () => { if (mode === "throw") throw new Error("setup failed"); return "/tmp"; },
    getAdapterDefinition: () => ({ capabilities: {} }),
    logMain: () => ({ info: noop, error: noop }),
    buildCommand: () => { throw new Error("invalid agent command"); },
    safeSendToWebContents: (_contents, _channel, event) => delivered.push(event)
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, process, console, Buffer, setTimeout, clearTimeout,
    require: name => {
      if (name === "node:fs") return { createWriteStream: () => ({ end: noop }) };
      if (name.startsWith("node:")) return require(name);
      return new Proxy(services, { get: (object, key) => key === "__esModule" ? true : object[key] ?? noop });
    }
  });
  return { runtime: exports, delivered };
}

test("startup exceptions flush a final summary before callers receive the rejected run", async () => {
  const { runtime, delivered } = loadRuntime("throw");
  await assert.rejects(runtime.cliRun({}, { sessionId: "run", adapter: "raw", agentId: "agent" }), /setup failed/);
  const summaries = delivered.flatMap(event => event.items ?? []).filter(item => item.runMetrics);
  assert.equal(summaries.at(-1).runMetrics.status, "failed");
  assert.equal(summaries.at(-1).runMetrics.runId, "run");
  assert.equal(summaries.at(-1).runMetrics.promptSubmitted, false);
});

test("command failures deliver terminal metrics before done so the normal message finalizer retains them", async () => {
  const { runtime, delivered } = loadRuntime("command");
  await runtime.cliRun({}, { sessionId: "run", adapter: "raw", agentId: "agent" });
  const doneIndex = delivered.findIndex(event => event.type === "done");
  const finalIndex = delivered.findIndex(event => event.items?.some(item => item.runMetrics?.status === "failed"));
  assert.ok(finalIndex >= 0 && finalIndex < doneIndex);
  assert.equal(delivered[doneIndex].exitCode, -1);
  assert.equal(delivered.filter(event => event.type === "done").length, 1);
});

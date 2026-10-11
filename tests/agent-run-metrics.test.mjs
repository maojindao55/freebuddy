import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { RunMetricsCollector } from "../dist-electron/cli/runMetricsCollector.js";
import { serializeStreamItemsForPersist } from "@freebuddy/cli-stream";
import { acpPromptResultToItems, acpUpdateToItems } from "../dist-electron/cli/acp.js";

const source = fs.readFileSync(new URL("../src/components/CLI/runCardMetrics.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { selectRunCardMetrics: select, runCardElapsedMs: elapsed } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const usage = runMetrics => ({ kind: "usage", runId: runMetrics.runId, runMetrics });
const message = items => ({ role: "assistant", taskId: "run", content: JSON.stringify(items) });
const live = items => ({ taskSessionId: "run", status: "running", items, runMetricsReceivedAt: 100 });

function collector() {
  let now = 100;
  const snapshots = [];
  const metrics = new RunMetricsCollector("run", snapshot => snapshots.push(snapshot), () => now);
  return { metrics, snapshots, time: value => { now = value; } };
}

test("first text starts at prompt submission, excludes non-body events and uses arrival before parsing/batching", () => {
  const { metrics, snapshots, time } = collector();
  time(200);
  metrics.observe([{ kind: "text", role: "assistant", content: "replay before prompt" }]);
  assert.equal(metrics.snapshot().firstTextLatencyMs, undefined);
  time(500);
  metrics.promptSubmitted();
  time(800);
  metrics.observe([{ kind: "thinking", content: "thinking" }, { kind: "tool-call" }, { kind: "text", role: "user", content: "echo" }, { kind: "text", role: "assistant", content: " \n" }]);
  assert.equal(metrics.snapshot().firstTextLatencyMs, undefined);
  const arrival = metrics.now();
  time(1_000);
  metrics.observe([{ kind: "text", role: "assistant", content: "first" }], arrival);
  assert.equal(metrics.snapshot().firstTextLatencyMs, 300);
  metrics.promptSubmitted(); // Internal retries must retain the first prompt origin.
  metrics.observe([{ kind: "text", role: "assistant", content: "next" }]);
  assert.equal(metrics.snapshot().firstTextLatencyMs, 300);
  assert.equal(snapshots.length, 3); // Prompt, first thinking, then first body.
  assert.equal(JSON.stringify(snapshots).includes("replay"), false);
});

test("first output includes thinking before body and preserves its arrival across retries and completion", () => {
  const { metrics, time } = collector();
  metrics.observe([{ kind: "thinking", content: "historical thinking" }]);
  assert.equal(metrics.snapshot().firstOutputLatencyMs, undefined);
  time(500);
  metrics.promptSubmitted();
  time(800);
  metrics.observe(acpUpdateToItems({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } }));
  assert.equal(metrics.snapshot().firstOutputLatencyMs, 300);
  assert.equal(metrics.snapshot().firstOutputKind, "thinking");
  assert.equal(metrics.snapshot().firstTextLatencyMs, undefined);
  time(2_000);
  metrics.promptSubmitted();
  metrics.beginGeneration();
  metrics.observe([{ kind: "text", role: "assistant", content: "body" }]);
  assert.equal(metrics.snapshot().firstTextLatencyMs, 1_500);
  metrics.finish();
  time(20_000);
  metrics.observe([{ kind: "generation-delta" }]);
  assert.equal(metrics.snapshot().firstOutputLatencyMs, 300);
  assert.equal(metrics.snapshot().firstOutputKind, "thinking");
});

test("tool requests and streamed arguments count as first output; results and terminal updates do not", () => {
  for (const first of [
    ...acpUpdateToItems({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read", status: "in_progress", rawInput: { path: "file" } }),
    { kind: "generation-delta" },
  ]) {
    const { metrics, time } = collector();
    metrics.promptSubmitted();
    time(300);
    metrics.observe([
      { kind: "usage", outputTokens: 100 },
      { kind: "thinking", content: " \n" },
      { kind: "text", role: "user", content: "echo" },
      { kind: "tool-call" },
      { kind: "tool-call", id: "old", status: "completed" },
      { kind: "tool-call", id: "failed", status: "failed" },
      { kind: "tool-result", id: "old", content: "result" },
      { kind: "raw", content: "log" },
    ]);
    assert.equal(metrics.snapshot().firstOutputLatencyMs, undefined);
    time(600);
    metrics.observe([first]);
    assert.equal(metrics.snapshot().firstOutputLatencyMs, 500);
    assert.equal(metrics.snapshot().firstOutputKind, "tool-call");
    time(9_000);
    metrics.observe([{ kind: "text", role: "assistant", content: "after tool execution" }]);
    assert.equal(metrics.snapshot().firstOutputLatencyMs, 500);
    assert.equal(metrics.snapshot().firstTextLatencyMs, 8_900);
  }
});

test("retry without any body retains the original wait and unmeasurable transports stay unknown", () => {
  const { metrics, time } = collector();
  metrics.promptSubmitted();
  time(1_000);
  metrics.promptSubmitted();
  time(1_250);
  metrics.observe([{ kind: "text", role: "assistant", content: "after retry" }]);
  assert.equal(metrics.snapshot().firstTextLatencyMs, 1_150);
  const unsupported = collector().metrics;
  unsupported.unavailableFirstText();
  unsupported.promptSubmitted();
  unsupported.observe([{ kind: "text", role: "assistant", content: "ambiguous replay" }]);
  assert.equal(unsupported.snapshot().firstTextUnavailable, true);
  assert.equal(unsupported.snapshot().firstTextLatencyMs, undefined);
  assert.equal(unsupported.snapshot().firstOutputUnavailable, true);
  assert.equal(unsupported.snapshot().firstOutputLatencyMs, undefined);
});

test("turn usage overwrites rather than adds; cumulative, invalid and context-only values are excluded", () => {
  const { metrics } = collector();
  metrics.observe([{ kind: "usage", usageScope: "session", inputTokens: 9_000, outputTokens: 100 }]);
  assert.equal(metrics.snapshot().inputTokens, undefined);
  metrics.observe([{ kind: "usage", usageScope: "turn", inputTokens: 0, outputTokens: 10, metrics: { tokensPerSecond: 0, avgTtftMs: 250 } }]);
  metrics.observe([{ kind: "usage", usageScope: "turn", outputTokens: 10 }]);
  metrics.observe([{ kind: "usage", inputTokens: 99_000, outputTokens: 500 }]);
  metrics.observe([{ kind: "usage", usageScope: "turn", inputTokens: -1, outputTokens: Infinity, metrics: { avgTtftMs: NaN, tokensPerSecond: -5 } }]);
  const result = metrics.snapshot();
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 10);
  assert.equal(result.tokensPerSecond, 0);
  assert.equal(result.reportedTtftMs, 250);
  assert.equal(result.speedSource, "reported");
});

test("automatic speed uses matched run streaming intervals, survives later vendor reports, and invalidates partial coverage", () => {
  const { metrics } = collector();
  metrics.enableAutomaticSpeed();
  const measured = { kind: "usage", usageScope: "turn", generationMeasurement: { outputTokens: 120, durationMs: 3_000, complete: true } };
  metrics.observe([measured]);
  metrics.observe([measured]); // Cumulative measurements overwrite; never double-count.
  metrics.observe([{ kind: "usage", metrics: { tokensPerSecond: 999 } }]);
  assert.equal(metrics.snapshot().tokensPerSecond, 40);
  assert.equal(metrics.snapshot().speedSource, "measured");
  assert.equal(metrics.snapshot().automaticSpeed, true);
  metrics.observe([{ ...measured, generationMeasurement: { ...measured.generationMeasurement, complete: false } }]);
  assert.equal(metrics.snapshot().tokensPerSecond, 999);
  assert.equal(metrics.snapshot().speedSource, "reported");
  assert.equal(metrics.snapshot().generationDurationMs, undefined);
  const clean = collector().metrics;
  for (const generationMeasurement of [
    { outputTokens: 20, durationMs: 0, complete: true },
    { outputTokens: 20, durationMs: 0.5, complete: true },
    { outputTokens: 20.5, durationMs: 1_000, complete: true },
    { outputTokens: 20, durationMs: 1_000, complete: "false" },
    { outputTokens: Infinity, durationMs: 1_000, complete: true },
    { outputTokens: 20, durationMs: NaN, complete: true },
    { outputTokens: 20, durationMs: 1_000, complete: false }
  ]) clean.observe([{ ...measured, generationMeasurement }]);
  clean.observe([{ ...measured, usageScope: "session" }]);
  assert.equal(clean.snapshot().tokensPerSecond, undefined);
  clean.observe([measured]);
  clean.observe([{ ...measured, generationMeasurement: { ...measured.generationMeasurement, complete: false } }]);
  assert.equal(clean.snapshot().tokensPerSecond, undefined);
});

for (const status of ["done", "failed", "cancelled", "timed-out", "yielded"]) {
  test(`terminal ${status} freezes elapsed and cannot be changed by late events`, () => {
    const { metrics, time } = collector();
    metrics.promptSubmitted();
    time(1_600);
    if (!["done", "failed"].includes(status)) metrics.requestOutcome(status);
    metrics.finish(status === "failed" ? "failed" : "done");
    assert.equal(metrics.snapshot().status, status);
    assert.equal(metrics.snapshot().elapsedMs, 1_500);
    time(99_999);
    metrics.finish("failed");
    metrics.observe([{ kind: "usage", usageScope: "turn", outputTokens: 99 }]);
    assert.equal(metrics.snapshot().status, status);
    assert.equal(metrics.snapshot().elapsedMs, 1_500);
    assert.equal(metrics.snapshot().outputTokens, undefined);
  });
}

test("terminal errors override a nominal successful process exit; observers cannot break execution", () => {
  const { metrics } = collector();
  metrics.observe([{ kind: "error", terminal: true }]);
  metrics.finish("done");
  assert.equal(metrics.snapshot().status, "failed");
  const broken = new RunMetricsCollector("run", () => { throw new Error("UI gone"); });
  assert.doesNotThrow(() => { broken.emit(); broken.promptSubmitted(); broken.finish(); });
});

test("a new run never falls back to the previous run, even before its first item", () => {
  const history = [message([{ kind: "usage", usageScope: "turn", inputTokens: 5_000, metrics: { tokensPerSecond: 50 } }])];
  for (const items of [[], [{ kind: "usage", contextUsed: 100 }]]) {
    const result = select(history, live(items));
    assert.equal(result.inputTokens, undefined);
    assert.equal(result.tokensPerSecond, undefined);
    assert.equal(result.firstTextMs, undefined);
  }
  const latest = select([...history, message([{ kind: "text", role: "assistant", content: "no usage" }])]);
  assert.equal(latest.usage, undefined);
  assert.equal(select([...history, { role: "user", content: "next prompt" }]).exists, false);
});

test("selection binds execution IDs, ignores cumulative overwrites, preserves zero and never estimates speed", () => {
  const result = select([], live([
    { kind: "usage", runId: "old", usageScope: "turn", inputTokens: 9_000, metrics: { tokensPerSecond: 99 } },
    { kind: "usage", runId: "run", usageScope: "turn", inputTokens: 0, outputTokens: 5 },
    { kind: "usage", runId: "run", inputTokens: 500, contextUsed: 1_000 },
    usage({ runId: "old", status: "done", elapsedMs: 100, promptSubmitted: true, firstTextLatencyMs: 10 })
  ]));
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 5);
  assert.equal(result.firstTextMs, undefined);
  assert.equal(result.tokensPerSecond, undefined);
  assert.equal(result.usage.contextUsed, 1_000);
});

test("renderer extrapolates using local monotonic receipt and freezes terminal or interrupted history", () => {
  const summary = { runId: "run", status: "running", elapsedMs: 1_000, promptSubmitted: true };
  assert.equal(elapsed(summary, true, 100, 600), 1_500);
  assert.equal(elapsed(summary, true, 600, 100), 1_000);
  assert.equal(elapsed(summary, false, 100, 600), undefined);
  assert.equal(elapsed({ ...summary, status: "done" }, true, 100, 600), 1_000);
  assert.equal(elapsed(undefined, true, 100, 600), undefined);
  assert.equal(select([message([usage(summary)])]).status, "unknown");
});

test("final summaries survive the existing persistence cap and reload with their own run", () => {
  const { metrics } = collector();
  metrics.promptSubmitted();
  metrics.enableAutomaticSpeed();
  metrics.observe([{ kind: "thinking", content: "first thinking" }]);
  metrics.observe([{ kind: "usage", usageScope: "turn", inputTokens: 0, outputTokens: 100,
    generationMeasurement: { outputTokens: 100, durationMs: 2_000, complete: true } }]);
  metrics.finish();
  const serialized = serializeStreamItemsForPersist([
    { kind: "text", role: "assistant", content: "x".repeat(400_000) }, usage(metrics.snapshot())
  ]);
  const result = select([{ role: "assistant", taskId: "run", content: serialized }]);
  assert.equal(result.status, "done");
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 100);
  assert.equal(result.tokensPerSecond, 50);
  assert.equal(result.speedSource, "measured");
  assert.equal(result.automaticSpeed, true);
  assert.equal(result.firstOutputTracked, true);
  assert.equal(result.firstOutputMs, 0);
  assert.equal(result.firstOutputKind, "thinking");
});

test("truncation pins the terminal run-metrics summary instead of dropping the earliest item", () => {
  const { metrics } = collector();
  metrics.promptSubmitted();
  metrics.observe([{ kind: "usage", usageScope: "turn", inputTokens: 1_000, outputTokens: 200 }]);
  metrics.finish();
  const items = [usage(metrics.snapshot())];
  for (let i = 0; i < 60; i += 1) items.push({ kind: "text", role: "assistant", content: `${i}:${"x".repeat(10_000)}` });
  const serialized = serializeStreamItemsForPersist(items);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed[0].kind, "raw"); // Truncation notice leads the persisted stream.
  const summaries = parsed.filter(item => item.kind === "usage" && item.runMetrics?.runId === "run");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].runMetrics.status, "done");
  const lastText = parsed.filter(item => item.kind === "text").at(-1);
  assert.ok(lastText.content.startsWith("59:"));
  const result = select([{ role: "assistant", taskId: "run", content: serialized }]);
  assert.equal(result.status, "done");
  assert.equal(result.summary.elapsedMs, metrics.snapshot().elapsedMs);
});

test("repeated snapshots of the same run keep only the terminal summary under truncation", () => {
  const { metrics, time } = collector();
  metrics.promptSubmitted();
  time(300);
  const first = metrics.snapshot();
  time(700);
  const second = metrics.snapshot();
  metrics.finish();
  const terminal = metrics.snapshot();
  const items = [
    usage(first),
    usage(second),
    usage(terminal),
    ...Array.from({ length: 60 }, (_, i) => ({ kind: "text", role: "assistant", content: `${i}:${"y".repeat(10_000)}` }))
  ];
  const serialized = serializeStreamItemsForPersist(items);
  const parsed = JSON.parse(serialized);
  const summaries = parsed.filter(item => item.kind === "usage" && item.runMetrics?.runId === "run");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].runMetrics.status, "done");
  assert.equal(summaries[0].runMetrics.elapsedMs, terminal.elapsedMs);
});

test("vendor metrics token counters require explicit turn scope, unlike ACP prompt usage", () => {
  const metadata = { metrics: { totalInputTokens: 99_000, outputTokens: 900, tokensPerSecond: 20 } };
  assert.equal(select([message(acpPromptResultToItems(metadata))]).inputTokens, undefined);
  const scoped = select([message(acpPromptResultToItems({ metrics: { ...metadata.metrics, usageScope: "turn" } }))]);
  assert.equal(scoped.inputTokens, 99_000);
  const result = select([message(acpPromptResultToItems({ usage: { inputTokens: 0, outputTokens: 50 }, metrics: metadata.metrics }))]);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 50);
});

test("legacy completion markers without exit codes do not override a successful final exit", () => {
  const done = select([message([{ kind: "done" }, { kind: "done", exitCode: 0 }])]);
  assert.equal(done.status, "done");
  const cancelled = select([], { ...live([usage({ runId: "run", status: "running", elapsedMs: 100, promptSubmitted: true })]), status: "killed" });
  assert.equal(cancelled.status, "cancelled");
});

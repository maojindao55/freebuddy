import test from "node:test";
import assert from "node:assert/strict";
import { RunMetricsCollector } from "../dist-electron/cli/runMetricsCollector.js";
import { acpPromptResultToItems } from "../dist-electron/cli/acp.js";

const delta = content => ({ kind: "text", role: "assistant", content, append: true });
const usage = outputTokens => ({ kind: "usage", usageScope: "turn", outputTokens });
function fixture() {
  let at = 0;
  const metrics = new RunMetricsCollector("run", () => {}, () => at);
  metrics.enableAutomaticSpeed("stream");
  metrics.promptSubmitted();
  metrics.beginGeneration();
  return {
    metrics,
    observe: (time, items) => { at = time; metrics.observe(items); },
    end: (time, tokens) => { at = time; metrics.completeGeneration(); metrics.observe([usage(tokens)]); },
    now: value => { at = value; }
  };
}

test("uniform host measurement uses actual turn tokens, excludes first wait and freezes before cleanup", () => {
  const f = fixture();
  f.observe(100, [{ kind: "usage", usageScope: "session", outputTokens: 9999 }]);
  f.observe(1_000, [delta("first")]);
  f.observe(1_500, [delta("second")]);
  f.end(2_000, 60);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 60);
  assert.equal(f.metrics.snapshot().generationDurationMs, 1_000);
  assert.equal(f.metrics.snapshot().speedSource, "observed");
  f.now(90_000);
  f.metrics.finish();
  assert.equal(f.metrics.snapshot().tokensPerSecond, 60);
});

test("uniform speed sums generation intervals across tools and parallel tools without their wait", () => {
  const f = fixture();
  f.observe(1_000, [{ kind: "thinking", content: "thought", append: true }]);
  f.observe(1_500, [delta("calling tools")]);
  f.observe(2_000, [
    { kind: "tool-call", id: "a", status: "pending" },
    { kind: "tool-call", id: "b", status: "running" }
  ]);
  f.observe(8_000, [{ kind: "tool-call", id: "a", status: "completed" }]);
  f.observe(10_000, [{ kind: "tool-result", id: "b", content: "tool output is not tokens" }]);
  f.observe(10_100, [{ kind: "tool-call", id: "b", status: "completed" }]); // Duplicate completion.
  f.observe(12_000, [delta("final")]);
  f.observe(13_000, [delta("answer")]);
  f.end(14_000, 120);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 40);
  assert.equal(f.metrics.snapshot().generationDurationMs, 3_000);
});

test("permission pauses are split and do not add human wait or the next first-packet latency", () => {
  const f = fixture();
  f.observe(1_000, [delta("first")]);
  f.observe(1_100, [delta("second")]);
  f.metrics.pauseGeneration(1_200);
  f.now(15_000);
  f.metrics.resumeGeneration();
  f.observe(16_000, [delta("after")]);
  f.observe(17_000, [delta("approval")]);
  f.end(18_000, 220);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 100);
  assert.equal(f.metrics.snapshot().generationDurationMs, 2_200);
});

test("missing tokens and unknown or session-scoped counters never produce tok/s", () => {
  for (const item of [
    usage(undefined), usage(-1), usage(NaN), usage(Infinity), usage("20"), usage(20.5),
    { ...usage(99_999), usageScope: "session" }, { kind: "usage", outputTokens: 99_999 }
  ]) {
    const f = fixture();
    f.observe(1_000, [delta("first")]);
    f.observe(1_500, [delta("second")]);
    f.metrics.completeGeneration(2_000);
    f.observe(2_000, [item]);
    f.metrics.finish();
    assert.equal(f.metrics.snapshot().tokensPerSecond, undefined);
  }
});

test("AGY turn usage keeps true tokens but hidden reasoning cannot use the body-only interval", () => {
  const f = fixture();
  for (const at of [12_438, 12_565, 12_591, 12_617, 12_642, 12_668, 12_694]) {
    f.observe(at, [delta("body")]);
  }
  f.metrics.completeGeneration(13_567);
  f.observe(13_567, [{ ...usage(217), inputTokens: 13_276, thoughtTokens: 172 }]);
  const result = f.metrics.snapshot();
  assert.equal(result.inputTokens, 13_276);
  assert.equal(result.outputTokens, 217);
  assert.equal(result.firstTextLatencyMs, 12_438);
  assert.equal(result.tokensPerSecond, undefined);
  assert.equal(result.speedSource, undefined);
  assert.equal(result.generationDurationMs, undefined);
  assert.equal(result.automaticSpeed, true);
});

test("streamed reasoning and explicit zero thought tokens still allow protocol observation", () => {
  for (const thinking of [true, false]) {
    const f = fixture();
    f.observe(500, [thinking ? { kind: "thinking", content: "thought", append: true } : delta("first")]);
    f.observe(750, [delta("second")]);
    f.metrics.completeGeneration(2_000);
    f.observe(2_000, [{ ...usage(150), thoughtTokens: thinking ? 100 : 0 }]);
    assert.equal(f.metrics.snapshot().tokensPerSecond, 100);
    assert.equal(f.metrics.snapshot().speedSource, "observed");
  }
});

test("late hidden reasoning revokes an observed rate and survives later output-only counters", () => {
  const f = fixture();
  f.observe(1_000, [delta("first")]);
  f.observe(1_500, [delta("second")]);
  f.end(2_000, 50);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 50);
  f.observe(2_050, [{ kind: "usage", usageScope: "session", thoughtTokens: 999 }]);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 50);
  f.observe(2_100, [{ kind: "usage", usageScope: "turn", metrics: { thoughtTokens: 30 } }]);
  f.observe(2_200, [usage(50)]);
  assert.equal(f.metrics.snapshot().tokensPerSecond, undefined);
  assert.equal(f.metrics.snapshot().outputTokens, 50);
  f.metrics.beginGeneration();
  f.observe(3_000, [delta("new")]);
  f.observe(3_500, [delta("answer")]);
  f.end(4_000, 40);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 40);
});

test("native complete timing remains measurable when reasoning is hidden from the client", () => {
  const f = fixture();
  f.observe(1_000, [delta("first")]);
  f.observe(1_500, [delta("second")]);
  f.metrics.completeGeneration(2_000);
  f.observe(2_000, [{ ...usage(217), thoughtTokens: 172,
    generationMeasurement: { outputTokens: 217, durationMs: 2_500, complete: true } }]);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 86.8);
  assert.equal(f.metrics.snapshot().speedSource, "measured");
});

test("AGY native call duration measures hidden reasoning and first-packet waiting", () => {
  const f = fixture();
  f.observe(18_087, [delta("body")]);
  f.metrics.completeGeneration(18_932);
  f.observe(18_932, acpPromptResultToItems({
    stopReason: "end_turn",
    usage: { inputTokens: 13_520, outputTokens: 339, thoughtTokens: 334, totalTokens: 13_859 },
    _meta: { metrics: { usageScope: "turn", modelCallDurationMs: 5_873.064 } }
  }));
  const result = f.metrics.snapshot();
  assert.equal(result.inputTokens, 13_520);
  assert.equal(result.outputTokens, 339);
  assert.equal(result.tokensPerSecond, 339 * 1000 / 5_873.064);
  assert.equal(result.speedSource, "call-average");
  assert.equal(result.modelCallDurationMs, 5_873.064);
  assert.equal(result.generationDurationMs, undefined);
  assert.equal(result.firstTextLatencyMs, 18_087);
});

test("explicit call timing takes precedence over a body stream and resets on retry", () => {
  const f = fixture();
  f.observe(1_000, [delta("first")]);
  f.observe(1_500, [delta("second")]);
  f.metrics.completeGeneration(2_000);
  f.observe(2_000, [{ ...usage(60), metrics: { modelCallDurationMs: 6_000, tokensPerSecond: 999 } }]);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 10);
  assert.equal(f.metrics.snapshot().speedSource, "call-average");
  f.observe(2_100, [{ kind: "usage", metrics: { tokensPerSecond: 500 } }]);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 10);
  f.metrics.beginGeneration();
  assert.equal(f.metrics.snapshot().tokensPerSecond, undefined);
  assert.equal(f.metrics.snapshot().modelCallDurationMs, undefined);
  f.observe(3_000, [delta("new")]);
  f.observe(3_500, [delta("answer")]);
  f.end(4_000, 40);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 40);
  assert.equal(f.metrics.snapshot().speedSource, "observed");
});

test("call average requires true turn-scoped output and valid explicit call duration", () => {
  for (const item of [
    ...[undefined, "2000", 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(duration =>
      ({ ...usage(60), thoughtTokens: 30, metrics: { modelCallDurationMs: duration } })),
    ...[undefined, "60", 1.5, -1, Infinity].map(tokens =>
      ({ ...usage(tokens), metrics: { modelCallDurationMs: 2_000 } })),
    { ...usage(60), usageScope: "session", metrics: { modelCallDurationMs: 2_000 } },
    { kind: "usage", outputTokens: 60, metrics: { modelCallDurationMs: 2_000 } },
    { ...usage(60), metrics: { llmDurationMs: 2_000 } }
  ]) {
    const f = fixture();
    f.observe(1_000, [delta("only one chunk")]);
    f.metrics.completeGeneration(2_000);
    f.observe(2_000, [item]);
    assert.equal(f.metrics.snapshot().tokensPerSecond, undefined);
  }
  const zero = fixture();
  zero.metrics.completeGeneration(2_000);
  zero.observe(2_000, [{ ...usage(0), metrics: { modelCallDurationMs: 2_000 } }]);
  assert.equal(zero.metrics.snapshot().tokensPerSecond, 0);
  assert.equal(zero.metrics.snapshot().speedSource, "call-average");
});

test("native streaming timing stays preferred over call average and its denominator", () => {
  const f = fixture();
  f.metrics.completeGeneration(2_000);
  f.observe(2_000, [{ ...usage(100), metrics: { modelCallDurationMs: 5_000 } }]);
  assert.equal(f.metrics.snapshot().speedSource, "call-average");
  f.observe(2_100, [{ ...usage(100),
    generationMeasurement: { outputTokens: 100, durationMs: 2_000, complete: true } }]);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 50);
  assert.equal(f.metrics.snapshot().speedSource, "measured");
  assert.equal(f.metrics.snapshot().modelCallDurationMs, undefined);
  assert.equal(f.metrics.snapshot().generationDurationMs, 2_000);
  f.observe(2_200, [{ ...usage(100), metrics: { modelCallDurationMs: 9_000 } }]);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 50);
  assert.equal(f.metrics.snapshot().speedSource, "measured");
});

test("buffered output, one chunk and multiple chunks delivered at one instant stay unavailable", () => {
  for (const items of [
    [{ kind: "text", role: "assistant", content: "whole response" }],
    [delta("one chunk")], [delta("one"), delta("two")]
  ]) {
    const f = fixture();
    f.observe(1_000, items);
    f.end(2_000, 50);
    assert.equal(f.metrics.snapshot().tokensPerSecond, undefined);
  }
});

test("tool-only calls, missing tool boundaries and overlapping model/tool output remain unavailable", () => {
  for (const tail of [
    [{ kind: "tool-call", status: "pending" }],
    [{ kind: "tool-result", id: "unknown" }],
    [{ kind: "command" }],
    [{ kind: "tool-call", id: "tool", status: "running" }, delta("overlap")]
  ]) {
    const f = fixture();
    f.observe(1_000, [delta("first")]);
    f.observe(1_500, [delta("second")]);
    f.observe(2_000, tail);
    f.end(4_000, 100);
    assert.equal(f.metrics.snapshot().tokensPerSecond, undefined);
  }
  const f = fixture();
  f.observe(1_000, [{ kind: "tool-call", id: "tool", status: "pending" }]);
  f.observe(2_000, [{ kind: "tool-call", id: "tool", status: "completed" }]);
  f.observe(3_000, [delta("final")]);
  f.observe(3_500, [delta("answer")]);
  f.end(4_000, 100);
  assert.equal(f.metrics.snapshot().tokensPerSecond, undefined);
});

test("a retried prompt discards the old interval and observed speed; ambiguous legacy replay is excluded", () => {
  const f = fixture();
  f.observe(1_000, [delta("first")]);
  f.observe(1_500, [delta("second")]);
  f.end(2_000, 50);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 50);
  f.metrics.beginGeneration();
  assert.equal(f.metrics.snapshot().tokensPerSecond, undefined);
  f.observe(3_000, [delta("one buffered retry")]);
  f.end(4_000, 20);
  assert.equal(f.metrics.snapshot().tokensPerSecond, undefined);
  const resumed = fixture();
  resumed.metrics.unavailableFirstText();
  resumed.observe(1_000, [delta("replay")]);
  resumed.observe(1_500, [delta("replay")]);
  resumed.end(2_000, 50);
  assert.equal(resumed.metrics.snapshot().tokensPerSecond, undefined);
});

test("native timing takes precedence over protocol observation, then vendor reporting is a fallback", () => {
  const f = fixture();
  f.observe(1_000, [delta("first")]);
  f.observe(1_500, [delta("second")]);
  f.end(2_000, 50);
  f.observe(2_100, [{ ...usage(50), generationMeasurement: { outputTokens: 50, durationMs: 2_000, complete: true } }]);
  f.observe(2_200, [usage(50), { kind: "usage", metrics: { tokensPerSecond: 999 } }]);
  assert.equal(f.metrics.snapshot().tokensPerSecond, 25);
  assert.equal(f.metrics.snapshot().speedSource, "measured");
  const missing = fixture();
  missing.end(1_000, undefined);
  missing.observe(2_000, [{ kind: "usage", metrics: { tokensPerSecond: 80 } }]);
  assert.equal(missing.metrics.snapshot().tokensPerSecond, 80);
  assert.equal(missing.metrics.snapshot().speedSource, "reported");
});

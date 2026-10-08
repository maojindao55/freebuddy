import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRunUsageReader } from "../dist-electron/cli/piRunUsage.js";
import { RunMetricsCollector } from "../dist-electron/cli/runMetricsCollector.js";

const row = (input = 50, output = 10, cacheRead = 100, cacheWrite = 0, reasoning = 0) => ({
  type: "message", message: { role: "assistant", content: [{ type: "text", text: "private reply" }],
    usage: { input, output, cacheRead, cacheWrite, reasoning }, stopReason: "stop" }
});
const lines = rows => rows.map(value => JSON.stringify(value)).join("\n") + "\n";
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-pi-usage-"));
  const dir = path.join(dataDir, "pi-agent", "sessions", "--project--");
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = session => path.join(dir, `2026-10-07T06-00-00-000Z_${session}.jsonl`);
  return { dataDir, file, reader: new PiRunUsageReader(dataDir) };
}

test("Pi usage excludes history and sums only new model calls, including cached input and reasoning once", t => {
  const { file, reader } = fixture(t);
  fs.writeFileSync(file("session"), lines([row(9_000, 9_000)]));
  reader.begin("session");
  fs.appendFileSync(file("session"), lines([
    { type: "message", message: { role: "user", content: "private prompt" } },
    row(50, 10, 100, 5, 3),
    { type: "message", message: { role: "toolResult", usage: { input: 999, output: 999 } } },
    row(60, 20, 200, 10, 4)
  ]));
  const result = reader.read();
  assert.equal(result.usageScope, "turn");
  assert.equal(result.inputTokens, 425);
  assert.equal(result.outputTokens, 30);
  assert.equal(result.cachedReadTokens, 300);
  assert.equal(result.cachedWriteTokens, 15);
  assert.equal(result.thoughtTokens, 7);
  assert.equal(result.metrics, undefined); // No invented generation speed.
  assert.doesNotMatch(JSON.stringify(result), /private|prompt|reply/);
  assert.equal(reader.read(), undefined);
  reader.begin("session"); // A retry keeps the same checkpoint.
  fs.appendFileSync(file("session"), lines([row(5, 2, 0, 0, 0)]));
  assert.equal(reader.read().inputTokens, 430);
});

test("a fresh Pi session can create its file after prompt submission; a later run resets its baseline", t => {
  const { dataDir, file, reader } = fixture(t);
  reader.begin("fresh");
  assert.equal(reader.read(), undefined);
  fs.writeFileSync(file("fresh"), lines([{ type: "session", id: "fresh" }, row(0, 0, 0, 0, 0)]));
  const zero = reader.read();
  assert.equal(zero.inputTokens, 0);
  assert.equal(zero.outputTokens, 0);
  const next = new PiRunUsageReader(dataDir);
  next.begin("fresh");
  assert.equal(next.read(), undefined);
  fs.appendFileSync(file("fresh"), lines([row(3, 4, 0, 0)]));
  assert.equal(next.read().inputTokens, 3);
});

test("Pi session replacement during retries aggregates only each session's new usage", t => {
  const { file, reader } = fixture(t);
  reader.begin("first");
  fs.writeFileSync(file("first"), lines([row(10, 2, 0, 0)]));
  assert.equal(reader.read().outputTokens, 2);
  fs.writeFileSync(file("second"), lines([row(999, 999)]));
  reader.begin("second");
  fs.appendFileSync(file("second"), lines([row(20, 3, 0, 0)]));
  assert.equal(reader.read().inputTokens, 30);
});

test("unknown counters never turn into zero or partial totals; incomplete JSON waits for its newline", t => {
  const { file, reader } = fixture(t);
  reader.begin("session");
  const missing = row();
  delete missing.message.usage.input;
  fs.writeFileSync(file("session"), lines([missing]));
  assert.equal(reader.read().inputTokens, undefined);
  fs.appendFileSync(file("session"), JSON.stringify(row(50, 5, 0, 0)));
  assert.equal(reader.read(), undefined);
  fs.appendFileSync(file("session"), "\n");
  const result = reader.read();
  assert.equal(result.inputTokens, undefined);
  assert.equal(result.outputTokens, 15);
});

test("missing, corrupt, truncated, oversized, or ambiguously matched native files stay unavailable", t => {
  const { dataDir, file } = fixture(t);
  for (const session of ["missing", "corrupt", "truncated", "oversized", "ambiguous"]) {
    const reader = new PiRunUsageReader(dataDir);
    if (session === "truncated") fs.writeFileSync(file(session), lines([row()]));
    reader.begin(session);
    if (session === "corrupt") fs.writeFileSync(file(session), "invalid\n");
    if (session === "truncated") fs.writeFileSync(file(session), "\n");
    if (session === "oversized") fs.writeFileSync(file(session), " ".repeat(8 * 1024 * 1024 + 1));
    if (session === "ambiguous") {
      fs.writeFileSync(file(session), lines([row()]));
      fs.writeFileSync(path.join(path.dirname(file(session)), `other_${session}.jsonl`), lines([row()]));
    }
    assert.equal(reader.read(), undefined, session);
  }
  const traversal = new PiRunUsageReader(dataDir);
  traversal.begin("../../outside");
  assert.equal(traversal.read(), undefined);
});

test("native turn usage updates the same final metrics summary consumed by the card", t => {
  const { file, reader } = fixture(t);
  reader.begin("session");
  fs.writeFileSync(file("session"), lines([row(353, 57, 2560, 0)]));
  const metrics = new RunMetricsCollector("run", () => {});
  metrics.promptSubmitted();
  metrics.observe([reader.read()]);
  metrics.finish();
  assert.equal(metrics.snapshot().inputTokens, 2913);
  assert.equal(metrics.snapshot().outputTokens, 57);
  assert.equal(metrics.snapshot().tokensPerSecond, undefined);
});

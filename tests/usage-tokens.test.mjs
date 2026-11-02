import test from "node:test";
import assert from "node:assert/strict";
import { inputTokensIncludingCache } from "@freebuddy/cli-stream";
import { acpPromptResultToItems } from "../dist-electron/cli/acp.js";

test("Codex prompt usage includes cached input exactly once", () => {
  const raw = { inputTokens: 19173, cachedReadTokens: 129280, cachedWriteTokens: 0,
    outputTokens: 1011, thoughtTokens: 431, totalTokens: 149464 };
  const [usage] = acpPromptResultToItems({ stopReason: "end_turn", usage: raw });
  assert.equal(usage.inputTokens, 148453); assert.equal(usage.outputTokens, 1011);
  assert.equal(usage.cachedReadTokens, 129280); assert.equal(usage.thoughtTokens, 431);
  assert.equal(inputTokensIncludingCache(usage), 148453);
  assert.equal(raw.inputTokens, 19173);
});

test("input counter normalization preserves inclusive, missing and ambiguous usage totals", () => {
  assert.equal(inputTokensIncludingCache({ inputTokens: 100, cachedReadTokens: 60, outputTokens: 20, totalTokens: 120 }), 100);
  assert.equal(inputTokensIncludingCache({ inputTokens: 100, cachedReadTokens: 60, outputTokens: 20 }), 100);
  assert.equal(inputTokensIncludingCache({ inputTokens: 100, cachedReadTokens: 60, outputTokens: 20, totalTokens: 999 }), 100);
  assert.equal(inputTokensIncludingCache({ cachedReadTokens: 60, outputTokens: 20, totalTokens: 80 }), undefined);
  assert.equal(inputTokensIncludingCache({ inputTokens: 100, cachedReadTokens: -60, outputTokens: 20, totalTokens: 60 }), 100);
  assert.equal(inputTokensIncludingCache({ inputTokens: 10, cachedReadTokens: 60, cachedWriteTokens: 30, outputTokens: 20, totalTokens: 120 }), 100);
});

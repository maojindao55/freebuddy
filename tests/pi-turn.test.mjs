import test from "node:test";
import assert from "node:assert/strict";
import { PiTurnTracker, piBridgeStatus, piLifecycleStatus, summarizePiAssistantMessage } from "../dist-electron/cli/piTurn.js";

const text = content => ({ kind: "text", role: "assistant", content, append: true });
const thinking = content => ({ kind: "thinking", content, append: true });
const native = (content, stopReason = "stop", errorMessage) => summarizePiAssistantMessage({
  role: "assistant", content, stopReason, errorMessage
});
const malformed = "<thinking>unfinished reasoning</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";

test("versioned Pi lifecycle status validates fields and excludes provider prose", () => {
  const update = status => ({ sessionUpdate: "session_info_update", _meta: { piAcp: { status } } });
  assert.equal(piLifecycleStatus(update({ version: 2, type: "retry", phase: "started" }), true), undefined);
  assert.equal(piLifecycleStatus(update({ version: 1, type: "compaction", phase: "toString" }), true), undefined);
  assert.equal(piLifecycleStatus(update({ version: 1, type: "queue", phase: "succeeded" }), true), undefined);
  assert.deepEqual(piLifecycleStatus(update({ version: 1, type: "retry", phase: "started", attempt: 2, maxAttempts: 3, delayMs: 1500 }), true),
    { kind: "retry-start", message: "上游请求失败，2 秒后重试 (2/3)。" });
  assert.doesNotMatch(piLifecycleStatus(update({ version: 1, type: "retry", phase: "started", delayMs: -1, attempt: "secret", finalError: "secret" }), false).message, /secret|-1/);
  assert.equal(piLifecycleStatus(update({ version: 1, type: "retry", phase: "failed" }), false).kind, "retry-end");
});

test("Pi thinking after a tool cannot reuse earlier progress as the final answer", () => {
  const tracker = new PiTurnTracker();
  tracker.observe([text("I will inspect the branches.")]);
  tracker.observe([], "fetch");
  tracker.observe([thinking("The next step is to inspect the code.")]);
  assert.match(tracker.completionError(undefined, false), /thinking without an answer/);
  tracker.observe([text("Review complete.")]);
  assert.equal(tracker.completionError(undefined, false), undefined);
});

test("Pi completion uses the latest native message, including errors after visible progress", () => {
  const tracker = new PiTurnTracker();
  tracker.observe([text("Checking the PR.")]);
  assert.match(tracker.completionError(native([{ type: "thinking", thinking: "private" }]), false), /thinking without an answer/);
  assert.match(tracker.completionError(native([], "error", "429 free_campaign_global_limit"), true), /429 free_campaign_global_limit/);
  assert.match(tracker.completionError(native([{ type: "text", text: "partial answer" }], "length"), false), /output limit/);
  assert.match(tracker.completionError(native([{ type: "text", text: "partial answer" }], "aborted"), false), /aborted upstream/);
  assert.equal(tracker.completionError(native([{ type: "text", text: "Recovered answer." }]), false), undefined);
});

test("Pi detects the streamed leaked reasoning/protocol footer, preserving documentation examples", () => {
  const tracker = new PiTurnTracker();
  for (const chunk of malformed.match(/.{1,3}|\n/g)) tracker.observe([text(chunk)]);
  assert.match(tracker.completionError(undefined, false), /protocol markers/);
  assert.match(tracker.completionError(native([{ type: "text", text: malformed }]), true), /协议标记/);
  for (const example of ["```xml\n" + malformed + "\n```", "Example: `" + malformed.replaceAll("\n", "") + "`"]) {
    assert.equal(new PiTurnTracker().completionError(native([{ type: "text", text: example }]), false), undefined);
  }
});

test("Pi tool-only completion remains valid and a new prompt discards previous failure state", () => {
  const tracker = new PiTurnTracker();
  assert.match(tracker.completionError(undefined, false), /no answer/);
  tracker.observe([], "tool");
  assert.equal(tracker.completionError(undefined, false), undefined);
  assert.equal(tracker.completionError(native([{ type: "toolCall", id: "tool" }], "toolUse"), false), undefined);
  tracker.observe([thinking("incomplete")]);
  tracker.reset();
  tracker.observe([text("next answer")]);
  assert.equal(tracker.completionError(undefined, false), undefined);
});

test("bridge lifecycle notices are distinguished from user-visible answers and retries do not imply success", () => {
  const update = value => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
  const retry = update("Retrying (attempt 1/3, waiting 2s)...");
  assert.deepEqual(piBridgeStatus(retry, true), { kind: "retry-start", message: "上游请求失败，2 秒后重试（1/3）。" });
  assert.match(piBridgeStatus(update("Retry finished, resuming."), false).message, /checking the result/);
  assert.equal(piBridgeStatus({ ...retry, messageId: "model-message" }, false), undefined);
  assert.equal(piBridgeStatus(update("Example: Retrying (attempt 1/3, waiting 2s)..."), false), undefined);
  const tracker = new PiTurnTracker();
  tracker.observe([text("partial response")]);
  tracker.retrying();
  assert.match(tracker.completionError(undefined, false), /no answer/);
  tracker.observe([text("successful retry")]);
  assert.equal(tracker.completionError(undefined, false), undefined);
});

test("native completion metadata excludes answer and reasoning bodies", () => {
  const result = native([{ type: "text", text: "private answer" }, { type: "thinking", thinking: "private thought" }]);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.equal(result.hasText, true);
  assert.equal(result.hasThinking, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { AcpToolActivityTracker } from "../dist-electron/cli/acpToolActivity.js";

test("tool progress ignores status-only heartbeats and duplicate output", () => {
  const tracker = new AcpToolActivityTracker();
  const update = { sessionUpdate: "tool_call", toolCallId: "command", status: "in_progress" };
  assert.deepEqual(tracker.observe(update, 100), { startedAt: 100, lastProgressAt: 100 });
  assert.equal(tracker.observe({ ...update, sessionUpdate: "tool_call_update" }, 200).lastProgressAt, 100);
  assert.equal(tracker.observe({ ...update, rawOutput: "first" }, 300).lastProgressAt, 300);
  assert.equal(tracker.observe({ ...update, rawOutput: "first" }, 400).lastProgressAt, 300);
  assert.deepEqual(tracker.observe({ ...update, rawOutput: "second" }, 500), { startedAt: 100, lastProgressAt: 500 });
  assert.equal(tracker.observe({ sessionUpdate: "session_info_update", toolCallId: "command" }, 600), undefined);
});

test("client terminal and adapter terminal output update the owning tool, isolated between prompts", () => {
  const tracker = new AcpToolActivityTracker();
  tracker.observe({ sessionUpdate: "tool_call", toolCallId: "command", content: [{ type: "terminal", terminalId: "terminal" }] }, 100);
  assert.deepEqual(tracker.terminalProgress("terminal", 200), { id: "command", startedAt: 100, lastProgressAt: 200 });
  assert.equal(tracker.terminalProgress("unknown", 300), undefined);
  const update = { sessionUpdate: "tool_call_update", toolCallId: "command", _meta: { terminal_output: { data: "line\n" } } };
  assert.equal(tracker.observe(update, 400).lastProgressAt, 400);
  tracker.clear();
  assert.equal(tracker.terminalProgress("terminal", 500), undefined);
  assert.deepEqual(tracker.observe(update, 600), { startedAt: 600, lastProgressAt: 600 });
});

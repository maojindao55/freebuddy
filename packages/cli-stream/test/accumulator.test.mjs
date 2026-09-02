import test from "node:test";
import assert from "node:assert/strict";

import {
  appendItems,
  getParser,
  plainAssistantText
} from "../dist/index.js";

test("shared parser and accumulator preserve the renderer stream fixture result", () => {
  const parser = getParser("codex-json");
  const context = {};
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "agent_message_delta", delta: "Hello " }),
    JSON.stringify({ type: "agent_message_delta", delta: "world" }),
    JSON.stringify({ type: "tool_use", id: "tool-1", name: "apply_patch", arguments: { path: "README.md" } }),
    JSON.stringify({ type: "tool_result", id: "tool-1", name: "apply_patch", output: "Done" }),
    JSON.stringify({ type: "task_complete" })
  ];

  const items = lines.reduce(
    (accumulated, line) => appendItems(accumulated, parser.parseStdoutLine(line, context)),
    []
  );

  assert.deepEqual(items, [
    { kind: "session", sessionId: "thread-1" },
    { kind: "text", role: "assistant", content: "Hello world", append: true },
    {
      kind: "tool-call",
      id: "tool-1",
      tool: "apply_patch",
      input: { path: "README.md" }
    },
    {
      kind: "tool-result",
      id: "tool-1",
      tool: "apply_patch",
      content: "Done",
      isError: false
    },
    { kind: "done" }
  ]);
  assert.equal(plainAssistantText(items), "Hello world");
});

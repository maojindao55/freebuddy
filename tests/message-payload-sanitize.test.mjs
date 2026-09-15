import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_IPC_LIST_MESSAGES_CHARS,
  MAX_IPC_MESSAGE_CONTENT_CHARS,
  sanitizeMessageForIpc,
  sanitizeMessagesForIpc
} from "../dist-electron/cli/messagePayloadSanitize.js";

function message(overrides = {}) {
  return {
    id: "m1",
    conversationId: "c1",
    role: "assistant",
    status: "done",
    content: "[]",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides
  };
}

test("sanitizeMessageForIpc redacts inline base64 media from stored assistant JSON", () => {
  const payload = "A".repeat(80_000);
  const sanitized = sanitizeMessageForIpc(
    message({
      content: JSON.stringify([
        {
          kind: "tool-call",
          id: "tool-1",
          tool: "screenshot",
          input: { huge: payload },
          output: `{"url":"data:image/png;base64,${payload}"}`
        }
      ])
    })
  );

  assert.doesNotMatch(sanitized.content, /data:image\/png;base64,/);
  assert.doesNotMatch(sanitized.content, /"input"/);
  assert.ok(sanitized.content.length < 20_000);
  assert.doesNotThrow(() => structuredClone(sanitized));
});

test("sanitizeMessageForIpc caps oversized assistant text without a data URL", () => {
  const sanitized = sanitizeMessageForIpc(
    message({
      content: JSON.stringify([
        { kind: "text", content: "x".repeat(MAX_IPC_MESSAGE_CONTENT_CHARS + 50_000) }
      ])
    })
  );

  assert.ok(sanitized.content.length <= MAX_IPC_MESSAGE_CONTENT_CHARS);
  assert.match(sanitized.content, /truncated|omitted/i);
  assert.doesNotThrow(() => JSON.parse(sanitized.content));
});

test("sanitizeMessageForIpc caps oversized user text and strips lone surrogates", () => {
  const sanitized = sanitizeMessageForIpc(
    message({
      role: "user",
      status: "sent",
      content: `hello \uD800 world ${"y".repeat(MAX_IPC_MESSAGE_CONTENT_CHARS + 10_000)}`
    })
  );

  assert.equal(sanitized.content.includes("\uD800"), false);
  assert.match(sanitized.content, /hello/);
  assert.ok(sanitized.content.length <= MAX_IPC_MESSAGE_CONTENT_CHARS);
  assert.doesNotThrow(() => structuredClone(sanitized));
});

test("sanitizeMessagesForIpc keeps newest oversized history within the IPC budget", () => {
  const bulky = "z".repeat(MAX_IPC_MESSAGE_CONTENT_CHARS);
  const messages = Array.from({ length: 80 }, (_, index) =>
    message({
      id: `m${index}`,
      role: "user",
      status: "sent",
      content: bulky
    })
  );

  const sanitized = sanitizeMessagesForIpc(messages);
  const total = sanitized.reduce((sum, entry) => sum + entry.content.length, 0);

  assert.equal(sanitized.length, messages.length);
  assert.ok(total <= MAX_IPC_LIST_MESSAGES_CHARS);
  assert.equal(sanitized.at(-1)?.content, bulky);
  assert.notEqual(sanitized[0]?.content, bulky);
  assert.doesNotThrow(() => structuredClone(sanitized));
});

test("small conversation messages pass through unchanged", () => {
  const original = message({
    content: JSON.stringify([{ kind: "text", content: "hi" }])
  });
  assert.deepEqual(sanitizeMessageForIpc(original), original);
});

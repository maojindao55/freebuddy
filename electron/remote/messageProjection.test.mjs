import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { createReadonlyRemoteHost } from "../../dist-electron/remote/readonlyHost.js";
import { projectMessageContent, SnapshotService } from "../../dist-electron/remote/snapshotService.js";
import { appendMessage, createConversation } from "../../dist-electron/cli/conversations.js";
import { migrate, setDbForTest } from "../../dist-electron/cli/db.js";
import { createProject } from "../../dist-electron/cli/projects.js";
import { createUser } from "../../dist-electron/cli/users.js";
import { broadcastEvent } from "../../dist-electron/eventBus.js";

const hostId = "host_projection";
const status = () => ({
  hostId,
  online: true,
  appVersion: "test",
  protocolVersion: 1,
  remoteEnabled: true,
  activeRunCount: 0,
  pendingDecisionCount: 0,
  activeTerminalCount: 0
});

function withStore(run) {
  const database = new Database(":memory:");
  migrate(database);
  setDbForTest(database);
  try {
    const { user } = createUser({ username: "owner", password: "password123", isOwner: true });
    const project = createProject({ name: "Projection", folders: [process.cwd()], primaryPath: process.cwd() });
    createConversation({ id: "conv_projection", title: "Projection", agentId: "agent_projection", agentName: "Agent", adapter: "codex", projectId: project.id, ownerId: user.id });
    return run();
  } finally {
    database.close();
    setDbForTest(null);
  }
}

function addMessage(id, role, content) {
  appendMessage({ id, conversationId: "conv_projection", role, status: "done", content });
}

test("assistant metadata-only streams never become MessageSummary content", () => {
  const projected = projectMessageContent("assistant", JSON.stringify([
    { kind: "session", sessionId: "session_secret_should_not_show" },
    { kind: "config-options", options: [{ id: "apiKey", currentValue: "secret-value" }] },
    { kind: "usage", totalTokens: 42 },
    { kind: "thinking", content: "private chain of thought" }
  ]));
  assert.deepEqual(projected, { content: "", truncated: false });
});

test("assistant projection joins meaningful text, keeps safe error summaries, and hides tool payloads", () => {
  const projected = projectMessageContent("assistant", JSON.stringify([
    { kind: "text", role: "assistant", content: "First answer." },
    { kind: "text", role: "user", content: "must not appear" },
    { kind: "thinking", content: "must not appear" },
    { kind: "tool-result", tool: "read", content: "token=tool-secret" },
    { kind: "text", role: "assistant", content: "Second answer." },
    { kind: "error", message: "api_key=error-secret" }
  ]));
  assert.equal(projected.content, "First answer.\n\nSecond answer.\n\nError: api_key=[redacted]");
  assert.equal(projected.truncated, false);
  assert.doesNotMatch(projected.content, /must not appear|tool-secret|error-secret/);
});

test("legacy text remains readable while malformed or oversized assistant streams fail closed", () => {
  assert.deepEqual(projectMessageContent("assistant", "legacy assistant text"), { content: "legacy assistant text", truncated: false });
  assert.deepEqual(projectMessageContent("user", "legacy user text"), { content: "legacy user text", truncated: false });
  assert.deepEqual(projectMessageContent("system", "legacy system text"), { content: "legacy system text", truncated: false });
  const malformed = projectMessageContent("assistant", '[{"kind":"text","content":"token=malformed-secret"}');
  assert.equal(malformed.content, "");
  assert.equal(malformed.truncated, true);
  const oversized = projectMessageContent("assistant", `[${"x".repeat(256 * 1024)}]`);
  assert.deepEqual(oversized, { content: "", truncated: true });
});

test("message projection redacts bounded local references while preserving normal URLs and relative text", () => {
  const structured = projectMessageContent("assistant", JSON.stringify([
    { kind: "text", role: "assistant", content: "Open /tmp/private-token.txt, ‘/private/项目 文件/密钥.json’, and C:\\Users\\Alice Smith\\secrets\\api.key." },
    { kind: "error", message: "failed at /home/alice/project/config.json: token=error-secret" }
  ]));
  const legacyAssistant = projectMessageContent("assistant", "legacy /var/folders/a/private secret.txt and D:/Work Files/secret.txt");
  const user = projectMessageContent("user", "password=user-secret; user /tmp/user secret.txt");
  const system = projectMessageContent("system", "api_key=system-secret; system /etc/freebuddy/config.json");

  for (const projected of [structured, legacyAssistant, user, system]) {
    assert.doesNotMatch(projected.content, /private-token|项目 文件|Alice Smith|alice\/project|\/var\/folders|D:\/Work Files|\/tmp\/user|\/etc\/freebuddy|error-secret|user-secret|system-secret/);
  }
  assert.match(structured.content, /Error: failed at \[local-path\]/);
  assert.match(user.content, /password=\[redacted\]/);
  assert.match(system.content, /api_key=\[redacted\]/);

  const ordinary = "relative tmp/private-token.txt stays; https://example.test/tmp/private-token.txt stays; /api/v1 stays";
  assert.deepEqual(projectMessageContent("user", ordinary), { content: ordinary, truncated: false });
});

test("message projection redacts local paths independent of surrounding punctuation or encoding", () => {
  const examples = [
    ["file:///Users/Alice/秘密.txt", "[local-path]"],
    ["file:///tmp/秘密.txt", "[local-path]"],
    ["全角连接：/home/用户/项目/秘密.txt；以及 /private/资料/秘密.txt。", "全角连接：[local-path]；以及 [local-path]。"],
    ["prefixC:\\Users\\Alice\\secret.txt suffix", "prefix[local-path] suffix"],
    ["before /tmp/foo-bar_(x).txt after", "before [local-path] after"],
    ["file%3A%2F%2F%2FUsers%2FAlice%2Fsecret.txt", "[local-path]"]
  ];

  for (const [example, expected] of examples) {
    const projected = projectMessageContent("user", example);
    assert.equal(projected.content, expected, `unexpected projection for ${example}`);
    assert.match(projected.content, /\[local-path\]/, example);
    assert.doesNotMatch(projected.content, /Alice|秘密|\/home\/用户|\/private\/资料|foo-bar_|secret\.txt/i, example);
  }

  assert.deepEqual(
    projectMessageContent("user", "relative C:notes.txt, tmp/秘密.txt, /api/v1, and https://example.test/tmp/秘密.txt"),
    { content: "relative C:notes.txt, tmp/秘密.txt, /api/v1, and https://example.test/tmp/秘密.txt", truncated: false }
  );
});

test("message projection redacts bounded UNC references for every projected message form", () => {
  const unc = "\\\\server\\共享 资料\\密钥_(v1).txt";
  const forwardSlashUnc = "//server/share/秘密 文件_(v1).txt";
  const assistant = projectMessageContent("assistant", JSON.stringify([
    { kind: "text", role: "assistant", content: `assistant ${unc}；` },
    { kind: "error", message: `failed at ${unc}` }
  ]));
  const user = projectMessageContent("user", `user ${unc}； ${forwardSlashUnc}。`);
  const system = projectMessageContent("system", `system ${unc}。`);

  assert.equal(assistant.content, "assistant [local-path]；\n\nError: failed at [local-path]");
  assert.equal(user.content, "user [local-path]； [local-path]。");
  assert.equal(system.content, "system [local-path]。");
  for (const projected of [assistant, user, system]) {
    assert.doesNotMatch(projected.content, /server|共享 资料|密钥_|秘密 文件|v1/);
  }
  assert.deepEqual(
    projectMessageContent("user", "https://example.test//server/share/秘密 文件_(v1).txt stays"),
    { content: "https://example.test//server/share/秘密 文件_(v1).txt stays", truncated: false }
  );
});

test("message summaries remain within the protocol 32 KiB chunk limit", () => {
  const projected = projectMessageContent("assistant", JSON.stringify([
    { kind: "text", role: "assistant", content: "你".repeat(20_000) }
  ]));
  assert.ok(Buffer.byteLength(projected.content) <= 32_768);
  assert.equal(projected.truncated, true);
  assert.doesNotMatch(projected.content, /^\[/);
});

test("message.list, SnapshotService reads, and live message.updated events share the projection", () => withStore(() => {
  const unc = "\\\\server\\share\\秘密 文件_(v1).txt";
  const stream = JSON.stringify([
    { kind: "session", sessionId: "session_hidden" },
    { kind: "text", role: "assistant", content: `remote-safe text from /tmp/private-token.txt, file%3A%2F%2F%2FUsers%2FAlice%2Fsecret.txt, and ${unc}` },
    { kind: "thinking", content: "hidden thought" }
  ]);
  addMessage("message_projection", "assistant", stream);
  const snapshots = new SnapshotService(status, () => 0);
  assert.equal(snapshots.messages("conv_projection")[0].content, "remote-safe text from [local-path], [local-path], and [local-path]");

  const host = createReadonlyRemoteHost({ hostId, status });
  const sent = [];
  const detach = host.attachEvents({ send: frame => { sent.push(frame); return true; } });
  try {
    broadcastEvent("messages://changed", { conversationId: "conv_projection" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.name, "message.updated");
    assert.equal(sent[0].payload.data.content, "remote-safe text from [local-path], [local-path], and [local-path]");
    assert.doesNotMatch(sent[0].payload.data.content, /session_hidden|hidden thought|private-token|Alice|secret\.txt|server|秘密 文件|v1/);
  } finally {
    detach();
  }
}));

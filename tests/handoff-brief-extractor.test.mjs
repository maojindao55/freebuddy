import "./fixtures/electron-stub.mjs";  // must be first — see Task 3
import test from "node:test";
import assert from "node:assert/strict";
import { extractHandoffBrief } from "../dist-electron/cli/handoffBriefExtractor.js";

const conv = (extra = {}) => ({
  id: "C1", title: "T", agentId: "A", agentName: "Codex", adapter: "codex",
  cwd: "/w", archived: false, createdAt: "0", updatedAt: "0", ...extra
});

const userMsg = (id, content, createdAt = "0") => ({
  id, conversationId: "C1", role: "user", status: "done",
  content, createdAt, updatedAt: createdAt
});

const assistantMsg = (id, items, createdAt = "0", status = "done") => ({
  id, conversationId: "C1", role: "assistant", status,
  content: JSON.stringify(items), createdAt, updatedAt: createdAt
});

test("originalGoal: first user message, trimmed + capped 2000", () => {
  const long = "x".repeat(3000);
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [userMsg("u1", long), assistantMsg("a1", [{ kind: "text", role: "assistant", content: "ok" }])]
  });
  assert.equal(brief.originalGoal.length, 2000);
  assert.equal(brief.originalGoal, "x".repeat(2000));
});

test("originalGoal: no user messages -> empty string", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [assistantMsg("a1", [{ kind: "text", role: "assistant", content: "ok" }])]
  });
  assert.equal(brief.originalGoal, "");
});

test("recentUserMessages: last 3 user msgs, excludes the first when count > 3", () => {
  const msgs = [
    userMsg("u1", "first"),               // originalGoal
    assistantMsg("a1", [{ kind: "text", role: "assistant", content: "r1" }]),
    userMsg("u2", "second"),
    assistantMsg("a2", [{ kind: "text", role: "assistant", content: "r2" }]),
    userMsg("u3", "third"),
    userMsg("u4", "fourth"),
    userMsg("u5", "fifth")
  ];
  const brief = extractHandoffBrief({ conversation: conv(), messages: msgs });
  assert.deepEqual(brief.recentUserMessages, ["third", "fourth", "fifth"]);
});

test("lastAssistantSummary: concat text items from last assistant, capped 2000", () => {
  const long = "y".repeat(1995);
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [
        { kind: "text", role: "assistant", content: long },
        { kind: "thinking", content: "private" },
        { kind: "text", role: "assistant", content: " tail" }
      ])
    ]
  });
  assert.equal(brief.lastAssistantSummary.length, 2000);
  assert.ok(brief.lastAssistantSummary.startsWith("y".repeat(1995)));
  assert.ok(brief.lastAssistantSummary.endsWith(" tail".slice(0, 5)));
});

test("lastAssistantSummary: empty when last assistant has no text items", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [{ kind: "file-edit", path: "/a", action: "update" }])
    ]
  });
  assert.equal(brief.lastAssistantSummary, "");
});

test("fileChanges: from file-edit items", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [
        { kind: "file-edit", path: "/src/a.ts", action: "create" },
        { kind: "file-edit", path: "/src/b.ts", action: "update" }
      ])
    ]
  });
  assert.equal(brief.fileChanges.length, 2);
  assert.equal(brief.fileChanges[0].path, "/src/b.ts");  // 倒序，最近改动排前
  assert.equal(brief.fileChanges[1].path, "/src/a.ts");
});

test("fileChanges: from tool-call items (toolKind whitelist + tool name whitelist)", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [
        { kind: "tool-call", tool: "apply_patch", toolKind: "edit",
          locations: [{ path: "/p1" }] },
        { kind: "tool-call", tool: "custom_thing", toolKind: "read",
          locations: [{ path: "/p2" }] },
        { kind: "tool-call", tool: "create_file", toolKind: "other",
          locations: [{ path: "/p3" }] }
      ])
    ]
  });
  const paths = brief.fileChanges.map((c) => c.path);
  assert.ok(paths.includes("/p1"));
  assert.ok(paths.includes("/p2"));
  assert.ok(paths.includes("/p3"));
});

test("fileChanges: dedupe by path, later write wins; read never overwrites edit", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [{ kind: "file-edit", path: "/x", action: "update" }]),
      assistantMsg("a2", [{ kind: "tool-call", tool: "read_file", toolKind: "read", locations: [{ path: "/x" }] }])
    ]
  });
  const x = brief.fileChanges.find((c) => c.path === "/x");
  assert.equal(x.action, "edit");  // read 没覆盖
});

test("fileChanges: cap 50, non-read priority", () => {
  const items = [];
  for (let i = 0; i < 60; i++) {
    items.push({ kind: "tool-call", tool: "read_file", toolKind: "read", locations: [{ path: `/r${i}` }] });
  }
  for (let i = 0; i < 30; i++) {
    items.push({ kind: "file-edit", path: `/e${i}.ts`, action: "update" });
  }
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [userMsg("u1", "go"), assistantMsg("a1", items)]
  });
  assert.equal(brief.fileChanges.length, 50);
  // 30 个 edit 全部保留 + 20 个 read（最近优先）
  const edits = brief.fileChanges.filter((c) => c.action === "edit");
  assert.equal(edits.length, 30);
});

test("fileChanges: skip empty/non-string path", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [
        { kind: "file-edit", path: "", action: "update" },
        { kind: "file-edit", path: 123, action: "update" },
        { kind: "file-edit", path: "/ok", action: "update" }
      ])
    ]
  });
  assert.equal(brief.fileChanges.length, 1);
  assert.equal(brief.fileChanges[0].path, "/ok");
});

test("transcriptExcerpts: last 8 msgs, user→content capped 800, assistant→text capped 800", () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(userMsg(`u${i}`, `user-${i}`));
    msgs.push(assistantMsg(`a${i}`, [{ kind: "text", role: "assistant", content: `assistant-${i}` }]));
  }
  const brief = extractHandoffBrief({ conversation: conv(), messages: msgs });
  assert.equal(brief.transcriptExcerpts.length, 8);
  assert.equal(brief.transcriptExcerpts[0].messageId, "u6");  // 末尾倒推 8 条，首条是 u6
});

test("transcriptExcerpts: assistant with no text -> '(tool calls only)'", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [{ kind: "file-edit", path: "/x", action: "update" }])
    ]
  });
  assert.equal(brief.transcriptExcerpts.length, 2);
  const aExcerpt = brief.transcriptExcerpts.find((e) => e.role === "assistant");
  assert.equal(aExcerpt.excerpt, "(tool calls only)");
});

test("0 messages -> all empty fields, does not throw", () => {
  const brief = extractHandoffBrief({ conversation: conv(), messages: [] });
  assert.equal(brief.originalGoal, "");
  assert.equal(brief.recentUserMessages.length, 0);
  assert.equal(brief.fileChanges.length, 0);
  assert.equal(brief.transcriptExcerpts.length, 0);
  assert.equal(brief.source.messageCount, 0);
});

test("malformed content JSON -> skip that message, do not throw", () => {
  const badMsg = { ...userMsg("u1", "go"), role: "assistant", content: "{not json" };
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [badMsg, assistantMsg("a1", [{ kind: "text", role: "assistant", content: "ok" }])]
  });
  assert.equal(brief.lastAssistantSummary, "ok");  // 仅 a1 被处理
});

test('status="running" assistant -> content not parsed, transcriptExcerpt says "(streaming)"', () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [{ kind: "text", role: "assistant", content: "should be ignored" }], "1", "running")
    ]
  });
  assert.equal(brief.lastAssistantSummary, "");
  assert.equal(brief.transcriptExcerpts.find((e) => e.role === "assistant").excerpt, "(streaming)");
});

test("source metadata correctly populated", () => {
  const brief = extractHandoffBrief({
    conversation: conv({ id: "X", title: "My Task", agentId: "A1", agentName: "Claude", adapter: "claude", cwd: "/path" }),
    messages: [userMsg("u1", "go")]
  });
  assert.equal(brief.source.conversationId, "X");
  assert.equal(brief.source.title, "My Task");
  assert.equal(brief.source.agentName, "Claude");
  assert.equal(brief.source.adapter, "claude");
  assert.equal(brief.source.cwd, "/path");
  assert.equal(brief.source.messageCount, 1);
});

test("64 KB trim order: transcriptExcerpts -> fileChanges -> recentUserMessages -> lastAssistantSummary -> originalGoal", () => {
  // 构造一个超大 brief
  const huge = "z".repeat(10000);
  const msgs = [];
  msgs.push(userMsg("u1", huge));  // originalGoal 巨大
  for (let i = 0; i < 20; i++) {
    msgs.push(userMsg(`u${i + 2}`, huge));
    msgs.push(assistantMsg(`a${i + 1}`, [
      { kind: "text", role: "assistant", content: huge },
      { kind: "file-edit", path: `/f${i}.ts`, action: "update" }
    ]));
  }
  const brief = extractHandoffBrief({ conversation: conv(), messages: msgs });
  const size = Buffer.byteLength(JSON.stringify(brief), "utf8");
  assert.ok(size <= 64 * 1024, `brief size ${size} exceeds 64KB`);
});

test("64 KB limit measures UTF-8 bytes and trims oversized multibyte paths", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    kind: "file-edit",
    path: `/${"汉".repeat(3000)}-${i}`,
    action: "update"
  }));
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [userMsg("u1", "go"), assistantMsg("a1", items)]
  });
  const size = Buffer.byteLength(JSON.stringify(brief), "utf8");
  assert.ok(size <= 64 * 1024, `brief size ${size} exceeds 64KB`);
  assert.ok(brief.fileChanges.length < 10);
});

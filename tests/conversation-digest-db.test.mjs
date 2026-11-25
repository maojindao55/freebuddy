import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

const isoAt = (second) =>
  `2026-10-05T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;

async function fixture(t) {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable; run with the Electron test runner");
    return null;
  }
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);

  const conversationsMod = await import("../dist-electron/cli/conversations.js");
  const providersMod = await import("../dist-electron/cli/providers.js");
  const callerMod = await import("../dist-electron/cli/callerContext.js");
  const digestMod = await import("../dist-electron/cli/conversationDigest.js");
  const llmMod = await import("../dist-electron/cli/conversationDigestLlm.js");

  t.after(() => {
    digestMod.setDigestFetchForTest(null);
    digestMod.setDigestDebounceMsForTest(null);
    llmMod.setDigestTimeoutMsForTest(null);
    digestMod.shutdownConversationDigest();
    conversationsMod.bindConversationTurnFinishedNotifier(null);
    conversationsMod.bindConversationDeletedNotifier(null);
    setDbForTest(null);
    db.close();
  });

  const insertConv = (id, options = {}) => {
    db.prepare(
      `INSERT INTO conversations
         (id, title, agent_id, agent_name, adapter, cwd, owner_id, archived, created_at, updated_at)
       VALUES (?, ?, 'cli-codex-acp', 'Codex', 'codex-acp', ?, ?, ?, ?, ?)`
    ).run(
      id,
      options.title ?? id,
      options.cwd ?? "/repo/app",
      options.owner ?? "alice",
      options.archived ? 1 : 0,
      isoAt(options.second ?? 0),
      isoAt(options.second ?? 0)
    );
  };

  const insertMsg = (id, conversationId, role, second, options = {}) => {
    const content =
      typeof options.content === "string"
        ? options.content
        : JSON.stringify(options.content ?? []);
    db.prepare(
      `INSERT INTO conversation_messages
         (id, conversation_id, role, status, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      conversationId,
      role,
      options.status ?? "done",
      content,
      isoAt(second),
      isoAt(second)
    );
  };

  return {
    db,
    insertConv,
    insertMsg,
    ...conversationsMod,
    ...providersMod,
    ...callerMod,
    ...digestMod,
    ...llmMod
  };
}

test("Layer 0 extracts turns, strips base64, captures file edits, and excludes thinking/stdout/patches", async (t) => {
  const f = await fixture(t);
  if (!f) return;

  f.insertConv("conv-1", { title: "Main chat" });
  f.insertMsg(
    "u1",
    "conv-1",
    "user",
    1,
    {
      content:
        "Add dark mode toggle\nSee screenshot data:image/png;base64,AAAA1234BBBB=="
    }
  );
  f.insertMsg("a1", "conv-1", "assistant", 2, {
    status: "done",
    content: [
      { kind: "thinking", content: "PRIVATE_THINKING" },
      { kind: "command-output", content: "PRIVATE_STDOUT" },
      { kind: "tool-result", id: "t1", content: "PRIVATE_TOOL_RESULT" },
      { kind: "file-edit", path: "/repo/app/src/theme.ts", action: "update", patch: "PRIVATE_PATCH" },
      { kind: "tool-call", id: "c1", tool: "edit_file", toolKind: "edit", locations: [{ path: "/repo/app/styles.css" }] },
      { kind: "text", role: "assistant", content: "Added dark mode toggle and updated theme styles." }
    ]
  });
  f.insertMsg("u2", "conv-1", "user", 3, {
    content: "Fix OAuth 401 callback error"
  });
  f.insertMsg("a2", "conv-1", "assistant", 4, {
    status: "failed",
    content: [{ kind: "error", message: "OAuth token exchange returned 401" }]
  });

  const digest = f.runAsCaller("alice", () => f.getConversationDigest("conv-1"));
  assert.ok(digest);
  assert.equal(digest.source, "rule");
  assert.equal(digest.topicCount, 2);
  assert.equal(digest.topics[0].title, "Add dark mode toggle");
  assert.equal(digest.topics[0].status, "done");
  assert.equal(digest.topics[0].startMessageId, "u1");
  assert.equal(digest.topics[0].endMessageId, "a1");
  assert.deepEqual(digest.topics[0].files, [
    "/repo/app/src/theme.ts",
    "/repo/app/styles.css"
  ]);
  assert.equal(digest.topics[1].status, "blocked");
  assert.equal(digest.topics[1].startMessageId, "u2");

  const serialized = JSON.stringify(digest);
  assert.ok(!serialized.includes("PRIVATE_THINKING"));
  assert.ok(!serialized.includes("PRIVATE_STDOUT"));
  assert.ok(!serialized.includes("PRIVATE_TOOL_RESULT"));
  assert.ok(!serialized.includes("PRIVATE_PATCH"));
  assert.ok(!serialized.includes("AAAA1234BBBB"));
});

test("Layer 1 supports all 4 provider protocols, incremental merge, and sanitizes hallucinated messageIds", async (t) => {
  const f = await fixture(t);
  if (!f) return;

  f.insertConv("conv-llm", { title: "Multi-req session" });
  f.insertMsg("u1", "conv-llm", "user", 1, { content: "Build login page" });
  f.insertMsg("a1", "conv-llm", "assistant", 2, {
    status: "done",
    content: [
      { kind: "file-edit", path: "/repo/login.tsx", action: "create" },
      { kind: "text", role: "assistant", content: "Created login form." }
    ]
  });
  f.insertMsg("u2", "conv-llm", "user", 3, { content: "Make login button wider" });
  f.insertMsg("a2", "conv-llm", "assistant", 4, {
    status: "done",
    content: [{ kind: "text", role: "assistant", content: "Widened button." }]
  });

  const protocols = [
    {
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      expectedUrl: "https://api.example.com/v1/chat/completions",
      buildResponse: (payload) => ({ choices: [{ message: { content: JSON.stringify(payload) } }] })
    },
    {
      protocol: "openai-responses",
      baseUrl: "https://api.example.com",
      expectedUrl: "https://api.example.com/v1/responses",
      buildResponse: (payload) => ({ output_text: JSON.stringify(payload) })
    },
    {
      protocol: "anthropic",
      baseUrl: "https://claude.example.com",
      expectedUrl: "https://claude.example.com/v1/messages",
      buildResponse: (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })
    },
    {
      protocol: "deepseek",
      baseUrl: "https://ds.example.com",
      expectedUrl: "https://ds.example.com/v1/chat/completions",
      buildResponse: (payload) => ({ choices: [{ message: { content: JSON.stringify(payload) } }] })
    }
  ];

  let firstTopicId = "";

  for (const spec of protocols) {
    const provider = f.upsertProvider({
      name: `P-${spec.protocol}`,
      protocol: spec.protocol,
      baseUrl: spec.baseUrl,
      ...(spec.protocol === "anthropic" ? { anthropicBaseUrl: spec.baseUrl } : {}),
      apiKey: "sk-test-123456",
      models: [{ id: "test-mini" }]
    });
    f.setConversationDigestConfig({
      enabled: true,
      providerId: provider.id,
      model: "test-mini",
      minUserTurns: 2
    });

    let seenUrl = "";
    let seenHeaders = {};
    let seenBody = {};
    f.setDigestFetchForTest(async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init?.headers ?? {};
      seenBody = JSON.parse(String(init?.body ?? "{}"));
      const llmPayload = {
        overallSummary: "Login UI built and refined",
        topics: [
          {
            id: "new-1",
            title: "Login page & button polish",
            summary: "Built login form and adjusted button width.",
            status: "done",
            startMessageId: "u1",
            endMessageId: "hallucinated-msg-id",
            turnCount: 2,
            keywords: ["login", "css"],
            files: ["/repo/login.tsx"]
          }
        ]
      };
      return new Response(JSON.stringify(spec.buildResponse(llmPayload)), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const digest = await f.runConversationDigestNow("conv-llm", { forceRebuild: true });
    assert.ok(digest);
    assert.equal(seenUrl, spec.expectedUrl);
    assert.equal(seenBody.stream, true);
    if (spec.protocol === "anthropic") {
      assert.equal(seenHeaders["x-api-key"], "sk-test-123456");
      assert.equal(seenBody.max_tokens, 8192);
    } else {
      assert.equal(seenHeaders.Authorization, "Bearer sk-test-123456");
      assert.equal("max_tokens" in seenBody, false);
      assert.equal("max_output_tokens" in seenBody, false);
    }
    assert.equal(digest.source, "llm");
    assert.equal(digest.topics.length, 1);
    assert.equal(digest.topics[0].startMessageId, "u1");
    // Hallucinated endMessageId must be sanitized back to a real conversation messageId
    assert.equal(digest.topics[0].endMessageId, "a2");
    firstTopicId = digest.topics[0].id;
  }

  // Incremental update: add Turn 3 and verify delta prompt receives existing topic
  f.insertMsg("u3", "conv-llm", "user", 5, { content: "Add CSV export" });
  f.insertMsg("a3", "conv-llm", "assistant", 6, {
    status: "done",
    content: [{ kind: "text", role: "assistant", content: "Export ready." }]
  });

  let capturedPromptBody = null;
  f.setDigestFetchForTest(async (_url, init) => {
    capturedPromptBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overallSummary: "Login UI + CSV export",
                topics: [
                  {
                    id: firstTopicId,
                    title: "Login page & button polish",
                    summary: "Built login form and adjusted button width.",
                    status: "done",
                    startMessageId: "u1",
                    endMessageId: "a2",
                    turnCount: 2,
                    keywords: ["login"],
                    files: ["/repo/login.tsx"]
                  },
                  {
                    id: "new-2",
                    title: "CSV export feature",
                    summary: "Implemented CSV download button.",
                    status: "done",
                    startMessageId: "u3",
                    endMessageId: "a3",
                    turnCount: 1,
                    keywords: ["csv", "export"],
                    files: ["/repo/export.ts"]
                  }
                ]
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const updated = await f.runConversationDigestNow("conv-llm");
  assert.ok(updated);
  assert.equal(updated.topics.length, 2);
  assert.equal(updated.topics[0].id, firstTopicId);
  assert.equal(updated.topics[1].startMessageId, "u3");
  const userContent = JSON.parse(capturedPromptBody.messages[1].content);
  assert.equal(userContent.existingTopics.length, 1);
  assert.equal(userContent.newTurns.length, 1);
  assert.equal(userContent.newTurns[0].userMessageId, "u3");

  // Hybrid read: a fresh Turn 4 appears immediately as trailing Layer 0 topic before LLM catches up
  f.insertMsg("u4", "conv-llm", "user", 7, { content: "Add dark theme" });
  const hybrid = f.runAsCaller("alice", () => f.getConversationDigest("conv-llm"));
  assert.equal(hybrid.source, "llm");
  assert.equal(hybrid.topics.length, 3);
  assert.equal(hybrid.topics[2].source, "rule");
  assert.equal(hybrid.topics[2].startMessageId, "u4");
});

test("Cross-session search, owner isolation, around-message window, and conversation deletion", async (t) => {
  const f = await fixture(t);
  if (!f) return;

  f.insertConv("alice-llm", { title: "Work session", owner: "alice" });
  f.insertMsg("au1", "alice-llm", "user", 1, { content: "Fix billing export" });
  f.insertMsg("aa1", "alice-llm", "assistant", 2, {
    status: "done",
    content: [{ kind: "text", role: "assistant", content: "Fixed CSV headers." }]
  });

  f.insertConv("alice-rule", { title: "Quick ask", owner: "alice" });
  f.insertMsg("aru1", "alice-rule", "user", 3, { content: "Check postgres timeout" });
  f.insertMsg("ara1", "alice-rule", "assistant", 4, {
    status: "done",
    content: [{ kind: "text", role: "assistant", content: "Increased pool timeout." }]
  });

  f.insertConv("alice-archived", { title: "Old chat", owner: "alice", archived: true });
  f.insertMsg("aau1", "alice-archived", "user", 5, { content: "Archived billing task" });

  f.insertConv("bob-private", { title: "Bob secret", owner: "bob" });
  f.insertMsg("bu1", "bob-private", "user", 6, { content: "Secret billing payroll" });

  // Persist an LLM topic for alice-llm
  const provider = f.upsertProvider({
    name: "SearchMock",
    protocol: "openai-chat",
    baseUrl: "https://api.example.com",
    apiKey: "sk-search-1234",
    models: [{ id: "gpt-4o-mini" }]
  });
  f.setConversationDigestConfig({ enabled: true, providerId: provider.id, minUserTurns: 1 });
  f.setDigestFetchForTest(async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overallSummary: "Billing export fixed",
                topics: [
                  {
                    id: "new-1",
                    title: "Invoice CSV export",
                    summary: "Resolved UTF-8 BOM billing header issue.",
                    status: "done",
                    startMessageId: "au1",
                    endMessageId: "aa1",
                    turnCount: 1,
                    keywords: ["billing", "csv", "bom"],
                    files: ["/repo/invoice.ts"]
                  }
                ]
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
  await f.runConversationDigestNow("alice-llm", { forceRebuild: true });

  // Alice finds her LLM topic by keyword ("bom") and her unsummarized rule turn ("postgres"), never Bob's or archived
  const billingHits = f.runAsCaller("alice", () =>
    f.searchConversationTopics({ query: "billing" })
  );
  assert.deepEqual(billingHits.map((h) => h.conversationId), ["alice-llm"]);
  assert.equal(billingHits[0].startMessageId, "au1");

  const bomHits = f.runAsCaller("alice", () =>
    f.searchConversationTopics({ query: "bom" })
  );
  assert.equal(bomHits.length, 1);
  assert.equal(bomHits[0].source, "llm");

  const postgresHits = f.runAsCaller("alice", () =>
    f.searchConversationTopics({ query: "postgres" })
  );
  assert.equal(postgresHits.length, 1);
  assert.equal(postgresHits[0].source, "rule");
  assert.equal(postgresHits[0].startMessageId, "aru1");

  // Archived included only when explicitly requested
  const withArchived = f.runAsCaller("alice", () =>
    f.searchConversationTopics({ query: "billing", includeArchived: true })
  );
  assert.equal(withArchived.length, 2);

  // Owner isolation: Alice cannot read Bob's digest, Admin can
  assert.equal(
    f.runAsCaller("alice", () => f.getConversationDigest("bob-private")),
    null
  );
  const adminHits = f.runAsCaller(
    "admin",
    () => f.searchConversationTopics({ query: "billing" }),
    true
  );
  assert.ok(adminHits.some((h) => h.conversationId === "bob-private"));

  // listMessagesAroundForIpc loads target older message + surrounding context
  f.insertConv("long-conv", { title: "Long" });
  for (let i = 1; i <= 30; i += 1) {
    f.insertMsg(`lm-${i}`, "long-conv", i % 2 === 1 ? "user" : "assistant", i + 10, {
      content: i % 2 === 1 ? `Question ${i}` : [{ kind: "text", role: "assistant", content: `Answer ${i}` }]
    });
  }
  const around = f.listMessagesAroundForIpc("long-conv", "lm-15");
  assert.equal(around.hasMore, true);
  assert.ok(around.messages.some((m) => m.id === "lm-15"));
  assert.ok(around.messages.some((m) => m.id === "lm-30"));
  assert.ok(around.messages.some((m) => m.id === "lm-3"));

  // updateMessage terminal status fires turn-finished notifier
  const notified = [];
  f.bindConversationTurnFinishedNotifier((cid) => notified.push(cid));
  f.insertMsg("live-a", "alice-rule", "assistant", 99, { status: "running", content: "[]" });
  f.updateMessage({ id: "live-a", status: "done", content: JSON.stringify([{ kind: "text", role: "assistant", content: "done" }]) });
  assert.deepEqual(notified, ["alice-rule"]);

  // deleteConversation cleans up digest state & topics
  f.deleteConversation("alice-llm");
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS cnt FROM conversation_topics WHERE conversation_id = 'alice-llm'").get().cnt,
    0
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS cnt FROM conversation_digest_state WHERE conversation_id = 'alice-llm'").get().cnt,
    0
  );
});

test("openai-responses 404 HTML fallback to chat/completions and versioned baseUrl handling", async (t) => {
  const f = await fixture(t);
  if (!f) return;

  f.insertConv("conv-relay", { title: "Relay test" });
  f.insertMsg("ru1", "conv-relay", "user", 1, { content: "Check relay fallback" });
  f.insertMsg("ra1", "conv-relay", "assistant", 2, {
    status: "done",
    content: [{ kind: "text", role: "assistant", content: "Done." }]
  });

  const respProvider = f.upsertProvider({
    name: "SenseAudioRelay",
    protocol: "openai-responses",
    protocols: ["openai-responses"],
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-relay-1234",
    models: [{ id: "deepseek-v4.1-flash" }]
  });
  f.setConversationDigestConfig({
    enabled: true,
    providerId: respProvider.id,
    model: "",
    minUserTurns: 1
  });

  const requestedUrls = [];
  f.setDigestFetchForTest(async (url) => {
    const u = String(url);
    requestedUrls.push(u);
    if (u.endsWith("/responses")) {
      return new Response(
        "<html><head><title>404 Not Found</title></head><body><center>nginx</center></body></html>",
        { status: 404, headers: { "Content-Type": "text/html" } }
      );
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overallSummary: "Relay fallback ok",
                topics: [
                  {
                    id: "new-1",
                    title: "Relay fallback check",
                    summary: "Succeeded via /chat/completions.",
                    status: "done",
                    startMessageId: "ru1",
                    endMessageId: "ra1",
                    turnCount: 1,
                    keywords: ["relay"],
                    files: []
                  }
                ]
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const digest = await f.runConversationDigestNow("conv-relay", { forceRebuild: true });
  assert.ok(digest);
  assert.equal(digest.source, "llm");
  assert.deepEqual(requestedUrls, [
    "https://relay.example.com/v1/responses",
    "https://relay.example.com/v1/chat/completions"
  ]);

  const v2Provider = f.upsertProvider({
    name: "QianfanV2",
    protocol: "openai-chat",
    protocols: ["openai-chat"],
    baseUrl: "https://qianfan.example.com/v2/tokenplan/personal",
    apiKey: "sk-v2-1234",
    models: [{ id: "ernie-5.5-flash" }]
  });
  f.setConversationDigestConfig({
    enabled: true,
    providerId: v2Provider.id,
    model: "",
    minUserTurns: 1
  });

  const v2Urls = [];
  f.setDigestFetchForTest(async (url) => {
    v2Urls.push(String(url));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overallSummary: "V2 ok",
                topics: [
                  {
                    id: "new-1",
                    title: "Versioned endpoint",
                    summary: "No bogus /v1 appended.",
                    status: "done",
                    startMessageId: "ru1",
                    endMessageId: "ra1",
                    turnCount: 1,
                    keywords: ["v2"],
                    files: []
                  }
                ]
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const v2Digest = await f.runConversationDigestNow("conv-relay", { forceRebuild: true });
  assert.ok(v2Digest);
  assert.deepEqual(v2Urls, [
    "https://qianfan.example.com/v2/tokenplan/personal/chat/completions"
  ]);
});

test("Auto-mode falls back across enabled providers and strips raw HTML from errors", async (t) => {
  const f = await fixture(t);
  if (!f) return;

  f.insertConv("conv-auto", { title: "Auto fallback" });
  f.insertMsg("au1", "conv-auto", "user", 1, { content: "Summarize across providers" });
  f.insertMsg("aa1", "conv-auto", "assistant", 2, {
    status: "done",
    content: [{ kind: "text", role: "assistant", content: "OK." }]
  });

  f.upsertProvider({
    name: "PrimaryFail",
    protocol: "openai-chat",
    protocols: ["openai-chat"],
    baseUrl: "https://primary.example.com/v1",
    apiKey: "sk-primary-1234",
    position: 10,
    models: [{ id: "m1" }]
  });
  f.upsertProvider({
    name: "BackupOk",
    protocol: "openai-chat",
    protocols: ["openai-chat"],
    baseUrl: "https://backup.example.com/v1",
    apiKey: "sk-backup-1234",
    position: 20,
    models: [{ id: "m2" }]
  });
  f.setConversationDigestConfig({
    enabled: true,
    providerId: "",
    model: "",
    minUserTurns: 1
  });

  const hitHosts = [];
  f.setDigestFetchForTest(async (url) => {
    const u = String(url);
    hitHosts.push(new URL(u).host);
    if (u.includes("primary.example.com")) {
      return new Response("<html><head><title>502 Bad Gateway</title></head><body>upstream</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" }
      });
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overallSummary: "Backup provider succeeded",
                topics: [
                  {
                    id: "new-1",
                    title: "Fallback provider test",
                    summary: "Recovered using backup provider.",
                    status: "done",
                    startMessageId: "au1",
                    endMessageId: "aa1",
                    turnCount: 1,
                    keywords: ["fallback"],
                    files: []
                  }
                ]
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const recovered = await f.runConversationDigestNow("conv-auto", { forceRebuild: true });
  assert.ok(recovered);
  assert.equal(recovered.source, "llm");
  assert.deepEqual(hitHosts, ["primary.example.com", "backup.example.com"]);

  // If every provider returns HTML 404, stored error strips raw HTML markup cleanly.
  f.setDigestFetchForTest(async () =>
    new Response(
      "<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center>nginx</center>\n</body>\n</html>",
      { status: 404, headers: { "Content-Type": "text/html" } }
    )
  );
  const failed = await f.runConversationDigestNow("conv-auto", { forceRebuild: true });
  assert.equal(failed, null);
  const persisted = f.runAsCaller("alice", () => f.getConversationDigest("conv-auto"));
  assert.ok(persisted);
  assert.equal(persisted.status, "error");
  assert.equal(persisted.error, "Digest upstream HTTP 404: 404 Not Found");
  assert.ok(!persisted.error.includes("<html") && !persisted.error.includes("<body>"));
});

test("Layer 0 strips markdown links/formatting and recovers stale running/queued DB status", async (t) => {
  const f = await fixture(t);
  if (!f) return;

  f.insertConv("conv-md", { title: "Markdown preview cleanup" });
  f.insertMsg("mu1", "conv-md", "user", 1, {
    content: "Update **`test-diff.txt`** via [file link](file:///Users/demo/test-diff.txt)"
  });
  f.insertMsg("ma1", "conv-md", "assistant", 2, {
    status: "done",
    content: [
      {
        kind: "text",
        role: "assistant",
        content: "已更新 [test-diff.txt](file:///Users/hongbin9/www/demo/test-diff.txt) 中的文本。"
      }
    ]
  });

  // Simulate stale 'running' state left behind after an ungraceful shutdown.
  f.db
    .prepare(
      `INSERT INTO conversation_digest_state
         (conversation_id, source, status, last_message_seq, updated_at)
       VALUES ('conv-md', 'rule', 'running', 0, '2026-10-05T00:00:00.000Z')`
    )
    .run();

  const ruleDigest = f.runAsCaller("alice", () => f.getConversationDigest("conv-md"));
  assert.ok(ruleDigest);
  assert.equal(ruleDigest.status, "idle", "stale rule 'running' recovers to idle when no active job exists");
  assert.equal(ruleDigest.topics[0].title, "Update test-diff.txt via file link");
  assert.equal(ruleDigest.topics[0].summary, "已更新 test-diff.txt 中的文本。");
  assert.ok(!ruleDigest.topics[0].summary.includes("file:///"));

  // Same stale 'running' recovery for persisted 'llm' topics -> recovers to 'ready'.
  f.db
    .prepare(
      `INSERT INTO conversation_topics
         (id, conversation_id, sort_order, title, summary, status, source,
          start_message_id, end_message_id, turn_count, keywords_json, files_json,
          created_at, updated_at)
       VALUES ('topic-md-1', 'conv-md', 0, '更新 test-diff.txt', '已更新。', 'done', 'llm',
               'mu1', 'ma1', 1, '[]', '[]', '2026-10-05T00:00:02.000Z', '2026-10-05T00:00:02.000Z')`
    )
    .run();
  f.db
    .prepare(
      `UPDATE conversation_digest_state
       SET source = 'llm', status = 'queued', last_message_seq = 2
       WHERE conversation_id = 'conv-md'`
    )
    .run();

  const llmDigest = f.runAsCaller("alice", () => f.getConversationDigest("conv-md"));
  assert.ok(llmDigest);
  assert.equal(llmDigest.status, "ready");
});

function sseResponse(frames) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

test("SSE streaming works across openai-chat, openai-responses, and anthropic protocols", async (t) => {
  const f = await fixture(t);
  if (!f) return;

  f.insertConv("conv-sse", { title: "SSE stream" });
  f.insertMsg("su1", "conv-sse", "user", 1, { content: "Stream digest test" });
  f.insertMsg("sa1", "conv-sse", "assistant", 2, {
    status: "done",
    content: [{ kind: "text", role: "assistant", content: "Done." }]
  });

  const payloadStr = JSON.stringify({
    overallSummary: "SSE parsed cleanly",
    topics: [
      {
        id: "new-1",
        title: "Streaming topic",
        summary: "Merged via SSE.",
        status: "done",
        startMessageId: "su1",
        endMessageId: "sa1",
        turnCount: 1,
        keywords: ["sse"],
        files: []
      }
    ]
  });
  const half = Math.floor(payloadStr.length / 2);
  const part1 = payloadStr.slice(0, half);
  const part2 = payloadStr.slice(half);

  const specs = [
    {
      protocol: "openai-chat",
      frames: [
        { choices: [{ delta: { content: part1 } }] },
        { choices: [{ delta: { content: part2 }, finish_reason: "stop" }] },
        "[DONE]"
      ]
    },
    {
      protocol: "openai-responses",
      frames: [
        { type: "response.output_text.delta", delta: part1 },
        { type: "response.output_text.delta", delta: part2 },
        { type: "response.completed", response: {} }
      ]
    },
    {
      protocol: "anthropic",
      frames: [
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "ignored" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: part1 } },
        { type: "content_block_delta", delta: { type: "text_delta", text: part2 } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } }
      ]
    }
  ];

  for (const spec of specs) {
    const provider = f.upsertProvider({
      name: `SSE-${spec.protocol}`,
      protocol: spec.protocol,
      baseUrl: "https://sse.example.com/v1",
      ...(spec.protocol === "anthropic" ? { anthropicBaseUrl: "https://sse.example.com/v1" } : {}),
      apiKey: "sk-sse-1234",
      models: [{ id: "fast-model", maxTokens: 4096 }]
    });
    f.setConversationDigestConfig({
      enabled: true,
      providerId: provider.id,
      model: "fast-model",
      minUserTurns: 1
    });
    let seenBody = {};
    f.setDigestFetchForTest(async (_url, init) => {
      seenBody = JSON.parse(String(init?.body ?? "{}"));
      return sseResponse(spec.frames);
    });

    const digest = await f.runConversationDigestNow("conv-sse", { forceRebuild: true });
    assert.ok(digest);
    assert.equal(digest.source, "llm");
    assert.equal(digest.topics[0].title, "Streaming topic");
    if (spec.protocol === "anthropic") {
      assert.equal(seenBody.max_tokens, 4096);
    }
  }
});

test("Timeouts surface explicit errors, trigger auto-mode fallback, and empty responses fall back", async (t) => {
  const f = await fixture(t);
  if (!f) return;

  f.insertConv("conv-timeout", { title: "Timeout check" });
  f.insertMsg("tu1", "conv-timeout", "user", 1, { content: "Long conversation task" });
  f.insertMsg("ta1", "conv-timeout", "assistant", 2, {
    status: "done",
    content: [{ kind: "text", role: "assistant", content: "Finished." }]
  });

  f.setDigestTimeoutMsForTest(80);

  const pSlow = f.upsertProvider({
    name: "SlowProvider",
    protocol: "openai-chat",
    baseUrl: "https://slow.example.com/v1",
    apiKey: "sk-slow-1234",
    position: 10,
    models: [{ id: "slow-mini" }]
  });
  f.setConversationDigestConfig({
    enabled: true,
    providerId: pSlow.id,
    model: "slow-mini",
    minUserTurns: 1
  });

  const hangFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true }
      );
    });

  // 1. Single provider timeout persists status='error' with explicit message (never silent idle)
  f.setDigestFetchForTest(hangFetch);
  const timedOutRes = await f.runConversationDigestNow("conv-timeout", { forceRebuild: true });
  assert.equal(timedOutRes, null);
  const persistedErr = f.runAsCaller("alice", () => f.getConversationDigest("conv-timeout"));
  assert.equal(persistedErr?.status, "error");
  assert.match(persistedErr?.error ?? "", /timed out/i);

  // 2. External AbortController cancels cleanly without writing error
  f.db
    .prepare("UPDATE conversation_digest_state SET status = 'idle', last_error = NULL WHERE conversation_id = 'conv-timeout'")
    .run();
  const extCtrl = new AbortController();
  f.setDigestFetchForTest((url, init) => {
    setTimeout(() => extCtrl.abort(), 15);
    return hangFetch(url, init);
  });
  await f.runConversationDigestNow("conv-timeout", {
    forceRebuild: true,
    signal: extCtrl.signal
  });
  const abortedState = f.runAsCaller("alice", () => f.getConversationDigest("conv-timeout"));
  assert.equal(abortedState?.status, "idle");
  assert.equal(abortedState?.error, undefined);

  // 3. Auto-mode falls back to provider #2 when provider #1 times out
  f.upsertProvider({
    name: "FastBackup",
    protocol: "openai-chat",
    baseUrl: "https://fast.example.com/v1",
    apiKey: "sk-fast-1234",
    position: 20,
    models: [{ id: "fast-mini" }]
  });
  f.setConversationDigestConfig({
    enabled: true,
    providerId: "",
    model: "",
    minUserTurns: 1
  });
  f.setDigestFetchForTest((url, init) => {
    const u = String(url);
    if (u.includes("slow.example.com")) {
      return hangFetch(url, init);
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  overallSummary: "Recovered from timeout",
                  topics: [
                    {
                      id: "new-1",
                      title: "Timeout fallback succeeded",
                      summary: "Switched to FastBackup after timeout.",
                      status: "done",
                      startMessageId: "tu1",
                      endMessageId: "ta1",
                      turnCount: 1,
                      keywords: ["timeout"],
                      files: []
                    }
                  ]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  });

  const recovered = await f.runConversationDigestNow("conv-timeout", { forceRebuild: true });
  assert.equal(recovered?.source, "llm");
  assert.equal(recovered?.topics[0].title, "Timeout fallback succeeded");

  // 4. Empty output on /responses (reasoning-only) falls back to /chat/completions
  f.setDigestTimeoutMsForTest(null);
  const pResp = f.upsertProvider({
    name: "RespEmpty",
    protocol: "openai-responses",
    protocols: ["openai-responses"],
    baseUrl: "https://respempty.example.com/v1",
    apiKey: "sk-resp-1234",
    models: [{ id: "reasoning-mini" }]
  });
  f.setConversationDigestConfig({
    enabled: true,
    providerId: pResp.id,
    model: "reasoning-mini",
    minUserTurns: 1
  });
  const emptyFallbackUrls = [];
  f.setDigestFetchForTest(async (url) => {
    const u = String(url);
    emptyFallbackUrls.push(u);
    if (u.endsWith("/responses")) {
      return new Response(
        JSON.stringify({ output: [{ type: "reasoning", summary: [] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overallSummary: "Fallback from empty responses",
                topics: [
                  {
                    id: "new-1",
                    title: "Chat fallback ok",
                    summary: "Recovered from empty responses output.",
                    status: "done",
                    startMessageId: "tu1",
                    endMessageId: "ta1",
                    turnCount: 1,
                    keywords: ["responses"],
                    files: []
                  }
                ]
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  const emptyRecovered = await f.runConversationDigestNow("conv-timeout", { forceRebuild: true });
  assert.equal(emptyRecovered?.source, "llm");
  assert.deepEqual(emptyFallbackUrls, [
    "https://respempty.example.com/v1/responses",
    "https://respempty.example.com/v1/chat/completions"
  ]);
});

test("Long conversation chunks into batches of 8 and retains partial progress on mid-run failure", async (t) => {
  const f = await fixture(t);
  if (!f) return;

  f.insertConv("conv-long-19", { title: "19-turn session" });
  for (let i = 1; i <= 19; i += 1) {
    f.insertMsg(`lu-${i}`, "conv-long-19", "user", i * 2 - 1, {
      content: `Requirement ${i}`
    });
    f.insertMsg(`la-${i}`, "conv-long-19", "assistant", i * 2, {
      status: "done",
      content: [{ kind: "text", role: "assistant", content: `Completed requirement ${i}.` }]
    });
  }

  const provider = f.upsertProvider({
    name: "BatchMock",
    protocol: "openai-chat",
    baseUrl: "https://batch.example.com/v1",
    apiKey: "sk-batch-1234",
    models: [{ id: "batch-mini" }]
  });
  f.setConversationDigestConfig({
    enabled: true,
    providerId: provider.id,
    model: "batch-mini",
    minUserTurns: 2
  });

  const recordedBatches = [];
  f.setDigestFetchForTest(async (_url, init) => {
    const reqBody = JSON.parse(String(init?.body ?? "{}"));
    const promptPayload = JSON.parse(reqBody.messages[1].content);
    recordedBatches.push({
      existingCount: promptPayload.existingTopics.length,
      newTurnCount: promptPayload.newTurns.length,
      firstTurnIndex: promptPayload.newTurns[0]?.turnIndex
    });
    const mergedTopics = [
      ...promptPayload.existingTopics,
      ...promptPayload.newTurns.map((turn, idx) => ({
        id: `new-${promptPayload.existingTopics.length + idx + 1}`,
        title: `Topic ${turn.turnIndex}`,
        summary: `Summarized turn ${turn.turnIndex}`,
        status: "done",
        startMessageId: turn.userMessageId,
        endMessageId: turn.assistantMessageId,
        turnCount: 1,
        keywords: [],
        files: []
      }))
    ];
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overallSummary: `Through ${mergedTopics.length}`,
                topics: mergedTopics
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const full = await f.runConversationDigestNow("conv-long-19", { forceRebuild: true });
  assert.ok(full);
  assert.equal(full.source, "llm");
  assert.equal(full.status, "ready");
  assert.equal(full.topics.length, 19);
  assert.deepEqual(recordedBatches, [
    { existingCount: 0, newTurnCount: 8, firstTurnIndex: 1 },
    { existingCount: 8, newTurnCount: 8, firstTurnIndex: 9 },
    { existingCount: 16, newTurnCount: 3, firstTurnIndex: 17 }
  ]);

  // Mid-run failure on batch 3 retains batches 1-2 LLM topics + exposes turns 17-19 as trailing Layer 0
  let callCount = 0;
  f.setDigestFetchForTest(async (_url, init) => {
    callCount += 1;
    if (callCount === 3) {
      return new Response("upstream failure", { status: 500 });
    }
    const reqBody = JSON.parse(String(init?.body ?? "{}"));
    const promptPayload = JSON.parse(reqBody.messages[1].content);
    const mergedTopics = [
      ...promptPayload.existingTopics,
      ...promptPayload.newTurns.map((turn, idx) => ({
        id: `new-${promptPayload.existingTopics.length + idx + 1}`,
        title: `Partial topic ${turn.turnIndex}`,
        summary: `Saved batch turn ${turn.turnIndex}`,
        status: "done",
        startMessageId: turn.userMessageId,
        endMessageId: turn.assistantMessageId,
        turnCount: 1,
        keywords: [],
        files: []
      }))
    ];
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overallSummary: "Partial summary",
                topics: mergedTopics
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const failedThird = await f.runConversationDigestNow("conv-long-19", { forceRebuild: true });
  assert.equal(failedThird, null);
  const partial = f.runAsCaller("alice", () => f.getConversationDigest("conv-long-19"));
  assert.ok(partial);
  assert.equal(partial.status, "error");
  assert.equal(partial.source, "llm");
  assert.equal(partial.topics.length, 19);
  assert.equal(partial.topics[15].source, "llm");
  assert.equal(partial.topics[16].source, "rule");
  assert.equal(partial.topics[18].source, "rule");
});

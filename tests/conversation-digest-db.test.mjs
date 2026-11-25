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
    f.setDigestFetchForTest(async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init?.headers ?? {};
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
    if (spec.protocol === "anthropic") {
      assert.equal(seenHeaders["x-api-key"], "sk-test-123456");
    } else {
      assert.equal(seenHeaders.Authorization, "Bearer sk-test-123456");
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

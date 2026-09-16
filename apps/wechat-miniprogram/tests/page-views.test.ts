/**
 * Read-only page view-model tests.
 *
 * These are pure functions of store state, so every UI state the pages must distinguish —
 * loading, empty, offline, forbidden, incompatible, error — is asserted here without WeChat.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createConnectionStore } from "../miniprogram/stores/connectionStore";
import type { ConnectionState } from "../miniprogram/stores/connectionStore";
import { createHostStore } from "../miniprogram/stores/hostStore";
import { createConversationStore } from "../miniprogram/stores/conversationStore";
import type { ConversationListState } from "../miniprogram/stores/conversationStore";
import { createMessageStore } from "../miniprogram/stores/messageStore";
import { pickSnapshotPayload } from "../miniprogram/stores/entityFields";
import type { ConversationSummary, MessageSummary } from "../miniprogram/protocol/remote.generated";
import {
  EMPTY_CONVERSATIONS_NONE,
  EMPTY_CONVERSATIONS_OFFLINE,
  EMPTY_MESSAGES_NONE,
  EMPTY_MESSAGES_OFFLINE,
  MAX_MESSAGE_RENDER_CHARS,
  READ_ONLY_NOTICE,
  ROUTES,
  buildChatView,
  buildConnectionBanner,
  buildConversationListView,
  buildHomeView,
  chatRoute,
  readConversationId,
  renderMessageText,
  roleLabelOf
} from "../miniprogram/services/pageViews";
import type { ConnectionStatus } from "../miniprogram/services/relaySocket";
import { ISOTIME, conversationSummary, messageSummary, snapshotPayload } from "./helpers/fakeTransport";

function connectionState(status: ConnectionStatus, overrides: Partial<ConnectionState> = {}): ConnectionState {
  const store = createConnectionStore();
  store.applySocketSnapshot({
    status,
    reasonCode: null,
    reasonMessage: `${status} reason`,
    attempt: 1,
    nextRetryInMs: null,
    connectionId: null,
    serverTime: null,
    limits: null,
    suspended: false,
    violations: 0,
    droppedFrames: 0,
    heartbeatMissed: 0
  });
  if (Object.keys(overrides).length > 0) {
    store.setState((previous) => ({ ...previous, ...overrides }));
  }
  return store.getState();
}

describe("connection banner", () => {
  test("online is ok and offers no retry", () => {
    const banner = buildConnectionBanner(connectionState("online"));
    assert.equal(banner.tone, "ok");
    assert.equal(banner.canReconnect, false);
    assert.equal(banner.needsCredential, false);
    assert.equal(banner.terminal, false);
  });

  test("offline and backoff offer an explicit retry", () => {
    const offline = buildConnectionBanner(connectionState("offline"));
    assert.equal(offline.tone, "error");
    assert.equal(offline.canReconnect, true);

    const backoff = buildConnectionBanner(
      connectionState("backoff", { nextRetryInMs: 4_000 })
    );
    assert.equal(backoff.tone, "warn");
    assert.equal(backoff.canReconnect, true);
    assert.match(backoff.detail, /4 秒后重试/);
  });

  test("forbidden is terminal, needs a credential and never auto-retries", () => {
    const banner = buildConnectionBanner(connectionState("forbidden"));
    assert.equal(banner.tone, "error");
    assert.equal(banner.needsCredential, true);
    assert.equal(banner.terminal, true);
    assert.equal(banner.canReconnect, false);
    assert.match(banner.label, /凭证/);
  });

  test("incompatible is terminal and does not ask for a credential", () => {
    const banner = buildConnectionBanner(connectionState("incompatible"));
    assert.equal(banner.tone, "error");
    assert.equal(banner.terminal, true);
    assert.equal(banner.needsCredential, false);
    assert.match(banner.label, /协议/);
  });

  test("signedOut asks for a credential", () => {
    const banner = buildConnectionBanner(connectionState("signedOut"));
    assert.equal(banner.needsCredential, true);
    assert.equal(banner.canReconnect, false);
  });

  test("connecting and authenticating are neutral progress states", () => {
    for (const status of ["connecting", "authenticating"] as const) {
      const banner = buildConnectionBanner(connectionState(status));
      assert.equal(banner.tone, "neutral");
      assert.equal(banner.terminal, false);
      assert.equal(banner.canReconnect, false);
    }
  });
});

describe("home view", () => {
  test("a snapshot fills the host card, counters and summaries", () => {
    const host = createHostStore();
    const payload = pickSnapshotPayload(
      snapshotPayload("host-1", 3, {
        projects: [{ projectId: "p1", name: "Project one", updatedAt: ISOTIME }],
        agents: [{ agentId: "a1", name: "Agent", available: true }],
        activeTasks: [{ taskId: "t1", title: "Task", status: "running", updatedAt: ISOTIME }],
        pendingDecisions: [
          { decisionId: "d1", kind: "permission", runId: "r1", conversationId: "c1", summary: "Allow?" }
        ]
      })
    );
    assert.ok(payload !== null);
    host.replaceFromSnapshot(payload, 1_000);

    const view = buildHomeView({
      connection: connectionState("online"),
      host: host.getState(),
      environmentName: "local",
      credentialSource: "dev_operator_token"
    });

    assert.equal(view.hasHost, true);
    assert.equal(view.hostTone, "ok");
    assert.deepEqual(
      view.metrics.map((metric) => metric.label),
      ["运行中", "待决策", "终端", "项目", "Agent"]
    );
    assert.equal(view.projects.length, 1);
    assert.equal(view.activeTasks.length, 1);
    assert.equal(view.hasPendingDecisions, true);
    assert.equal(view.isDevConnection, true);
    // A DEV session must never be presented as an administrator login.
    assert.match(view.credentialNotice, /DEV/);
    assert.match(view.credentialNotice, /非微信管理员登录|不是微信管理员登录/);
    assert.equal(view.environment, "local");
  });

  test("without a snapshot the home view says so instead of inventing a host", () => {
    const view = buildHomeView({
      connection: connectionState("offline"),
      host: createHostStore().getState(),
      environmentName: "dev",
      credentialSource: "none"
    });
    assert.equal(view.hasHost, false);
    assert.equal(view.hostTone, "neutral");
    assert.deepEqual(view.metrics, []);
    assert.equal(view.isDevConnection, false);
    assert.match(view.credentialNotice, /只读/);
    assert.equal(view.banner.tone, "error");
  });
});

describe("conversation list view", () => {
  function listState(
    items: readonly unknown[],
    overrides: Partial<ConversationListState> = {}
  ): ConversationListState {
    const store = createConversationStore();
    store.replaceFromSnapshot(items as unknown as ConversationSummary[]);
    if (Object.keys(overrides).length > 0) {
      store.setState((previous) => ({ ...previous, ...overrides }));
    }
    return store.getState();
  }

  test("rows carry a formatted subtitle and a bounded title", () => {
    const view = buildConversationListView(
      listState([conversationSummary({ conversationId: "c1", title: "Hello", archived: true })]),
      connectionState("online")
    );
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].id, "c1");
    assert.equal(view.items[0].archived, true);
    assert.match(view.items[0].subtitle, /c1/);
    assert.equal(view.empty, false);
  });

  test("an empty list is explained differently when the host is unreachable", () => {
    const offline = buildConversationListView(listState([]), connectionState("offline"));
    assert.equal(offline.empty, true);
    assert.equal(offline.emptyMessage, EMPTY_CONVERSATIONS_OFFLINE);
    assert.equal(offline.refreshEnabled, false);

    const online = buildConversationListView(listState([]), connectionState("online"));
    assert.equal(online.emptyMessage, EMPTY_CONVERSATIONS_NONE);
    assert.equal(online.refreshEnabled, true);
  });

  test("pagination is offered only when a cursor exists, the host is reachable and nothing is loading", () => {
    const loaded = listState([conversationSummary()], { hasMore: true, cursor: "page-2" });
    assert.equal(buildConversationListView(loaded, connectionState("online")).loadMoreEnabled, true);
    assert.equal(
      buildConversationListView({ ...loaded, loading: true }, connectionState("online")).loadMoreEnabled,
      false
    );
    assert.equal(
      buildConversationListView(loaded, connectionState("backoff")).loadMoreEnabled,
      false
    );
    assert.equal(
      buildConversationListView({ ...loaded, hasMore: false }, connectionState("online")).loadMoreEnabled,
      false
    );
  });

  test("a fetch error is surfaced and suppresses the empty state", () => {
    const state = listState([], { error: "主机离线", loaded: true });
    const view = buildConversationListView(state, connectionState("online"));
    assert.equal(view.error, "主机离线");
    assert.equal(view.empty, false);
  });

  test("truncation is reported, not hidden", () => {
    const state = listState([conversationSummary()], { truncated: true });
    assert.equal(buildConversationListView(state, connectionState("online")).truncated, true);
  });
});

describe("chat view", () => {
  function threadState(items: readonly unknown[], overrides: Record<string, unknown> = {}) {
    const store = createMessageStore();
    for (const item of items) {
      store.upsert(item as unknown as MessageSummary);
    }
    // `thread()` returns a complete default thread, so the empty-list case stays well formed.
    const base = store.thread("c1");
    store.setState((previous) => ({
      ...previous,
      threads: { ...previous.threads, c1: { ...base, loaded: true, ...overrides } }
    }));
    return store.thread("c1");
  }

  test("messages are plain text, labelled by role and never a write surface", () => {
    const thread = threadState([messageSummary({ messageId: "m1", role: "assistant", content: "hi" })]);
    const view = buildChatView("c1", "Alpha", thread, connectionState("online"));

    assert.equal(view.title, "Alpha");
    assert.equal(view.messages.length, 1);
    assert.equal(view.messages[0].roleLabel, "助手");
    assert.equal(view.messages[0].text, "hi");
    // The type-level guarantee that this stage has no send path.
    assert.equal(view.canSend, false);
    assert.match(view.readonlyNotice, /只读/);
    assert.ok(!("send" in view));
  });

  test("role labels cover every protocol role", () => {
    assert.equal(roleLabelOf("user"), "我");
    assert.equal(roleLabelOf("assistant"), "助手");
    assert.equal(roleLabelOf("system"), "系统");
  });

  test("control characters are removed, newlines survive and length is bounded", () => {
    const raw = `line1\r\nline2\u0000\u0007\ttab`;
    const rendered = renderMessageText(raw);
    assert.equal(rendered, "line1\nline2\ttab");
    assert.ok(!rendered.includes("\u0000"));
    assert.ok(!rendered.includes("\u0007"));

    const huge = "x".repeat(MAX_MESSAGE_RENDER_CHARS + 100);
    const bounded = renderMessageText(huge);
    assert.equal(bounded.length, MAX_MESSAGE_RENDER_CHARS + 1);
    assert.ok(bounded.endsWith("…"));
  });

  test("markup and scheme-looking text stays inert plain text", () => {
    // Nothing is escaped into HTML, nothing is interpreted: the output is the input, and the WXML
    // renders it through <text>, so there is no execution surface.
    const html = `<script>alert(1)</script><a href="javascript:alert(2)">x</a>`;
    assert.equal(renderMessageText(html), html);
    assert.equal(renderMessageText("![](http://example.com/x.png)"), "![](http://example.com/x.png)");
  });

  test("an empty thread explains itself differently offline", () => {
    const offline = buildChatView("c1", null, threadState([], { loaded: true }), connectionState("offline"));
    assert.equal(offline.empty, true);
    assert.equal(offline.emptyMessage, EMPTY_MESSAGES_OFFLINE);
    assert.equal(offline.title, "c1", "无标题时回退到短 id");
    assert.equal(offline.loadOlderEnabled, false);

    const online = buildChatView("c1", null, threadState([], { loaded: true }), connectionState("online"));
    assert.equal(online.emptyMessage, EMPTY_MESSAGES_NONE);
  });

  test("older history is offered only with a cursor and no in-flight load", () => {
    const withMore = threadState([messageSummary()], { hasMore: true, loaded: true });
    assert.equal(buildChatView("c1", "t", withMore, connectionState("online")).loadOlderEnabled, true);
    assert.equal(
      buildChatView("c1", "t", { ...withMore, loading: true }, connectionState("online")).loadOlderEnabled,
      false
    );
  });

  test("a host-truncated message is flagged in the view", () => {
    const thread = threadState([messageSummary({ truncated: true })]);
    assert.equal(buildChatView("c1", "t", thread, connectionState("online")).messages[0].truncated, true);
  });
});

describe("routes", () => {
  test("every route is a fixed constant path", () => {
    assert.equal(ROUTES.login, "/pages/index/index");
    assert.equal(ROUTES.home, "/pages/home/home");
    assert.equal(ROUTES.conversations, "/pages/conversations/conversations");
    assert.equal(ROUTES.chat, "/pages/chat/chat");
  });

  test("the chat route encodes the id and the reader validates it", () => {
    const id = "c/1 a?b";
    const url = chatRoute(id);
    assert.equal(url, `${ROUTES.chat}?conversationId=${encodeURIComponent(id)}`);
    assert.equal(readConversationId({ conversationId: id }), id);
    assert.equal(readConversationId({ conversationId: encodeURIComponent(id) }), id);
  });

  test("the reader refuses anything that is not a bounded id", () => {
    assert.equal(readConversationId(undefined), null);
    assert.equal(readConversationId({}), null);
    assert.equal(readConversationId({ conversationId: "" }), null);
    assert.equal(readConversationId({ conversationId: 42 }), null);
    assert.equal(readConversationId({ conversationId: "x".repeat(129) }), null);
    assert.equal(readConversationId({ conversationId: "ok" }), "ok");
  });

  test("the read-only notice is not empty", () => {
    assert.ok(READ_ONLY_NOTICE.length > 0);
  });
});

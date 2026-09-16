/**
 * Chat page controller (route `pages/chat/chat?conversationId=...`).
 *
 * Read-only transcript: newest window first, older history appended through the store cursor, and
 * *no* input, send, stop, decision or terminal affordance. `ChatView.canSend` is the literal
 * `false`, and this controller has no method that could produce a write method name, so a page
 * cannot grow one by accident.
 *
 * Message text is rendered through `renderMessageText`: plain text, control characters removed,
 * length bounded. Nothing is interpreted as HTML, Markdown or a URL.
 *
 * Lifecycle notes: the page is torn down on `onUnload`; a message page that was already in flight
 * then resolves into the App-owned store but never calls `setData` here, because every render is
 * gated on `started`.
 */

import type { AdminConnection } from "../../services/adminConnection";
import { buildChatView, type ChatView } from "../../services/pageViews";
import type { PageRuntime } from "../../platform/pageRuntime";
import type { RemoteId } from "../../protocol/remote.generated";

export type ChatPageData = ChatView;

export interface ChatControllerOptions {
  readonly connection: AdminConnection;
  readonly runtime: PageRuntime;
  readonly conversationId: RemoteId;
  readonly setData: (data: ChatPageData) => void;
}

export interface ChatController {
  start(): void;
  stop(): void;
  render(): void;
  refresh(): void;
  loadOlder(): void;
}

export function createChatController(options: ChatControllerOptions): ChatController {
  const { connection, runtime, conversationId } = options;
  let started = false;
  let lastStatus: string | null = null;
  let loadInFlight = false;
  let unsubscribeConnection: (() => void) | null = null;
  let unsubscribeMessages: (() => void) | null = null;
  let unsubscribeConversations: (() => void) | null = null;

  function titleOf(): string | null {
    const match = connection.stores.conversations
      .getState()
      .items.find((item) => item.conversationId === conversationId);
    return match === undefined ? null : match.title;
  }

  function build(): ChatPageData {
    return buildChatView(
      conversationId,
      titleOf(),
      connection.stores.messages.thread(conversationId),
      connection.stores.connection.getState()
    );
  }

  function render(): void {
    if (!started) {
      return;
    }
    options.setData(build());
  }

  async function load(refresh: boolean): Promise<void> {
    if (loadInFlight) {
      return;
    }
    if (connection.stores.connection.getState().status !== "online") {
      render();
      return;
    }
    loadInFlight = true;
    try {
      await connection.state.loadMessages(conversationId, refresh);
    } finally {
      loadInFlight = false;
    }
    render();
  }

  function handleConnectionChange(): void {
    const status = connection.stores.connection.getState().status;
    const previous = lastStatus;
    lastStatus = status;
    if (status === "online" && previous !== "online") {
      void load(true);
    }
    render();
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      lastStatus = connection.stores.connection.getState().status;
      unsubscribeConnection = connection.stores.connection.subscribe(handleConnectionChange);
      unsubscribeMessages = connection.stores.messages.subscribe(render);
      // The conversation title lives in another store and can be renamed on the host.
      unsubscribeConversations = connection.stores.conversations.subscribe(render);
      render();
      void load(true);
    },

    stop() {
      started = false;
      unsubscribeConnection?.();
      unsubscribeConnection = null;
      unsubscribeMessages?.();
      unsubscribeMessages = null;
      unsubscribeConversations?.();
      unsubscribeConversations = null;
    },

    render,

    refresh() {
      void load(true).then(() => runtime.stopPullDownRefresh());
    },

    loadOlder() {
      if (!build().loadOlderEnabled) {
        return;
      }
      void load(false);
    }
  };
}

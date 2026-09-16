/**
 * Conversations page controller (route `pages/conversations/conversations`).
 *
 * Bounded pagination on top of the W3 read layer: `refresh` re-reads the newest window,
 * `loadMore` follows the store's cursor, and the store itself refuses a page that a newer fetch
 * superseded — so a double tap cannot interleave two pages. The controller only decides *when* to
 * ask; it never builds a request or names a method.
 *
 * `stop()` is the page's unsubscribe point. A read that was already in flight when the operator
 * navigated away resolves into the store (the App owns it) but must never call `setData` on a
 * page that no longer exists, which is why every render is gated on `started`.
 */

import type { AdminConnection } from "../../services/adminConnection";
import {
  buildConversationListView,
  chatRoute,
  type ConversationListView
} from "../../services/pageViews";
import type { PageRuntime } from "../../platform/pageRuntime";
import type { RemoteId } from "../../protocol/remote.generated";

export type ConversationsPageData = ConversationListView;

export interface ConversationsControllerOptions {
  readonly connection: AdminConnection;
  readonly runtime: PageRuntime;
  readonly setData: (data: ConversationsPageData) => void;
}

export interface ConversationsController {
  start(): void;
  stop(): void;
  render(): void;
  refresh(): void;
  loadMore(): void;
  openConversation(conversationId: RemoteId): void;
  openHome(): void;
}

export function createConversationsController(
  options: ConversationsControllerOptions
): ConversationsController {
  const { connection, runtime } = options;
  let started = false;
  let lastStatus: string | null = null;
  let loadInFlight = false;
  let unsubscribeConnection: (() => void) | null = null;
  let unsubscribeList: (() => void) | null = null;

  function build(): ConversationsPageData {
    return buildConversationListView(
      connection.stores.conversations.getState(),
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
      // Asking while offline would only produce a local failure; the reconnect path re-reads.
      render();
      return;
    }
    loadInFlight = true;
    try {
      await connection.state.loadConversations(refresh);
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
      unsubscribeList = connection.stores.conversations.subscribe(render);
      render();
      void load(true);
    },

    stop() {
      started = false;
      unsubscribeConnection?.();
      unsubscribeConnection = null;
      unsubscribeList?.();
      unsubscribeList = null;
    },

    render,

    refresh() {
      void load(true).then(() => runtime.stopPullDownRefresh());
    },

    loadMore() {
      const view = build();
      if (!view.loadMoreEnabled) {
        return;
      }
      void load(false);
    },

    openConversation(conversationId) {
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        return;
      }
      runtime.navigateTo(chatRoute(conversationId));
    },

    openHome() {
      runtime.navigateBack(1);
    }
  };
}

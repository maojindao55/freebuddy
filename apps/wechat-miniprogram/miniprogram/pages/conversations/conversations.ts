/**
 * Conversations page (route `pages/conversations/conversations`).
 *
 * Bounded list with cursor pagination. Pull-down refreshes the newest window; reaching the bottom
 * asks for the next page. Both are no-ops while the host is not reachable, and the store drops a
 * page that a newer fetch superseded.
 */

import { getPageRuntime, type DatasetEventLike } from "../../platform/pageRuntime";
import { getAppSession } from "../../services/appSession";
import {
  createConversationsController,
  type ConversationsController,
  type ConversationsPageData
} from "./controller";

Page({
  data: {
    banner: {
      status: "signedOut",
      tone: "neutral",
      label: "",
      detail: "",
      canReconnect: false,
      needsCredential: true,
      terminal: true
    },
    items: [],
    loading: false,
    refreshing: false,
    hasMore: false,
    cursor: null,
    truncated: false,
    error: null,
    empty: false,
    emptyMessage: "",
    loadMoreEnabled: false,
    refreshEnabled: false
  } as ConversationsPageData,

  controller: null as ConversationsController | null,

  onLoad() {
    this.controller = createConversationsController({
      connection: getAppSession().connection,
      runtime: getPageRuntime(),
      setData: (data) => this.setData(data)
    });
  },

  onShow() {
    this.controller?.start();
  },

  onHide() {
    this.controller?.stop();
  },

  onUnload() {
    this.controller?.stop();
  },

  onPullDownRefresh() {
    this.controller?.refresh();
  },

  onReachBottom() {
    this.controller?.loadMore();
  },

  onOpenConversation(event: DatasetEventLike) {
    const id = event.currentTarget.dataset.id;
    if (typeof id === "string") {
      this.controller?.openConversation(id);
    }
  },

  onLoadMore(_event: DatasetEventLike) {
    this.controller?.loadMore();
  }
});

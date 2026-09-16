/**
 * Chat page (route `pages/chat/chat?conversationId=...`).
 *
 * Read-only transcript. There is no input, no send button, no stop button, no decision card and no
 * terminal affordance anywhere in this file or its template; the message text is rendered as
 * plain text through `renderMessageText`.
 */

import { getPageRuntime, type DatasetEventLike } from "../../platform/pageRuntime";
import { getAppSession } from "../../services/appSession";
import { readConversationId } from "../../services/pageViews";
import { createChatController, type ChatController, type ChatPageData } from "./controller";

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
    conversationId: "",
    title: "",
    subtitle: "",
    messages: [],
    loading: false,
    hasMore: false,
    loadedOlder: false,
    truncated: false,
    error: null,
    empty: false,
    emptyMessage: "",
    loadOlderEnabled: false,
    readonlyNotice: "",
    canSend: false
  } as ChatPageData,

  controller: null as ChatController | null,

  onLoad(query: Record<string, unknown>) {
    const conversationId = readConversationId(query);
    if (conversationId === null) {
      // A chat page without a valid id has nothing to read; refusing here beats issuing a request
      // the protocol would reject anyway.
      getPageRuntime().showToast({ title: "缺少有效的会话 ID" });
      getPageRuntime().navigateBack(1);
      return;
    }
    this.controller = createChatController({
      connection: getAppSession().connection,
      runtime: getPageRuntime(),
      conversationId,
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
    this.controller?.loadOlder();
  },

  onLoadOlder(_event: DatasetEventLike) {
    this.controller?.loadOlder();
  }
});

import { useEffect } from "react";

import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { useConversationStore } from "@/store/conversationStore";
import { useDetailLayoutStore } from "@/store/detailLayoutStore";
import { useDraftPreviewStore } from "@/store/draftPreviewStore";

/**
 * Listens for agent -> FreeBuddy bridge events (local HTTP / OS scheme) and
 * dispatches them to the right store. Mounted once at the app root.
 */
export function AgentBridgeListener() {
  const notify = useAgentBridgeStore((s) => s.notify);

  useEffect(() => {
    const off = window.freebuddy?.window?.onBridge?.((event) => {
      const { action, params } = event;
      if (action === "preview") {
        useDetailLayoutStore.getState().setActiveTab("preview");
        return;
      }
      if (action === "navigate") {
        const to = params?.to;
        const convId = useConversationStore.getState().activeId;
        if (to && convId) {
          useDraftPreviewStore.getState().setManualEntry(convId, to);
          useDetailLayoutStore.getState().setActiveTab("preview");
        }
        return;
      }
      if (action === "notify") {
        const text = params?.text;
        if (text) notify(text);
        return;
      }
    });
    return () => {
      off?.();
    };
  }, [notify]);

  return null;
}

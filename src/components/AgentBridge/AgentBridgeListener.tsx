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
    const setTarget = (to: string | undefined, openPreview: boolean) => {
      const convId = useConversationStore.getState().activeId;
      if (to && convId) {
        useDraftPreviewStore.getState().setPreviewTarget(convId, to);
        if (openPreview) useDetailLayoutStore.getState().setActiveTab("preview");
      }
    };

    const off = window.freebuddy?.window?.onBridge?.((event) => {
      const { action, params } = event;
      if (action === "preview") {
        useDetailLayoutStore.getState().setActiveTab("preview");
        return;
      }
      if (action === "navigate") {
        setTarget(params?.to, true);
        return;
      }
      if (action === "entry") {
        setTarget(params?.to, false);
        return;
      }
      if (action === "status") {
        const text = params?.text;
        if (text) notify(text);
        return;
      }
      if (action === "error") {
        const text = params?.text;
        if (text) notify(text);
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

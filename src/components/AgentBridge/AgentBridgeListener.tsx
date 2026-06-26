import { nanoid } from "nanoid";
import { useEffect } from "react";

import { cliClient } from "@/services/cli/client";

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
    const appendBridgeMessage = (text: string, status: "done" | "failed" = "done") => {
      const convId = useConversationStore.getState().activeId;
      if (!convId) return;
      const id = nanoid();
      const now = new Date().toISOString();
      const message = {
        id,
        conversationId: convId,
        role: "system" as const,
        status,
        content: text,
        createdAt: now,
        updatedAt: now
      };
      useConversationStore.setState((s) => ({
        messages: {
          ...s.messages,
          [convId]: [...(s.messages[convId] ?? []), message]
        }
      }));
      if (cliClient.isAvailable()) {
        void cliClient.appendMessage({
          id,
          conversationId: convId,
          role: "system",
          status,
          content: text
        });
      }
    };

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
        if (text) {
          notify(text);
          appendBridgeMessage(`Preview status: ${text}`);
        }
        return;
      }
      if (action === "error") {
        const text = params?.text;
        if (text) {
          notify(text);
          appendBridgeMessage(`Preview error: ${text}`, "failed");
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

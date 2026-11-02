import { useEffect, useRef } from "react";

import { useConversationStore } from "@/store/conversationStore";
import { useConversationOverviewStore } from "@/store/conversationOverviewStore";

/** One subscription and calibration timer shared by sidebar and panel. */
export function useConversationOverviewUpdates(enabled: boolean): void {
  const conversations = useConversationStore((state) => state.conversations);
  const refresh = useConversationOverviewStore((state) => state.refresh);
  const idsRef = useRef<string[]>([]);
  const idsKey = conversations.filter((conversation) => !conversation.archived).map((conversation) => conversation.id).sort().join("\n");

  useEffect(() => {
    idsRef.current = idsKey ? idsKey.split("\n") : [];
    if (enabled) void refresh(idsRef.current);
  }, [idsKey, enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = new Set<string>();
    const schedule = (id?: string) => {
      if (id) { if (!idsRef.current.includes(id)) return; changed.add(id); }
      else idsRef.current.forEach((entry) => changed.add(entry));
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const requested = [...changed];
        changed.clear();
        void refresh(requested);
      }, 750);
    };
    const offMessages = window.freebuddy?.cli?.onMessagesChanged?.((id) => schedule(id));
    const offConversations = window.freebuddy?.cli?.onConversationsChanged?.(() => schedule());
    const offWorkflow = window.freebuddy?.workflow?.onRunFinished?.((event) => schedule(event.conversationId));
    const offDelegation = window.freebuddy?.delegation?.onChanged?.(() => schedule());
    const interval = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh(idsRef.current);
    }, 15000);
    const onVisible = () => { if (document.visibilityState === "visible") schedule(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      offMessages?.(); offConversations?.(); offWorkflow?.(); offDelegation?.();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);
}

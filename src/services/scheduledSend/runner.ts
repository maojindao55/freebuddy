import i18next from "i18next";

import { delegationClient } from "@/services/delegation/client";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { useConversationStore } from "@/store/conversationStore";
import {
  dueScheduledSends,
  useScheduledSendStore,
  type ScheduledSend
} from "@/store/scheduledSendStore";
import { composeMessageWithAttachments } from "@/utils/chatAttachments";
import { unprotectManagedAttachments } from "@/utils/managedAttachmentProtection";
import { truncatePromptPreview } from "@/utils/scheduledSend";

const TICK_MS = 1000;

const inFlight = new Set<string>();

function notify(text: string) {
  useAgentBridgeStore.getState().notify(text);
}

export async function fireScheduledSend(entry: ScheduledSend): Promise<void> {
  const scheduled = useScheduledSendStore.getState();
  const conversationStore = useConversationStore.getState();
  const conv = conversationStore.conversations.find(
    (c) => c.id === entry.conversationId
  );

  if (!conv) {
    scheduled.remove(entry.conversationId);
    unprotectManagedAttachments(entry.attachments);
    notify(i18next.t("scheduledSend.conversationMissing"));
    return;
  }

  if (conversationStore.isRunning(conv.id)) {
    if (entry.status !== "waiting") scheduled.setStatus(conv.id, "waiting");
    return;
  }

  if (inFlight.has(conv.id)) return;
  inFlight.add(conv.id);
  scheduled.setStatus(conv.id, "sending");

  try {
    if (
      delegationClient.isAvailable() &&
      (await delegationClient.hasRunForConversation(conv.id))
    ) {
      const res = await delegationClient.followUp({
        conversationId: conv.id,
        prompt: composeMessageWithAttachments(entry.prompt, entry.attachments)
      });
      if (!res.ok) throw new Error(res.error);
      await useConversationStore.getState().loadMessages(conv.id);
    } else {
      await useConversationStore.getState().sendMessage({
        conversationId: conv.id,
        prompt: entry.prompt,
        attachments: entry.attachments,
        approvalModeOverride: conv.approvalMode
      });
    }

    useScheduledSendStore.getState().remove(conv.id);
    unprotectManagedAttachments(entry.attachments);
    notify(
      i18next.t("scheduledSend.sentNotification", {
        preview: truncatePromptPreview(entry.prompt, 40)
      })
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useScheduledSendStore.getState().setStatus(conv.id, "failed", message);
    notify(i18next.t("scheduledSend.failedNotification", { err: message }));
  } finally {
    inFlight.delete(conv.id);
  }
}

export function runScheduledSendTick(now: number = Date.now()): void {
  const store = useScheduledSendStore.getState();
  store.tick(now);
  for (const entry of dueScheduledSends(store.entries, now)) {
    void fireScheduledSend(entry);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Starts the once-per-second scheduler; returns a stop function. Idempotent. */
export function startScheduledSendRunner(): () => void {
  if (timer === undefined) {
    timer = setInterval(() => runScheduledSendTick(), TICK_MS);
  }
  return () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

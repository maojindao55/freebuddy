import i18next from "i18next";
import { cliClient } from "@/services/cli/client";
import { buildReferencedPrompt } from "@/utils/conversationReferences";

import { delegationClient } from "@/services/delegation/client";
import { scheduledTasksClient } from "@/services/scheduledTasks/client";
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
  let conv = conversationStore.conversations.find(
    (c) => c.id === entry.conversationId
  );

  if (!conv) {
    if (cliClient.isAvailable()) {
      const fresh = await cliClient
        .getConversation(entry.conversationId)
        .catch(() => undefined);
      if (fresh) {
        if (fresh.archived) {
          scheduled.setStatus(
            entry.conversationId,
            "missed",
            i18next.t("scheduledTasks.errors.conversationUnavailable")
          );
          if (entry.taskId && scheduledTasksClient.isAvailable()) {
            void scheduled.hydrate();
          }
          return;
        }
        await conversationStore.load().catch(() => {});
        conv = useConversationStore
          .getState()
          .conversations.find((c) => c.id === entry.conversationId);
        if (!conv) return;
      }
    }
  }

  if (!conv) {
    if (entry.taskId && scheduledTasksClient.isAvailable()) {
      const claimed = await scheduledTasksClient
        .claimDispatch(entry.taskId)
        .catch(() => null);
      if (claimed?.ok) {
        await scheduledTasksClient
          .completeDispatch({
            id: entry.taskId,
            claimToken: claimed.claimToken,
            outcome: "conversation_missing"
          })
          .catch(() => {});
        await scheduled.remove(entry.conversationId, { localOnly: true });
        notify(i18next.t("scheduledSend.conversationMissing"));
      }
      return;
    }
    await scheduled.remove(entry.conversationId, { localOnly: true });
    unprotectManagedAttachments(entry.attachments);
    notify(i18next.t("scheduledSend.conversationMissing"));
    return;
  }

  if (conversationStore.isRunning(conv.id)) {
    if (entry.status !== "waiting") {
      scheduled.setStatus(conv.id, "waiting");
      if (entry.taskId && scheduledTasksClient.isAvailable()) {
        void scheduledTasksClient.markWaiting(entry.taskId).catch(() => {});
      }
    }
    return;
  }
  if (cliClient.isMessageQueueAvailable()) {
    try {
      const queue = await cliClient.getMessageQueue(conv.id);
      if (queue.busy || queue.editingId || queue.entries.length) {
        if (entry.status !== "waiting") {
          scheduled.setStatus(conv.id, "waiting");
          if (entry.taskId && scheduledTasksClient.isAvailable()) {
            void scheduledTasksClient.markWaiting(entry.taskId).catch(() => {});
          }
        }
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      scheduled.setStatus(conv.id, "failed", message);
      notify(i18next.t("scheduledSend.failedNotification", { err: message }));
      return;
    }
  }

  if (inFlight.has(conv.id)) return;
  inFlight.add(conv.id);

  let claimToken: string | undefined;
  if (entry.taskId && scheduledTasksClient.isAvailable()) {
    try {
      const claimed = await scheduledTasksClient.claimDispatch(entry.taskId);
      if (!claimed.ok) {
        inFlight.delete(conv.id);
        if (claimed.reason === "not_found" || claimed.reason === "disabled") {
          void useScheduledSendStore.getState().hydrate();
        }
        return;
      }
      claimToken = claimed.claimToken;
    } catch {
      inFlight.delete(conv.id);
      return;
    }
  }

  scheduled.setStatus(conv.id, "sending");

  try {
    const prompt = await buildReferencedPrompt(
      entry.prompt,
      entry.conversationReferences ?? [],
      cliClient.createConversationShare,
      conv.id
    );
    await cliClient.attachConversationShares({ targetConversationId: conv.id, text: prompt });
    let isDelegation = false;
    if (
      delegationClient.isAvailable() &&
      (await delegationClient.hasRunForConversation(conv.id))
    ) {
      isDelegation = true;
      if (entry.messageSkills?.length) throw new Error(i18next.t("chat.teamSkillsHint"));
      const res = await delegationClient.followUp({
        conversationId: conv.id,
        prompt: composeMessageWithAttachments(prompt, entry.attachments)
      });
      if (!res.ok) throw new Error(res.error);
      await useConversationStore.getState().loadMessages(conv.id);
    } else {
      const accepted = await useConversationStore.getState().sendMessage({
        conversationId: conv.id,
        prompt,
        attachments: entry.attachments,
        messageSkills: entry.messageSkills,
        approvalModeOverride: entry.approvalMode ?? conv.approvalMode
      });
      if (!accepted) {
        if (entry.taskId && claimToken && scheduledTasksClient.isAvailable()) {
          await scheduledTasksClient
            .completeDispatch({
              id: entry.taskId,
              claimToken,
              outcome: "waiting"
            })
            .catch(() => {});
        }
        useScheduledSendStore.getState().setStatus(conv.id, "waiting");
        return;
      }
    }

    if (entry.taskId && claimToken && scheduledTasksClient.isAvailable()) {
      await scheduledTasksClient
        .completeDispatch({
          id: entry.taskId,
          claimToken,
          outcome: "sent",
          preserveAttachments: isDelegation
        })
        .catch(() => {});
    } else {
      unprotectManagedAttachments(entry.attachments);
    }
    await useScheduledSendStore.getState().remove(conv.id, { localOnly: true });
    notify(
      i18next.t("scheduledSend.sentNotification", {
        preview: truncatePromptPreview(entry.prompt || entry.attachments[0]?.name || "", 40)
      })
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (entry.taskId && claimToken && scheduledTasksClient.isAvailable()) {
      await scheduledTasksClient
        .completeDispatch({
          id: entry.taskId,
          claimToken,
          outcome: "failed",
          error: message
        })
        .catch(() => {});
    }
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
let unsubChanged: (() => void) | undefined;

/** Starts the once-per-second scheduler and DB sync; returns a stop function. Idempotent. */
export function startScheduledSendRunner(): () => void {
  if (timer === undefined) {
    void useScheduledSendStore.getState().hydrate();
    if (scheduledTasksClient.isAvailable()) {
      unsubChanged = scheduledTasksClient.onChanged((task) => {
        if (!task) {
          void useScheduledSendStore.getState().hydrate();
          return;
        }
        if (task.targetKind === "conversation_message") {
          useScheduledSendStore.getState().upsertFromTask(task);
          const now = Date.now();
          const entry = task.targetConversationId
            ? useScheduledSendStore.getState().entries[task.targetConversationId]
            : undefined;
          if (
            entry &&
            (entry.status === "pending" || entry.status === "waiting") &&
            entry.fireAt <= now
          ) {
            runScheduledSendTick(now);
          }
        }
      });
    }
    timer = setInterval(() => runScheduledSendTick(), TICK_MS);
  }
  return () => {
    if (unsubChanged) {
      unsubChanged();
      unsubChanged = undefined;
    }
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

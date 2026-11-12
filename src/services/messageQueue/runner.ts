import { cliClient } from "@/services/cli/client";
import { useConversationStore } from "@/store/conversationStore";
import { useMessageQueueStore } from "@/store/messageQueueStore";
import type { QueuedMessage } from "../../../electron/shared/messageQueueTypes";

const dispatching = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;
let subscribers = 0;

export async function dispatchQueuedMessage(entry: QueuedMessage): Promise<void> {
  const id = entry.conversationId;
  if (dispatching.has(id)) return;
  const conversationStore = useConversationStore.getState();
  const queue = useMessageQueueStore.getState().queues[id];
  if (!queue || !queue.supported || queue.paused || queue.editingId || queue.busy || queue.entries[0]?.id !== entry.id || conversationStore.isRunning(id)) return;
  dispatching.add(id);
  try {
    let conversation = conversationStore.conversations.find(item => item.id === id);
    if (!conversation) {
      conversation = await cliClient.getConversation(id);
      if (!conversation) return;
      const restored = conversation;
      useConversationStore.setState(state => ({ conversations: [...state.conversations.filter(item => item.id !== id), restored] }));
    }
    // Claiming, stable message ids and accepting the outbox item happen through
    // the same send path as manual sends. A busy result never consumes an item.
    const accepted = await useConversationStore.getState().sendMessage({
      conversationId: id, prompt: entry.prompt, attachments: entry.attachments,
      conversationReferences: entry.conversationReferences,
      messageSkills: entry.messageSkills, approvalModeOverride: entry.approvalMode,
      configOptionOverrides: entry.configOptionOverrides, hiddenContext: entry.hiddenContext,
      userMessageId: entry.userMessageId, assistantMessageId: entry.assistantMessageId, queueId: entry.id
    });
    if (!accepted) return;
  } catch (error) {
    // Keep unaccepted items in the outbox. Accepted runs persist their own error
    // in the transcript, and the host pauses the remaining queue on that event.
    await useMessageQueueStore.getState().change({ conversationId: id, action: "pause", error: (error instanceof Error ? error.message : String(error)).slice(0, 4096) }).catch(() => {});
  } finally {
    dispatching.delete(id);
    await useMessageQueueStore.getState().refresh().catch(() => {});
  }
}

export async function runMessageQueueTick(): Promise<void> {
  if (!cliClient.isMessageQueueAvailable()) return;
  try { await useMessageQueueStore.getState().refresh(); } catch { return; }
  for (const queue of Object.values(useMessageQueueStore.getState().queues)) {
    if (queue.entries[0]) void dispatchQueuedMessage(queue.entries[0]);
  }
}

export function startMessageQueueRunner(): () => void {
  if (!cliClient.isMessageQueueAvailable()) return () => {};
  subscribers += 1;
  if (!timer) {
    void runMessageQueueTick();
    timer = setInterval(() => void runMessageQueueTick(), 1500);
  }
  return () => {
    subscribers -= 1;
    if (subscribers === 0 && timer) { clearInterval(timer); timer = undefined; }
  };
}

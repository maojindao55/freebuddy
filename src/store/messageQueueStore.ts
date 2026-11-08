import { create } from "zustand";
import { cliClient } from "@/services/cli/client";
import type { MessageQueueCommand, MessageQueueSnapshot, QueuedMessageInput } from "../../electron/shared/messageQueueTypes";

interface MessageQueueState {
  queues: Record<string, MessageQueueSnapshot>;
  error?: string;
  refresh(): Promise<void>;
  change(command: MessageQueueCommand): Promise<MessageQueueSnapshot>;
  enqueue(conversationId: string, entry: QueuedMessageInput): Promise<void>;
}

// Poll responses started before a mutation must not overwrite its newer result.
let mutationRevision = 0;
let refreshInFlight: Promise<void> | undefined;
export const useMessageQueueStore = create<MessageQueueState>((set, get) => ({
  queues: {},
  async refresh() {
    if (!cliClient.isMessageQueueAvailable()) return;
    if (refreshInFlight) return refreshInFlight;
    const revision = mutationRevision;
    refreshInFlight = (async () => {
      try {
        const queues = await cliClient.listMessageQueues();
        if (revision !== mutationRevision) return;
        const next = Object.fromEntries(queues.map(queue => [queue.conversationId, queue]));
        // Stable snapshots avoid rerendering the composer on every idle poll.
        if (JSON.stringify(get().queues) !== JSON.stringify(next)) set({ queues: next, error: undefined });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally { refreshInFlight = undefined; }
    })();
    return refreshInFlight;
  },
  async change(command) {
    const revision = ++mutationRevision;
    const queue = await cliClient.changeMessageQueue(command);
    if (revision === mutationRevision) set(state => ({ queues: { ...state.queues, [command.conversationId]: queue }, error: undefined }));
    return queue;
  },
  async enqueue(conversationId, entry) {
    await get().change({ conversationId, action: "enqueue", entry });
  }
}));

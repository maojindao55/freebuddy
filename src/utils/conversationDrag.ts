import type { Conversation } from "@/services/cli/types";
import type { ConversationReferenceDraft } from "./conversationReferences";

export const CONVERSATION_DRAG_TYPE = "application/x-freebuddy-conversation";

/** Only transfer an ID; resolve display data and permissions from the app. */
export function writeConversationDrag(transfer: DataTransfer, conversationId: string): void {
  transfer.clearData();
  transfer.setData(CONVERSATION_DRAG_TYPE, JSON.stringify({ version: 1, conversationId }));
  transfer.effectAllowed = "copy";
}

export function hasConversationDrag(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(CONVERSATION_DRAG_TYPE);
}

export function resolveConversationDrag(
  transfer: DataTransfer,
  conversations: Conversation[],
  targetId?: string
): { reference: ConversationReferenceDraft; error?: never } | { reference?: never; error: "self" | "unavailable" } {
  try {
    const raw = transfer.getData(CONVERSATION_DRAG_TYPE);
    if (raw.length > 1024) return { error: "unavailable" };
    const payload: unknown = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || !("version" in payload) || payload.version !== 1 ||
      !("conversationId" in payload) || typeof payload.conversationId !== "string") return { error: "unavailable" };
    if (payload.conversationId === targetId) return { error: "self" };
    const source = conversations.find(conversation => conversation.id === payload.conversationId);
    return source ? { reference: { id: source.id, title: source.title, agentName: source.agentName } } : { error: "unavailable" };
  } catch {
    return { error: "unavailable" };
  }
}

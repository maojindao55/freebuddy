import type { ConversationContextReference } from "@/services/cli/types";

export const CONVERSATION_SHARE_LINK_RE =
  /freebuddy:\/\/conversation-share\/v1\/([a-zA-Z0-9_-]{20,})/g;

export function extractConversationShareTokens(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CONVERSATION_SHARE_LINK_RE)) {
    const token = match[1];
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

export function stripConversationShareLinks(text: string): string {
  return text
    .replace(CONVERSATION_SHARE_LINK_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countConversationShareLinks(text: string): number {
  return extractConversationShareTokens(text).length;
}

/** Only display a share ref on the user message that introduced it. */
export function assignShareReferencesToMessages<
  T extends { id: string; conversationId: string; role: string }
>(
  messages: T[],
  references: ConversationContextReference[]
): Map<string, ConversationContextReference[]> {
  const assigned = new Map<string, ConversationContextReference[]>();
  const userMessages = messages.filter((message) => message.role === "user");
  const messagesById = new Map(userMessages.map((message) => [message.id, message]));

  for (const reference of references) {
    if (reference.referenceType !== "share" || !reference.targetMessageId) continue;
    const message = messagesById.get(reference.targetMessageId);
    // The original message may be on an unloaded history page. A stale response
    // from another conversation must not attach its refs to this conversation.
    if (!message || message.conversationId !== reference.targetConversationId) continue;
    const existing = assigned.get(message.id) ?? [];
    existing.push(reference);
    assigned.set(message.id, existing);
  }

  return assigned;
}

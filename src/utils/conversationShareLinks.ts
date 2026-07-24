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

/** Pair share refs to the user messages whose text introduced them. */
export function assignShareReferencesToMessages<
  T extends { id: string; role: string; content: string; createdAt: string }
>(
  messages: T[],
  references: ConversationContextReference[]
): Map<string, ConversationContextReference[]> {
  const shareRefs = references
    .filter((reference) => reference.referenceType === "share")
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const assigned = new Map<string, ConversationContextReference[]>();
  if (shareRefs.length === 0) return assigned;

  let nextRef = 0;
  const userMessages = messages
    .filter((message) => message.role === "user")
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const message of userMessages) {
    const linkCount = countConversationShareLinks(message.content);
    if (linkCount === 0 || nextRef >= shareRefs.length) continue;
    const take = Math.min(linkCount, shareRefs.length - nextRef);
    assigned.set(message.id, shareRefs.slice(nextRef, nextRef + take));
    nextRef += take;
  }

  if (nextRef < shareRefs.length) {
    const leftovers = shareRefs.slice(nextRef);
    const fallbackId =
      [...assigned.keys()].at(-1) ??
      userMessages.find((message) => countConversationShareLinks(message.content) > 0)
        ?.id ??
      userMessages.at(-1)?.id;
    if (fallbackId) {
      assigned.set(fallbackId, [
        ...(assigned.get(fallbackId) ?? []),
        ...leftovers
      ]);
    }
  }

  return assigned;
}

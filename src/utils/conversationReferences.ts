import type { Conversation, CreateConversationShareInput, CreateConversationShareResult } from "@/services/cli/types";

export type ConversationReferenceDraft = Pick<Conversation, "id" | "title" | "agentName">;

export function findReferenceConversations(conversations: Conversation[], query: string, targetId?: string): Conversation[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return conversations.filter(conversation => conversation.id !== targetId &&
    words.every(word => `${conversation.title} ${conversation.agentName} ${conversation.cwd ?? ""}`.toLocaleLowerCase().includes(word)))
    .slice().sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt));
}

export function mergeConversationReferences(...groups: ConversationReferenceDraft[][]): ConversationReferenceDraft[] {
  return [...new Map(groups.flat().map(reference => [reference.id, reference])).values()];
}

/** Snapshot at send time through the existing authorized share API. */
export async function buildReferencedPrompt(
  prompt: string,
  references: ConversationReferenceDraft[],
  createShare: (input: CreateConversationShareInput) => Promise<CreateConversationShareResult>,
  targetId?: string
): Promise<string> {
  const unique = mergeConversationReferences(references);
  if (unique.some(reference => reference.id === targetId)) throw new Error("A conversation cannot reference itself");
  const links: string[] = [];
  for (const reference of unique) {
    const snapshot = await createShare({ sourceConversationId: reference.id });
    links.push(snapshot.link);
  }
  return [prompt.trim(), ...links].filter(Boolean).join("\n\n");
}

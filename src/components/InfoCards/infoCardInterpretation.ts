import type { ConversationMessage } from "@/services/cli/types";
import type { InfoCardSnapshot, InfoCardType } from "@/services/infoCards/types";

const MARKER_PREFIX = "[FreeBuddy info-card:";

export function isInfoCardConversation(
  messages: ConversationMessage[],
  type: InfoCardType
): boolean {
  const marker = `${MARKER_PREFIX}${type}]`;
  return messages.some(
    (message) => message.role === "user" && message.content.includes(marker)
  );
}

export function buildInfoCardPrompt(
  type: "market" | "sports",
  title: string,
  snapshot: InfoCardSnapshot,
  instruction: string
): string {
  const marker = `${MARKER_PREFIX}${type}]`;
  const data = JSON.stringify(
    {
      title,
      sourceUrl: snapshot.sourceUrl,
      fetchedAt: snapshot.fetchedAt,
      stale: snapshot.stale,
      items: snapshot.items
    },
    null,
    2
  );
  return `${marker}\n${instruction}\n\n${data}`;
}

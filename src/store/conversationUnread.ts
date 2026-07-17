const STORAGE_KEY = "freebuddy.conversations.unread.v1";

export type UnreadConversationMap = Record<string, true>;

export function loadUnreadConversations(): UnreadConversationMap {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return {};
    return Object.fromEntries(
      ids
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((id) => [id, true] as const)
    );
  } catch {
    return {};
  }
}

export function persistUnreadConversations(unread: UnreadConversationMap): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.keys(unread)));
  } catch {
    // Unread state is a progressive enhancement; storage can be unavailable.
  }
}

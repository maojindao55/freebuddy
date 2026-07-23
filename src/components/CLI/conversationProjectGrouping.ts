import type { Conversation } from "@/services/cli/types";

export const PROJECT_PREVIEW_LIMIT = 5;
export const RECENT_LIMIT = 8;

export type ConversationProjectGroup = {
  key: string;
  label: string;
  cwd?: string;
  items: Conversation[];
  latestAt: number;
};

function conversationTimeValue(conversation: Conversation) {
  return conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt;
}

export function conversationActivityTime(conversation: Conversation): number {
  const ts = Date.parse(conversationTimeValue(conversation));
  return Number.isFinite(ts) ? ts : 0;
}

/** Last path segment for sidebar project label. */
export function projectLabelFromCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * Group conversations that have a cwd into project folders, newest activity first.
 * Conversations without cwd are omitted (they belong in Recent).
 */
export function groupConversationsByProject(
  items: Conversation[]
): ConversationProjectGroup[] {
  const map = new Map<string, ConversationProjectGroup>();
  for (const conversation of items) {
    const cwd = conversation.cwd?.trim();
    if (!cwd) continue;
    const key = projectKeyFromCwd(cwd);
    const existing = map.get(key);
    const at = conversationActivityTime(conversation);
    if (existing) {
      existing.items.push(conversation);
      if (at > existing.latestAt) existing.latestAt = at;
      continue;
    }
    map.set(key, {
      key,
      label: projectLabelFromCwd(cwd),
      cwd,
      items: [conversation],
      latestAt: at
    });
  }
  const groups = Array.from(map.values());
  for (const group of groups) {
    group.items.sort((a, b) => conversationActivityTime(b) - conversationActivityTime(a));
  }
  groups.sort((a, b) => b.latestAt - a.latestAt || a.label.localeCompare(b.label));
  return groups;
}

/** Flat recent list for conversations without a project cwd. */
export function recentConversations(
  items: Conversation[],
  limit = RECENT_LIMIT
): Conversation[] {
  return items
    .filter((conversation) => !conversation.cwd?.trim())
    .sort((a, b) => conversationActivityTime(b) - conversationActivityTime(a))
    .slice(0, limit);
}

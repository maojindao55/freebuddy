import type { Conversation, Project } from "@/services/cli/types";

export const PROJECT_PREVIEW_LIMIT = 5;
/** Max project rows shown in the sidebar before "show more". */
export const PROJECT_LIST_LIMIT = 6;
export const RECENT_LIMIT = 8;

export type ConversationProjectGroup = {
  key: string;
  label: string;
  cwd?: string;
  projectId?: string;
  folders?: string[];
  primaryPath?: string;
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

export function conversationDisplayCwd(
  conversation: Pick<Conversation, "cwd" | "sourceCwd">
): string {
  return conversation.sourceCwd?.trim() || conversation.cwd?.trim() || "";
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
    const cwd = conversationDisplayCwd(conversation);
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

/**
 * Group conversations by projectId. Every project in `projects` appears even with
 * zero conversations. `key` is the project id when present.
 */
export function groupConversationsByProjects(
  items: Conversation[],
  projects: Project[]
): ConversationProjectGroup[] {
  const byProjectId = new Map<string, Conversation[]>();
  for (const conversation of items) {
    const projectId = conversation.projectId?.trim();
    if (!projectId) continue;
    const bucket = byProjectId.get(projectId);
    if (bucket) bucket.push(conversation);
    else byProjectId.set(projectId, [conversation]);
  }

  const groups: ConversationProjectGroup[] = projects.map((project) => {
    const projectItems = byProjectId.get(project.id) ?? [];
    byProjectId.delete(project.id);
    projectItems.sort(
      (a, b) => conversationActivityTime(b) - conversationActivityTime(a)
    );
    let latestAt = 0;
    for (const conversation of projectItems) {
      latestAt = Math.max(latestAt, conversationActivityTime(conversation));
    }
    return {
      key: project.id,
      projectId: project.id,
      label: project.name,
      folders: project.folders,
      primaryPath: project.primaryPath,
      cwd: project.primaryPath,
      items: projectItems,
      latestAt
    };
  });

  groups.sort((a, b) => b.latestAt - a.latestAt || a.label.localeCompare(b.label));
  return groups;
}

/**
 * Migrate pinned sidebar keys: single-folder project cwd keys → project.id.
 * Multi-folder cwd keys and already-id keys are left unchanged; duplicates dropped.
 */
export function remapPinnedCwdKeysToProjectIds(
  pinnedKeys: string[],
  projects: Project[]
): string[] {
  const cwdKeyToId = new Map<string, string>();
  for (const project of projects) {
    if (project.folders.length === 1) {
      cwdKeyToId.set(projectKeyFromCwd(project.folders[0]), project.id);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of pinnedKeys) {
    const next = cwdKeyToId.get(key) ?? key;
    if (!seen.has(next)) {
      seen.add(next);
      out.push(next);
    }
  }
  return out;
}

/**
 * Flat recent list for conversations not shown under a known project group.
 *
 * - `knownProjectIds === null`: projects not hydrated yet — keep projectId chats
 *   visible so they do not vanish while `projects === []`.
 * - `knownProjectIds` is a Set: exclude only chats whose projectId is in that set;
 *   orphans (missing project) stay in Recent.
 * - omitted (`undefined`): legacy behavior — exclude every conversation with a projectId.
 * Includes cwd-only rows so chats remain visible after deleteProject clears projectId.
 */
export function recentConversations(
  items: Conversation[],
  limit = RECENT_LIMIT,
  knownProjectIds?: ReadonlySet<string> | null
): Conversation[] {
  return items
    .filter((conversation) => {
      const projectId = conversation.projectId?.trim();
      if (!projectId) return true;
      if (knownProjectIds === null) return true;
      if (knownProjectIds === undefined) return false;
      return !knownProjectIds.has(projectId);
    })
    .sort((a, b) => conversationActivityTime(b) - conversationActivityTime(a))
    .slice(0, limit);
}

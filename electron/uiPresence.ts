export type MainWorkspaceView =
  | "chat"
  | "scheduledTasks"
  | "workflowTeams"
  | "usage"
  | "freebie";

export type MainSettingsTab =
  | "general"
  | "cli"
  | "skills"
  | "plugins"
  | "feed"
  | "remote"
  | "about";

export interface MainWindowPresence {
  workspaceView: MainWorkspaceView;
  settingsOpen: boolean;
  settingsTab: MainSettingsTab | null;
  activeConversation: {
    id: string;
    title: string;
    agentId: string;
    agentName: string;
  } | null;
  streaming: boolean;
  runningTasks: Array<{
    id: string;
    title: string;
  }>;
  completedUnreadTasks: Array<{
    id: string;
    title: string;
    result: "success" | "failure";
    completedAt: string;
  }>;
  unreadCount: number;
  updatedAt: string;
}

export type ButlerBuddyTaskKind = "running" | "completed" | "failure";

export interface ButlerBuddyTaskPresence {
  conversationId: string;
  taskText: string;
  taskKind: ButlerBuddyTaskKind;
  taskCount: number;
}

const WORKSPACE_VIEWS = new Set<MainWorkspaceView>([
  "chat",
  "scheduledTasks",
  "workflowTeams",
  "usage",
  "freebie"
]);

const SETTINGS_TABS = new Set<MainSettingsTab>([
  "general",
  "cli",
  "skills",
  "plugins",
  "feed",
  "remote",
  "about"
]);

let latestPresence: MainWindowPresence | null = null;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseMainWindowPresence(
  raw: unknown
): MainWindowPresence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!WORKSPACE_VIEWS.has(value.workspaceView as MainWorkspaceView)) return null;
  if (typeof value.settingsOpen !== "boolean") return null;
  if (typeof value.streaming !== "boolean") return null;
  if (!isNonEmptyString(value.updatedAt)) return null;

  let settingsTab: MainSettingsTab | null = null;
  if (value.settingsOpen) {
    if (!SETTINGS_TABS.has(value.settingsTab as MainSettingsTab)) return null;
    settingsTab = value.settingsTab as MainSettingsTab;
  } else if (value.settingsTab !== null && value.settingsTab !== undefined) {
    return null;
  }

  let activeConversation: MainWindowPresence["activeConversation"] = null;
  if (value.activeConversation !== null && value.activeConversation !== undefined) {
    if (
      typeof value.activeConversation !== "object" ||
      Array.isArray(value.activeConversation)
    ) {
      return null;
    }
    const conv = value.activeConversation as Record<string, unknown>;
    if (
      !isNonEmptyString(conv.id) ||
      typeof conv.title !== "string" ||
      !isNonEmptyString(conv.agentId) ||
      typeof conv.agentName !== "string"
    ) {
      return null;
    }
    activeConversation = {
      id: conv.id,
      title: conv.title,
      agentId: conv.agentId,
      agentName: conv.agentName
    };
  }

  let runningTasks: MainWindowPresence["runningTasks"] = [];
  if (value.runningTasks !== null && value.runningTasks !== undefined) {
    if (!Array.isArray(value.runningTasks) || value.runningTasks.length > 50) {
      return null;
    }
    const seenIds = new Set<string>();
    for (const item of value.runningTasks) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const task = item as Record<string, unknown>;
      if (!isNonEmptyString(task.id) || typeof task.title !== "string") {
        return null;
      }
      if (seenIds.has(task.id)) continue;
      seenIds.add(task.id);
      runningTasks.push({ id: task.id, title: task.title });
    }
  } else if (value.streaming && activeConversation) {
    // Backward compatibility for an older renderer that only reported the
    // currently selected conversation's streaming flag.
    runningTasks = [
      { id: activeConversation.id, title: activeConversation.title }
    ];
  }

  let completedUnreadTasks: MainWindowPresence["completedUnreadTasks"] = [];
  if (
    value.completedUnreadTasks !== null &&
    value.completedUnreadTasks !== undefined
  ) {
    if (
      !Array.isArray(value.completedUnreadTasks) ||
      value.completedUnreadTasks.length > 50
    ) {
      return null;
    }
    const seenIds = new Set<string>();
    for (const item of value.completedUnreadTasks) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const task = item as Record<string, unknown>;
      if (
        !isNonEmptyString(task.id) ||
        typeof task.title !== "string" ||
        (task.result !== "success" && task.result !== "failure") ||
        !isNonEmptyString(task.completedAt)
      ) {
        return null;
      }
      if (seenIds.has(task.id)) continue;
      seenIds.add(task.id);
      completedUnreadTasks.push({
        id: task.id,
        title: task.title,
        result: task.result,
        completedAt: task.completedAt
      });
    }
  }

  // unreadCount is optional for backward compatibility with older renderers
  // that don't send it yet; default to 0 when missing or invalid.
  let unreadCount = 0;
  if (value.unreadCount !== null && value.unreadCount !== undefined) {
    if (typeof value.unreadCount !== "number" || !Number.isFinite(value.unreadCount)) {
      return null;
    }
    unreadCount = Math.max(0, Math.floor(value.unreadCount));
  }

  return {
    workspaceView: value.workspaceView as MainWorkspaceView,
    settingsOpen: value.settingsOpen,
    settingsTab,
    activeConversation,
    streaming: value.streaming,
    runningTasks,
    completedUnreadTasks,
    unreadCount,
    updatedAt: value.updatedAt
  };
}

export function resolveButlerBuddyTaskPresence(
  presence: MainWindowPresence
): ButlerBuddyTaskPresence | null {
  if (presence.completedUnreadTasks.length > 0) {
    const selected = [...presence.completedUnreadTasks].sort((left, right) => {
      if (left.result !== right.result) {
        return left.result === "failure" ? -1 : 1;
      }
      return right.completedAt.localeCompare(left.completedAt);
    })[0];
    return {
      conversationId: selected.id,
      taskText: selected.title,
      taskKind: selected.result === "failure" ? "failure" : "completed",
      taskCount: presence.completedUnreadTasks.length
    };
  }
  if (presence.runningTasks.length === 0) return null;
  const activeId = presence.activeConversation?.id;
  const selected =
    presence.runningTasks.find((task) => task.id === activeId) ??
    presence.runningTasks[0];
  return {
    conversationId: selected.id,
    taskText: selected.title,
    taskKind: "running",
    taskCount: presence.runningTasks.length
  };
}

export function setMainWindowPresence(raw: unknown): boolean {
  const parsed = parseMainWindowPresence(raw);
  if (!parsed) return false;
  latestPresence = parsed;
  return true;
}

export function getMainWindowPresence(): MainWindowPresence | null {
  return latestPresence;
}

export function clearMainWindowPresence(): void {
  latestPresence = null;
}

export function formatMainWindowPresenceSummary(
  presence: MainWindowPresence
): string {
  const settings = presence.settingsOpen
    ? `settings=${presence.settingsTab}`
    : "settings=closed";
  const conversation = presence.activeConversation
    ? `conversation="${sanitizePresenceText(presence.activeConversation.title)}" (${presence.activeConversation.agentId})`
    : "conversation=none";
  return (
    `[FreeBuddy main window] view=${presence.workspaceView}; ${settings}; ` +
    `${conversation}; streaming=${presence.streaming}`
  );
}

function sanitizePresenceText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/"/g, '\\"');
}

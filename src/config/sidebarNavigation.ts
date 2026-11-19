export type PinnableSidebarNavId =
  | "todos"
  | "scheduledTasks"
  | "workflowTeams"
  | "freebie";

export const PINNABLE_SIDEBAR_NAV_IDS: readonly PinnableSidebarNavId[] = [
  "todos",
  "scheduledTasks",
  "workflowTeams",
  "freebie"
] as const;

export const DEFAULT_PINNED_SIDEBAR_ITEMS: readonly PinnableSidebarNavId[] = [
  "todos",
  "workflowTeams",
  "freebie"
] as const;

export const SIDEBAR_PINNED_ITEMS_SETTING_KEY = "ui.sidebarPinnedItems";

export interface PinnableSidebarNavDefinition {
  id: PinnableSidebarNavId;
  sidebarLabelKey: string;
  settingsLabelKey: string;
  descriptionKey: string;
}

export const PINNABLE_SIDEBAR_NAV_ITEMS: readonly PinnableSidebarNavDefinition[] = [
  {
    id: "todos",
    sidebarLabelKey: "sidebar.todos",
    settingsLabelKey: "settings.tabs.todos",
    descriptionKey: "general.sidebarShortcutTodosDescription"
  },
  {
    id: "scheduledTasks",
    sidebarLabelKey: "sidebar.scheduledTasks",
    settingsLabelKey: "settings.tabs.scheduledTasks",
    descriptionKey: "general.sidebarShortcutScheduledTasksDescription"
  },
  {
    id: "workflowTeams",
    sidebarLabelKey: "sidebar.teams",
    settingsLabelKey: "settings.tabs.workflowTeams",
    descriptionKey: "general.sidebarShortcutWorkflowTeamsDescription"
  },
  {
    id: "freebie",
    sidebarLabelKey: "sidebar.freebie",
    settingsLabelKey: "settings.tabs.freebie",
    descriptionKey: "general.sidebarShortcutFreebieDescription"
  }
] as const;

const PINNABLE_ID_SET = new Set<string>(PINNABLE_SIDEBAR_NAV_IDS);

export function isPinnableSidebarNavId(
  value: unknown
): value is PinnableSidebarNavId {
  return typeof value === "string" && PINNABLE_ID_SET.has(value);
}

export function normalizePinnedSidebarItems(
  raw: unknown
): PinnableSidebarNavId[] {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [...DEFAULT_PINNED_SIDEBAR_ITEMS];
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return [...DEFAULT_PINNED_SIDEBAR_ITEMS];
    }
  }

  if (!Array.isArray(candidate)) {
    return [...DEFAULT_PINNED_SIDEBAR_ITEMS];
  }

  const seen = new Set<PinnableSidebarNavId>();
  const result: PinnableSidebarNavId[] = [];
  for (const entry of candidate) {
    if (isPinnableSidebarNavId(entry) && !seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

export function serializePinnedSidebarItems(
  items: readonly PinnableSidebarNavId[]
): string {
  return JSON.stringify(normalizePinnedSidebarItems(items));
}

export function isDefaultPinnedSidebarItems(
  items: readonly PinnableSidebarNavId[]
): boolean {
  if (items.length !== DEFAULT_PINNED_SIDEBAR_ITEMS.length) return false;
  return items.every((item, index) => item === DEFAULT_PINNED_SIDEBAR_ITEMS[index]);
}

function isInCanonicalOrder(items: readonly PinnableSidebarNavId[]): boolean {
  let lastIndex = -1;
  for (const item of items) {
    const idx = PINNABLE_SIDEBAR_NAV_IDS.indexOf(item);
    if (idx < lastIndex) return false;
    lastIndex = idx;
  }
  return true;
}

export function togglePinnedSidebarItem(
  items: readonly PinnableSidebarNavId[],
  id: PinnableSidebarNavId,
  pinned?: boolean
): PinnableSidebarNavId[] {
  const normalized = normalizePinnedSidebarItems(items);
  const currentlyPinned = normalized.includes(id);
  const nextPinned = pinned ?? !currentlyPinned;

  if (!nextPinned) {
    return normalized.filter((entry) => entry !== id);
  }
  if (currentlyPinned) {
    return normalized;
  }

  if (isInCanonicalOrder(normalized)) {
    const targetRank = PINNABLE_SIDEBAR_NAV_IDS.indexOf(id);
    const next = [...normalized];
    const insertAt = next.findIndex(
      (entry) => PINNABLE_SIDEBAR_NAV_IDS.indexOf(entry) > targetRank
    );
    if (insertAt === -1) {
      next.push(id);
    } else {
      next.splice(insertAt, 0, id);
    }
    return next;
  }

  return [...normalized, id];
}

export function movePinnedSidebarItem(
  items: readonly PinnableSidebarNavId[],
  id: PinnableSidebarNavId,
  direction: "up" | "down"
): PinnableSidebarNavId[] {
  const normalized = normalizePinnedSidebarItems(items);
  const index = normalized.indexOf(id);
  if (index === -1) return normalized;

  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= normalized.length) {
    return normalized;
  }

  const next = [...normalized];
  const [moved] = next.splice(index, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

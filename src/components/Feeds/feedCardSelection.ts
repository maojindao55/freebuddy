import type { FeedItem, FeedSource } from "@/services/feed/types";

export const FEED_CARD_PAGE_SIZE = 5;

function itemTime(item: FeedItem): number {
  const value = item.publishedAt ?? item.createdAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

function compareNewestFirst(a: FeedItem, b: FeedItem): number {
  const timeDiff = itemTime(b) - itemTime(a);
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

export function getSelectableFeedItems(
  items: FeedItem[],
  sources: Pick<FeedSource, "id" | "enabled">[],
  sourceId = ""
): FeedItem[] {
  const enabledSourceIds = new Set(
    sources.filter((source) => source.enabled).map((source) => source.id)
  );
  const shouldFilterBySource = enabledSourceIds.size > 0;

  return items
    .filter((item) => !item.interpretedAt)
    .filter((item) => !shouldFilterBySource || enabledSourceIds.has(item.sourceId))
    .filter((item) => !sourceId || item.sourceId === sourceId)
    .slice()
    .sort(compareNewestFirst);
}

function buildSourceBalancedOrder(items: FeedItem[]): FeedItem[] {
  const firstBySource = new Map<string, FeedItem>();
  for (const item of items) {
    if (!firstBySource.has(item.sourceId)) {
      firstBySource.set(item.sourceId, item);
    }
  }

  const pinned = Array.from(firstBySource.values()).sort(compareNewestFirst);
  const pinnedIds = new Set(pinned.map((item) => item.id));
  return [
    ...pinned,
    ...items.filter((item) => !pinnedIds.has(item.id))
  ];
}

export function selectFeedCardItems({
  items,
  sources,
  sourceId = "",
  pageIndex,
  pageSize = FEED_CARD_PAGE_SIZE
}: {
  items: FeedItem[];
  sources: Pick<FeedSource, "id" | "enabled">[];
  sourceId?: string;
  pageIndex: number;
  pageSize?: number;
}): FeedItem[] {
  const selectableItems = getSelectableFeedItems(items, sources, sourceId);
  const orderedItems = buildSourceBalancedOrder(selectableItems);
  const offset = Math.max(0, pageIndex) * pageSize;
  const page = orderedItems.slice(offset, offset + pageSize);
  if (page.length || offset === 0) return page;
  return orderedItems.slice(0, pageSize);
}

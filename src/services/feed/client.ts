import type {
  AddFeedSourceInput,
  FeedItem,
  FeedRefreshResult,
  FeedSource,
  UpdateFeedSourceInput
} from "./types";

function api() {
  const feed = window.freebuddy?.feed;
  if (!feed) {
    throw new Error("Feed bridge unavailable");
  }
  return feed;
}

export const feedClient = {
  isAvailable(): boolean {
    return Boolean(window.freebuddy?.feed);
  },

  listSources(): Promise<FeedSource[]> {
    return api().listSources();
  },
  addSource(input: AddFeedSourceInput): Promise<FeedSource> {
    return api().addSource(input);
  },
  updateSource(input: UpdateFeedSourceInput): Promise<FeedSource | undefined> {
    return api().updateSource(input);
  },
  deleteSource(id: string): Promise<boolean> {
    return api().deleteSource(id);
  },
  listItems(args?: { limit?: number; offset?: number }): Promise<FeedItem[]> {
    return api().listItems(args);
  },
  refreshSource(id: string): Promise<FeedRefreshResult> {
    return api().refreshSource(id);
  },
  refreshAll(): Promise<FeedRefreshResult[]> {
    return api().refreshAll();
  },
  markInterpreted(id: string): Promise<FeedItem | undefined> {
    return api().markInterpreted(id);
  }
};

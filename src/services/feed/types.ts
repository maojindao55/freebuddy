export interface FeedSource {
  id: string;
  title: string;
  url: string;
  enabled: boolean;
  lastFetchedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedItem {
  id: string;
  sourceId: string;
  sourceTitle: string;
  title: string;
  link: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
  rawId?: string;
  readAt?: string;
  interpretedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddFeedSourceInput {
  title?: string;
  url: string;
  enabled?: boolean;
}

export interface UpdateFeedSourceInput {
  id: string;
  title?: string;
  url?: string;
  enabled?: boolean;
}

export interface FeedRefreshResult {
  sourceId: string;
  ok: boolean;
  added: number;
  updated: number;
  error?: string;
}

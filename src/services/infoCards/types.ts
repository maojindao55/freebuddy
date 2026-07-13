export type InfoCardType = "rss" | "market" | "sports";

export interface BrowserExtractionRecipe {
  url: string;
  waitForSelector?: string;
  rowSelector: string;
  fields: Record<string, string>;
  maxItems?: number;
}

export interface InfoCardConfig {
  id: string;
  type: InfoCardType;
  title: string;
  enabled: boolean;
  order: number;
  refreshMinutes: number;
  recipe?: BrowserExtractionRecipe;
  createdAt: string;
  updatedAt: string;
}

export interface InfoCardSnapshot {
  cardId: string;
  sourceUrl?: string;
  items: Array<Record<string, string>>;
  fetchedAt?: string;
  lastError?: string;
  stale: boolean;
}

export interface CreateInfoCardInput {
  type: "market" | "sports";
  title?: string;
}

export interface UpdateInfoCardInput {
  id: string;
  title?: string;
  enabled?: boolean;
  order?: number;
  refreshMinutes?: number;
  recipe?: BrowserExtractionRecipe | null;
}

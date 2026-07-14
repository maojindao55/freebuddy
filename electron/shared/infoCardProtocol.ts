export type InfoCardType = "rss" | "market" | "sports";
export type SportsDateOffset = -1 | 0 | 1;

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
  marketSymbols?: string[];
  sportsDateOffset?: SportsDateOffset;
  createdAt: string;
  updatedAt: string;
}

export interface MarketProviderConfig {
  id: "ashare";
  name: string;
  sourceUrl: string;
  configured: boolean;
}

export interface MarketSymbolSearchResult {
  symbol: string;
  code: string;
  name: string;
  exchange: "sh" | "sz";
  securityType: string;
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
  type: Exclude<InfoCardType, "rss">;
  title?: string;
}

export interface UpdateInfoCardInput {
  id: string;
  title?: string;
  enabled?: boolean;
  order?: number;
  refreshMinutes?: number;
  marketSymbols?: string[];
  sportsDateOffset?: SportsDateOffset;
}

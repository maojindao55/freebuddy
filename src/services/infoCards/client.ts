import type {
  CreateInfoCardInput,
  InfoCardConfig,
  InfoCardSnapshot,
  MarketProviderConfig,
  MarketSymbolSearchResult,
  UpdateInfoCardInput
} from "./types";

function api() {
  const cards = window.freebuddy?.infoCards;
  if (!cards) throw new Error("Information card bridge unavailable");
  return cards;
}

export const infoCardClient = {
  isAvailable(): boolean {
    return Boolean(window.freebuddy?.infoCards);
  },
  list(): Promise<InfoCardConfig[]> {
    return api().list();
  },
  create(input: CreateInfoCardInput): Promise<InfoCardConfig> {
    return api().create(input);
  },
  update(input: UpdateInfoCardInput): Promise<InfoCardConfig | undefined> {
    return api().update(input);
  },
  delete(id: string): Promise<boolean> {
    return api().delete(id);
  },
  reorder(ids: string[]): Promise<InfoCardConfig[]> {
    return api().reorder(ids);
  },
  snapshot(id: string): Promise<InfoCardSnapshot> {
    return api().snapshot(id);
  },
  refresh(id: string, timeZone?: string): Promise<InfoCardSnapshot> {
    return api().refresh(id, timeZone);
  },
  marketProvider(): Promise<MarketProviderConfig> {
    return api().marketProvider();
  },
  searchMarketSymbols(query: string): Promise<MarketSymbolSearchResult[]> {
    return api().searchMarketSymbols(query);
  }
};

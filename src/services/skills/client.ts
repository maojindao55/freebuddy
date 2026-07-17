import type {
  MarketInstallRequest,
  MarketInstallResult,
  MarketProviderInfo,
  MarketSearchResult,
  SkillImportResult,
  SkillMarketProviderId,
  SkillRecord
} from "./types";

function api() {
  const skills = window.freebuddy?.skills;
  if (!skills) throw new Error("Skill API is unavailable");
  return skills;
}

export const skillsClient = {
  list: (): Promise<SkillRecord[]> => api().list(),
  import: (sourcePath: string): Promise<SkillImportResult> =>
    api().import(sourcePath),
  setEnabled: (id: string, enabled: boolean): Promise<SkillRecord | undefined> =>
    api().setEnabled(id, enabled),
  setTrusted: (id: string, trusted: boolean): Promise<SkillRecord | undefined> =>
    api().setTrusted(id, trusted),
  delete: (id: string): Promise<boolean> => api().delete(id),
  read: (id: string): Promise<string | undefined> => api().read(id),
  selectDirectory: (): Promise<string | null> => api().selectDirectory(),
  selectArchive: (): Promise<string | null> => api().selectArchive(),
  reveal: (id: string): Promise<boolean> => api().reveal(id),
  marketProviders: (): Promise<MarketProviderInfo[]> => api().marketProviders(),
  getMarketProvider: (): Promise<SkillMarketProviderId> => api().getMarketProvider(),
  setMarketProvider: (provider: SkillMarketProviderId): Promise<SkillMarketProviderId> =>
    api().setMarketProvider(provider),
  searchMarket: (args: {
    provider?: SkillMarketProviderId;
    query?: string;
    cursor?: string;
    limit?: number;
  }): Promise<MarketSearchResult> => api().searchMarket(args),
  installFromMarket: (request: MarketInstallRequest): Promise<MarketInstallResult> =>
    api().installFromMarket(request),
  openMarketUrl: (url: string): Promise<boolean> => api().openMarketUrl(url),
  resolveMarketHomepage: (args: {
    provider: SkillMarketProviderId;
    slug: string;
    ownerHandle?: string;
    version?: string;
    downloadsHint?: number;
  }): Promise<string | null> => api().resolveMarketHomepage(args)
};

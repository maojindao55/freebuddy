export type SkillSource = "builtin" | "imported" | "market";

export type SkillMarketProviderId = "skillhub.cn" | "clawhub.ai";

export type MarketScanStatus =
  | "clean"
  | "suspicious"
  | "malware"
  | "unscanned"
  | "unknown";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  rootPath: string;
  contentHash: string;
  enabled: boolean;
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
  marketProvider?: SkillMarketProviderId | null;
  marketSkillId?: string | null;
  marketSlug?: string | null;
  marketVersion?: string | null;
  marketUrl?: string | null;
  marketContentHash?: string | null;
}

export interface SkillSnapshot {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  rootPath: string;
  contentHash: string;
}

export interface SkillImportResult {
  imported: SkillRecord[];
  errors: Array<{ path: string; message: string }>;
}

export interface MarketSkill {
  provider: SkillMarketProviderId;
  marketSkillId: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloads: number;
  stars: number;
  homepageUrl: string;
  scanStatus: MarketScanStatus;
  ownerHandle?: string;
}

export interface MarketSearchResult {
  items: MarketSkill[];
  nextCursor?: string | null;
  total?: number;
}

export interface MarketProviderInfo {
  id: SkillMarketProviderId;
  label: string;
  homepageUrl: string;
}

export interface MarketInstallRequest {
  provider: SkillMarketProviderId;
  marketSkillId: string;
  slug: string;
  version?: string;
  ownerHandle?: string;
  downloadsHint?: number;
  allowSuspicious?: boolean;
  allowLocalOverwrite?: boolean;
}

export interface MarketInstallResult {
  skill: SkillRecord;
  updated: boolean;
}

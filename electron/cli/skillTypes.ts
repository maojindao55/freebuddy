import { z } from "zod";

export type SkillSource = "builtin" | "imported" | "market";

export type SkillMarketProviderId = "skillhub.cn" | "clawhub.ai";

/** Prefixed IPC/user-facing errors that require an explicit install confirmation. */
export const MARKET_CONFIRMATION_PREFIX = "MARKET_CONFIRMATION_REQUIRED";

/**
 * Parse confirmation markers from bare errors or Electron-wrapped
 * `ipcRenderer.invoke` messages.
 */
export function parseMarketConfirmationError(
  message: string
): { reason: string; detail: string } | undefined {
  const marker = `${MARKET_CONFIRMATION_PREFIX}:`;
  const index = message.indexOf(marker);
  if (index < 0) return undefined;
  const rest = message.slice(index + marker.length);
  const split = rest.indexOf(":");
  if (split < 0) return { reason: rest, detail: rest };
  return {
    reason: rest.slice(0, split),
    detail: rest.slice(split + 1)
  };
}

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
  /** List/search download count used to disambiguate slug-only ClawHub installs. */
  downloadsHint?: number;
  allowSuspicious?: boolean;
  /** Overwrite an installed market skill after local file edits were detected. */
  allowLocalOverwrite?: boolean;
}

const marketInstallRequestSchema = z
  .object({
    provider: z.enum(["skillhub.cn", "clawhub.ai"]),
    marketSkillId: z.string().trim().min(1).max(300),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    version: z.string().trim().min(1).max(64).optional(),
    ownerHandle: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .optional(),
    downloadsHint: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
    // Strict booleans only — string "false" must not become truthy.
    allowSuspicious: z.boolean().optional(),
    allowLocalOverwrite: z.boolean().optional()
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.provider === "skillhub.cn") {
      if (data.marketSkillId !== data.slug) {
        ctx.addIssue({
          code: "custom",
          path: ["marketSkillId"],
          message: "SkillHub marketSkillId must equal slug"
        });
      }
      if (data.ownerHandle) {
        ctx.addIssue({
          code: "custom",
          path: ["ownerHandle"],
          message: "SkillHub install requests must not include ownerHandle"
        });
      }
      return;
    }

    const slash = data.marketSkillId.indexOf("/");
    if (slash > 0) {
      const owner = data.marketSkillId.slice(0, slash);
      const idSlug = data.marketSkillId.slice(slash + 1);
      if (idSlug !== data.slug) {
        ctx.addIssue({
          code: "custom",
          path: ["marketSkillId"],
          message: "ClawHub marketSkillId slug segment must equal slug"
        });
      }
      if (data.ownerHandle && data.ownerHandle !== owner) {
        ctx.addIssue({
          code: "custom",
          path: ["ownerHandle"],
          message: "ClawHub ownerHandle must match marketSkillId"
        });
      }
      return;
    }

    if (data.marketSkillId !== data.slug) {
      ctx.addIssue({
        code: "custom",
        path: ["marketSkillId"],
        message: "ClawHub marketSkillId must be slug or owner/slug"
      });
    }
    if (data.ownerHandle) {
      ctx.addIssue({
        code: "custom",
        path: ["marketSkillId"],
        message: "ClawHub marketSkillId must be owner/slug when ownerHandle is set"
      });
    }
  });

/** Runtime-validate renderer IPC payloads before market install. */
export function parseMarketInstallRequest(raw: unknown): MarketInstallRequest {
  const parsed = marketInstallRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid market install request: ${parsed.error.issues[0]?.message ?? "invalid"}`
    );
  }
  return parsed.data;
}

export interface MarketInstallResult {
  skill: SkillRecord;
  updated: boolean;
}

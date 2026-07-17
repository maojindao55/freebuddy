import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getDataDir } from "./db.js";
import { extractGitHubZipSkillPath, extractSkillArchive } from "./skillArchive.js";
import { getSetting, setSetting } from "./settings.js";
import {
  assertClawhubContentHash,
  assertClawhubFileManifest,
  attachPersistedClawhubIdentitiesToItems,
  clawhubHomepageUrl,
  downloadClawhubSkill,
  resolveClawhubIdentity,
  searchClawhub,
  type ClawhubFileManifestEntry,
  type ClawhubGithubHandoff
} from "./skillMarketProviders/clawhub.js";
import {
  downloadSkillhubSkill,
  searchSkillhub,
  verifySkillhubPackage
} from "./skillMarketProviders/skillhub.js";
import { installPreparedSkill, listSkills, parseSkillMarkdown } from "./skills.js";
import type {
  MarketInstallRequest,
  MarketInstallResult,
  MarketProviderInfo,
  MarketScanStatus,
  MarketSearchResult,
  SkillMarketProviderId
} from "./skillTypes.js";
import {
  MARKET_CONFIRMATION_PREFIX,
  parseMarketConfirmationError,
  parseMarketInstallRequest
} from "./skillTypes.js";

export const SKILL_MARKET_PROVIDER_SETTING = "skills.marketProvider";
export const DEFAULT_SKILL_MARKET_PROVIDER: SkillMarketProviderId = "skillhub.cn";
export {
  MARKET_CONFIRMATION_PREFIX,
  parseMarketConfirmationError,
  parseMarketInstallRequest
};

const PROVIDERS: MarketProviderInfo[] = [
  {
    id: "skillhub.cn",
    label: "skillhub.cn",
    homepageUrl: "https://skillhub.cn"
  },
  {
    id: "clawhub.ai",
    label: "clawhub.ai",
    homepageUrl: "https://clawhub.ai"
  }
];

const ALLOWED_HOMEPAGE_HOSTS = new Set([
  "skillhub.cn",
  "www.skillhub.cn",
  "api.skillhub.cn",
  "clawhub.ai",
  "www.clawhub.ai",
  "github.com",
  "www.github.com"
]);

function isProviderId(value: unknown): value is SkillMarketProviderId {
  return value === "skillhub.cn" || value === "clawhub.ai";
}

export function listSkillMarketProviders(): MarketProviderInfo[] {
  return PROVIDERS;
}

export function getSkillMarketProvider(): SkillMarketProviderId {
  const stored = getSetting(SKILL_MARKET_PROVIDER_SETTING);
  return isProviderId(stored) ? stored : DEFAULT_SKILL_MARKET_PROVIDER;
}

export function setSkillMarketProvider(
  provider: SkillMarketProviderId
): SkillMarketProviderId {
  if (!isProviderId(provider)) {
    throw new Error(`Unsupported skill market provider: ${String(provider)}`);
  }
  setSetting(SKILL_MARKET_PROVIDER_SETTING, provider);
  return provider;
}

/**
 * Attach persisted ClawHub owner identity to owner-less list cards when exactly
 * one installed skill matches the slug. Avoids N+1 network lookups while keeping
 * installed/update UI stable across restarts and provider switches.
 */
export function attachPersistedClawhubIdentities(
  result: MarketSearchResult
): MarketSearchResult {
  const installed = listSkills()
    .filter(
      (skill) =>
        skill.source === "market" &&
        skill.marketProvider === "clawhub.ai" &&
        skill.marketSlug &&
        skill.marketSkillId
    )
    .map((skill) => ({
      marketSlug: skill.marketSlug,
      marketSkillId: skill.marketSkillId
    }));
  return {
    ...result,
    items: attachPersistedClawhubIdentitiesToItems(result.items, installed)
  };
}

export { attachPersistedClawhubIdentitiesToItems };

export async function searchSkillMarket(args: {
  provider?: SkillMarketProviderId;
  query?: string;
  cursor?: string;
  limit?: number;
}): Promise<MarketSearchResult> {
  const provider = args.provider ?? getSkillMarketProvider();
  if (provider === "skillhub.cn") {
    return searchSkillhub({
      query: args.query,
      cursor: args.cursor,
      limit: args.limit
    });
  }
  if (provider === "clawhub.ai") {
    const result = await searchClawhub({
      query: args.query,
      cursor: args.cursor,
      limit: args.limit
    });
    return attachPersistedClawhubIdentities(result);
  }
  throw new Error(`Unsupported skill market provider: ${String(provider)}`);
}

function parseOwnerFromMarketSkillId(
  provider: SkillMarketProviderId,
  marketSkillId: string,
  slug: string
): string | undefined {
  if (provider !== "clawhub.ai") return undefined;
  if (marketSkillId.includes("/")) {
    const [owner, rest] = marketSkillId.split("/");
    if (rest === slug) return owner;
  }
  return undefined;
}

export function marketConfirmationError(
  reason: MarketScanStatus | "unsigned",
  detail: string
): Error {
  return new Error(`${MARKET_CONFIRMATION_PREFIX}:${reason}:${detail}`);
}

function requiresConfirmation(status: MarketScanStatus): boolean {
  return status === "suspicious" || status === "unscanned" || status === "unknown";
}

export async function installSkillFromMarket(
  rawRequest: MarketInstallRequest | unknown
): Promise<MarketInstallResult> {
  const request = parseMarketInstallRequest(rawRequest);

  const downloadRoot = path.join(
    getDataDir(),
    "skill-imports",
    `.market-${crypto.randomUUID()}`
  );
  const zipPath = path.join(downloadRoot, "skill.zip");
  fs.mkdirSync(downloadRoot, { recursive: true });

  try {
    let remoteContentHash: string | undefined;
    let trusted = false;
    let contentBound = false;
    let ownerHandle =
      request.ownerHandle ||
      parseOwnerFromMarketSkillId(
        request.provider,
        request.marketSkillId,
        request.slug
      );
    let resolvedVersion = request.version || "";
    let githubHandoff: ClawhubGithubHandoff | undefined;
    let fileManifest: ClawhubFileManifestEntry[] | undefined;
    let clawhubScanStatus: MarketScanStatus | undefined;

    if (request.provider === "skillhub.cn") {
      await downloadSkillhubSkill({
        slug: request.slug,
        version: request.version,
        destination: zipPath
      });
    } else {
      const result = await downloadClawhubSkill({
        slug: request.slug,
        version: request.version,
        ownerHandle,
        downloadsHint: request.downloadsHint,
        destination: zipPath
      });
      remoteContentHash = result.contentHash;
      ownerHandle = result.identity.ownerHandle;
      resolvedVersion = result.identity.version;
      githubHandoff = result.githubHandoff;
      fileManifest = result.fileManifest;
      clawhubScanStatus = result.scanStatus;
      if (result.scanStatus === "malware") {
        throw new Error("This ClawHub skill version is blocked as malware");
      }
      if (requiresConfirmation(result.scanStatus) && !request.allowSuspicious) {
        throw marketConfirmationError(
          result.scanStatus,
          "This market skill has not been cleared by security scanning. Confirm to continue."
        );
      }
    }

    const extractionRoot = path.join(downloadRoot, "extracted");
    let candidate = extractionRoot;
    if (githubHandoff) {
      // Only extract the handoff path so root/sibling decoy SKILL.md files cannot win.
      extractGitHubZipSkillPath(zipPath, extractionRoot, githubHandoff.path);
      if (!fs.existsSync(path.join(candidate, "SKILL.md"))) {
        throw new Error(
          `GitHub handoff path "${githubHandoff.path}" does not contain SKILL.md`
        );
      }
      assertClawhubContentHash(candidate, githubHandoff.contentHash);
      remoteContentHash = githubHandoff.contentHash;
      contentBound = true;
    } else {
      extractSkillArchive(zipPath, extractionRoot);
      if (!fs.existsSync(path.join(candidate, "SKILL.md"))) {
        const nested = fs
          .readdirSync(candidate, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(candidate, entry.name))
          .find((dir) => fs.existsSync(path.join(dir, "SKILL.md")));
        if (!nested) throw new Error("Downloaded package does not contain SKILL.md");
        candidate = nested;
      }
      if (request.provider === "clawhub.ai") {
        if (!fileManifest || fileManifest.length === 0) {
          throw new Error(
            "ClawHub version is missing a file integrity manifest; refuse to install an unbound package"
          );
        }
        remoteContentHash = assertClawhubFileManifest(candidate, fileManifest);
        contentBound = true;
      }
    }

    if (request.provider === "skillhub.cn") {
      const markdown = fs.readFileSync(path.join(candidate, "SKILL.md"), "utf8");
      const parsed = parseSkillMarkdown(markdown);
      const version =
        request.version && request.version !== "latest"
          ? request.version
          : parsed.version;
      const verified = await verifySkillhubPackage({
        slug: request.slug,
        version,
        zipPath
      });
      remoteContentHash = verified.contentHash;
      if (verified.status === "unsigned") {
        if (!request.allowSuspicious) {
          throw marketConfirmationError(
            "unsigned",
            "This SkillHub package is unsigned. Confirm to install it as an unendorsed skill."
          );
        }
        // Confirmation only permits install; unsigned packages stay untrusted.
        trusted = false;
      } else {
        trusted = true;
      }
    } else {
      // Confirmation only permits install. Trust requires a clean scan + bound content.
      trusted = clawhubScanStatus === "clean" && contentBound;
    }

    const homepageUrl =
      request.provider === "skillhub.cn"
        ? `https://skillhub.cn/skills/${encodeURIComponent(request.slug)}`
        : clawhubHomepageUrl(request.slug, ownerHandle);

    // Always derive market identity from the resolved install — never persist a
    // renderer-supplied marketSkillId that could disagree with slug/owner.
    const marketSkillId =
      request.provider === "clawhub.ai" && ownerHandle
        ? `${ownerHandle}/${request.slug}`
        : request.slug;

    const { skill, updated } = installPreparedSkill(candidate, {
      source: "market",
      trusted,
      allowLocalOverwrite: request.allowLocalOverwrite,
      market: {
        provider: request.provider,
        marketSkillId,
        marketSlug: request.slug,
        marketVersion: resolvedVersion || request.version || "latest",
        marketUrl: homepageUrl,
        marketContentHash: remoteContentHash
      }
    });

    return { skill, updated };
  } finally {
    fs.rmSync(downloadRoot, { recursive: true, force: true });
  }
}

export function isAllowedSkillMarketHomepage(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "https:" && ALLOWED_HOMEPAGE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Resolve a browseable homepage; ClawHub list cards omit owner until this runs. */
export async function resolveSkillMarketHomepage(args: {
  provider: SkillMarketProviderId;
  slug: string;
  ownerHandle?: string;
  version?: string;
  downloadsHint?: number;
}): Promise<string | null> {
  if (!isProviderId(args.provider) || !args.slug?.trim()) return null;
  if (args.provider === "skillhub.cn") {
    return `https://skillhub.cn/skills/${encodeURIComponent(args.slug.trim())}`;
  }
  const existing = clawhubHomepageUrl(args.slug, args.ownerHandle);
  if (existing) return existing;
  try {
    const identity = await resolveClawhubIdentity({
      slug: args.slug,
      ownerHandle: args.ownerHandle,
      version: args.version,
      downloadsHint: args.downloadsHint
    });
    return clawhubHomepageUrl(args.slug, identity.ownerHandle) || null;
  } catch {
    return null;
  }
}

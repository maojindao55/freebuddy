import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import ignore from "ignore";

import type {
  MarketScanStatus,
  MarketSearchResult,
  MarketSkill,
  SkillMarketProviderId
} from "../skillTypes.js";
import { normalizeGitHubSourcePath } from "../skillArchive.js";
import {
  marketDownloadToFile,
  marketFetch,
  marketFetchJson,
  marketWriteResponseToFile,
  MAX_MARKET_ERROR_BYTES,
  MAX_MARKET_JSON_BYTES,
  readMarketResponseJson,
  readMarketResponseText,
  withMarketRequestTimeout
} from "../skillMarketHttp.js";

export const CLAWHUB_PROVIDER_ID: SkillMarketProviderId = "clawhub.ai";
export const CLAWHUB_API_HOSTS = new Set(["clawhub.ai", "www.clawhub.ai"]);
export const CLAWHUB_DOWNLOAD_HOSTS = new Set([
  ...CLAWHUB_API_HOSTS,
  "api.github.com",
  "github.com",
  "www.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com"
]);

/** Matches ClawHub CLI text-file fingerprinting for GitHub handoff contentHash. */
const CLAWHUB_TEXT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "json5",
  "yaml",
  "yml",
  "toml",
  "js",
  "cjs",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sh",
  "ps1",
  "psm1",
  "psd1",
  "r",
  "rb",
  "go",
  "rs",
  "swift",
  "kt",
  "java",
  "cs",
  "cpp",
  "c",
  "h",
  "hpp",
  "sql",
  "csv",
  "tsv",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "dat",
  "xml",
  "html",
  "css",
  "scss",
  "sass",
  "svg"
]);

const API_BASE = "https://clawhub.ai/api/v1";

interface ClawhubListItem {
  slug?: string;
  displayName?: string;
  summary?: string;
  description?: string | null;
  tags?: { latest?: string };
  stats?: { downloads?: number; installs?: number; stars?: number };
  latestVersion?: { version?: string };
  ownerHandle?: string;
  owner?: { handle?: string };
}

interface ClawhubSearchHit {
  slug?: string;
  displayName?: string;
  summary?: string;
  version?: string | null;
  downloads?: number;
  ownerHandle?: string;
  owner?: { handle?: string };
}

interface ClawhubScannerResult {
  status?: string;
  normalizedStatus?: string;
  verdict?: string;
  severity?: string;
  recommendation?: string;
}

interface ClawhubScanResponse {
  moderation?: {
    isSuspicious?: boolean;
    isMalwareBlocked?: boolean;
    isPendingScan?: boolean;
    verdict?: string;
    /**
     * ClawHub moderation is a skill-level snapshot of the latest version.
     * Only trust it for the requested version when this flag is true.
     */
    matchesRequestedVersion?: boolean;
    sourceVersion?: string;
  } | null;
  security?: {
    status?: string;
    hasScanResult?: boolean;
    hasWarnings?: boolean;
    normalizedStatus?: string;
    verdict?: string;
    scanners?: Record<string, ClawhubScannerResult | null | undefined>;
  } | null;
}

interface GithubHandoff {
  sourceRef?: string;
  archiveUrl?: string;
  contentHash?: string;
  repo?: string;
  commit?: string;
  path?: string;
}

export interface ClawhubIdentity {
  ownerHandle: string;
  version: string;
}

export interface ClawhubGithubHandoff {
  repo: string;
  commit: string;
  path: string;
  contentHash: string;
  archiveUrl: string;
}

interface OwnerCandidate {
  ownerHandle: string;
  downloads: number;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ownerOf(item: {
  ownerHandle?: string;
  owner?: { handle?: string };
}): string {
  return text(item.ownerHandle) || text(item.owner?.handle);
}

function marketSkillId(slug: string, ownerHandle?: string): string {
  return ownerHandle ? `${ownerHandle}/${slug}` : slug;
}

/** Owner-qualified homepage only — bare `/skills/{slug}` is treated as an owner path by the site. */
export function clawhubHomepageUrl(slug: string, ownerHandle?: string): string {
  if (!ownerHandle?.trim() || !slug.trim()) return "";
  return `https://clawhub.ai/${encodeURIComponent(ownerHandle.trim())}/skills/${encodeURIComponent(slug.trim())}`;
}

function scannerEntries(
  scanners?: Record<string, ClawhubScannerResult | null | undefined> | null
): ClawhubScannerResult[] {
  if (!scanners || typeof scanners !== "object") return [];
  return Object.values(scanners).flatMap((entry) =>
    entry && typeof entry === "object" ? [entry] : []
  );
}

function statusToken(value: unknown): string {
  return text(value).toLowerCase();
}

function isMalwareToken(value: string): boolean {
  return (
    value === "malware" ||
    value === "malicious" ||
    value === "blocked" ||
    value.includes("do_not_install") ||
    value.includes("do-not-install")
  );
}

function isSuspiciousToken(value: string): boolean {
  return (
    value === "suspicious" ||
    value === "flagged" ||
    value === "caution" ||
    value === "critical" ||
    value === "high"
  );
}

function rankScanStatus(status: MarketScanStatus): number {
  switch (status) {
    case "malware":
      return 4;
    case "suspicious":
      return 3;
    case "unscanned":
    case "unknown":
      return 2;
    case "clean":
      return 1;
    default:
      return 0;
  }
}

function worstScanStatus(statuses: MarketScanStatus[]): MarketScanStatus {
  return statuses.reduce<MarketScanStatus>((worst, current) => {
    return rankScanStatus(current) > rankScanStatus(worst) ? current : worst;
  }, "clean");
}

function statusFromToken(token: string): MarketScanStatus | undefined {
  if (!token) return undefined;
  if (isMalwareToken(token)) return "malware";
  if (isSuspiciousToken(token)) return "suspicious";
  if (token === "clean" || token === "benign" || token === "ok") return "clean";
  if (token === "unscanned" || token === "pending" || token === "complete") {
    return token === "complete" ? undefined : "unscanned";
  }
  return undefined;
}

function moderationAppliesToRequestedVersion(
  moderation: ClawhubScanResponse["moderation"],
  requestedVersion?: string
): boolean {
  if (!moderation || moderation.matchesRequestedVersion !== true) return false;
  if (!requestedVersion || requestedVersion === "latest") return true;
  const sourceVersion = text(moderation.sourceVersion);
  if (!sourceVersion) return true;
  return sourceVersion === text(requestedVersion);
}

export function scanStatusFromClawhubScan(
  data: ClawhubScanResponse,
  requestedVersion?: string
): MarketScanStatus {
  const moderation = data.moderation;
  const security = data.security;
  const scanners = scannerEntries(security?.scanners);
  const useModeration = moderationAppliesToRequestedVersion(moderation, requestedVersion);

  // Inspect every verdict field independently so an earlier "complete"/"clean"
  // status cannot hide a later malware/suspicious verdict.
  // Moderation is latest-version scoped — only merge when it matches the request.
  const tokens = [
    statusToken(security?.status),
    statusToken(security?.normalizedStatus),
    statusToken(security?.verdict),
    ...(useModeration ? [statusToken(moderation?.verdict)] : []),
    ...scanners.flatMap((scanner) => [
      statusToken(scanner.status),
      statusToken(scanner.normalizedStatus),
      statusToken(scanner.verdict),
      statusToken(scanner.recommendation),
      statusToken(scanner.severity)
    ])
  ];

  const fromTokens = tokens
    .map(statusFromToken)
    .filter((value): value is MarketScanStatus => Boolean(value));

  if (useModeration) {
    if (moderation?.isMalwareBlocked) fromTokens.push("malware");
    if (moderation?.isSuspicious) fromTokens.push("suspicious");
    if (moderation?.isPendingScan) fromTokens.push("unscanned");
  }
  if (security?.hasScanResult === false) fromTokens.push("unscanned");
  // hasWarnings alone is not enough: scanners may report benign/ok with advisory notes.
  // Only escalate when a normalized scanner token is actually suspicious or malware.
  if (security?.hasWarnings === true) {
    const warningStatuses = scanners.flatMap((scanner) =>
      [
        statusToken(scanner.status),
        statusToken(scanner.normalizedStatus),
        statusToken(scanner.verdict)
      ]
        .map(statusFromToken)
        .filter((value): value is MarketScanStatus => Boolean(value))
    );
    if (
      warningStatuses.some(
        (status) => status === "suspicious" || status === "malware"
      )
    ) {
      fromTokens.push("suspicious");
    }
  }

  if (fromTokens.length > 0) {
    return worstScanStatus(fromTokens);
  }
  // Historical versions often omit security while moderation still reflects latest.
  if (!security) return "unscanned";
  return "unknown";
}

function mapListItem(item: ClawhubListItem): MarketSkill {
  const slug = text(item.slug);
  const ownerHandle = ownerOf(item) || undefined;
  const version =
    text(item.latestVersion?.version) || text(item.tags?.latest) || "";
  return {
    provider: CLAWHUB_PROVIDER_ID,
    marketSkillId: marketSkillId(slug, ownerHandle),
    slug,
    name: text(item.displayName, slug),
    description: text(item.summary) || text(item.description),
    version,
    author: ownerHandle || "unknown",
    downloads: number(item.stats?.downloads) || number(item.stats?.installs),
    stars: number(item.stats?.stars),
    homepageUrl: clawhubHomepageUrl(slug, ownerHandle),
    scanStatus: "clean",
    ownerHandle
  };
}

function mapSearchHit(item: ClawhubSearchHit): MarketSkill {
  const slug = text(item.slug);
  const ownerHandle = ownerOf(item) || undefined;
  return {
    provider: CLAWHUB_PROVIDER_ID,
    marketSkillId: marketSkillId(slug, ownerHandle),
    slug,
    name: text(item.displayName, slug),
    description: text(item.summary),
    version: text(item.version),
    author: ownerHandle || "unknown",
    downloads: number(item.downloads),
    stars: 0,
    homepageUrl: clawhubHomepageUrl(slug, ownerHandle),
    scanStatus: "clean",
    ownerHandle
  };
}

async function fetchExactSlugCandidates(slug: string): Promise<OwnerCandidate[]> {
  const url = new URL(`${API_BASE}/search`);
  url.searchParams.set("q", slug);
  url.searchParams.set("limit", "20");
  url.searchParams.set("nonSuspiciousOnly", "true");
  const data = await marketFetchJson<{ results?: ClawhubSearchHit[] }>(
    url.toString(),
    CLAWHUB_API_HOSTS
  );
  const seen = new Set<string>();
  const candidates: OwnerCandidate[] = [];
  for (const hit of data.results ?? []) {
    if (text(hit.slug) !== slug) continue;
    const ownerHandle = ownerOf(hit);
    if (!ownerHandle || seen.has(ownerHandle)) continue;
    seen.add(ownerHandle);
    candidates.push({
      ownerHandle,
      downloads: number(hit.downloads)
    });
  }
  return candidates;
}

async function latestVersionForOwner(
  slug: string,
  ownerHandle: string
): Promise<string> {
  const url = new URL(`${API_BASE}/skills/${encodeURIComponent(slug)}`);
  url.searchParams.set("ownerHandle", ownerHandle);
  const data = await marketFetchJson<{
    latestVersion?: { version?: string };
    skill?: { tags?: { latest?: string } };
  }>(url.toString(), CLAWHUB_API_HOSTS);
  return text(data.latestVersion?.version) || text(data.skill?.tags?.latest);
}

/**
 * Resolve a stable ClawHub (owner, version) pair.
 * Never attaches a list/search version to a different owner's identity.
 */
export async function resolveClawhubIdentity(args: {
  slug: string;
  ownerHandle?: string;
  version?: string;
  downloadsHint?: number;
}): Promise<ClawhubIdentity> {
  const slug = text(args.slug);
  if (!slug) throw new Error("ClawHub skill slug is required");
  const wantedVersion =
    text(args.version) && text(args.version) !== "latest"
      ? text(args.version)
      : "";

  if (args.ownerHandle?.trim()) {
    const ownerHandle = args.ownerHandle.trim();
    const version = wantedVersion || (await latestVersionForOwner(slug, ownerHandle));
    if (!version) {
      throw new Error(`Could not resolve version for @${ownerHandle}/${slug}`);
    }
    return { ownerHandle, version };
  }

  const candidates = await fetchExactSlugCandidates(slug);
  if (candidates.length === 0) {
    throw new Error(`No ClawHub skill found for slug "${slug}"`);
  }

  const pick = async (ownerHandle: string): Promise<ClawhubIdentity> => {
    const version = wantedVersion || (await latestVersionForOwner(slug, ownerHandle));
    if (!version) {
      throw new Error(`Could not resolve version for @${ownerHandle}/${slug}`);
    }
    return { ownerHandle, version };
  };

  if (candidates.length === 1) {
    return pick(candidates[0].ownerHandle);
  }

  // Prefer an exact downloads match from the list card stats when present.
  const downloadsHint = number(args.downloadsHint);
  if (downloadsHint > 0) {
    const byDownloads = candidates.filter((entry) => entry.downloads === downloadsHint);
    if (byDownloads.length === 1) {
      const identity = await pick(byDownloads[0].ownerHandle);
      if (!wantedVersion || identity.version === wantedVersion) {
        return identity;
      }
    }
  }

  // When a concrete version is known, accept only a unique owner that publishes it.
  if (wantedVersion) {
    const matches: ClawhubIdentity[] = [];
    for (const candidate of candidates) {
      try {
        const latest = await latestVersionForOwner(slug, candidate.ownerHandle);
        if (latest === wantedVersion) {
          matches.push({ ownerHandle: candidate.ownerHandle, version: wantedVersion });
        }
      } catch {
        // Try the next candidate.
      }
    }
    if (matches.length === 1) return matches[0];
    throw new Error(
      `Ambiguous ClawHub slug "${slug}" for version ${wantedVersion}; specify ownerHandle`
    );
  }

  // Never guess the highest-download author when multiple publishers share a slug.
  throw new Error(`Ambiguous ClawHub slug "${slug}"; specify ownerHandle`);
}

function withIdentity(skill: MarketSkill, identity: ClawhubIdentity): MarketSkill {
  return {
    ...skill,
    ownerHandle: identity.ownerHandle,
    author: identity.ownerHandle,
    version: identity.version,
    marketSkillId: marketSkillId(skill.slug, identity.ownerHandle),
    homepageUrl: clawhubHomepageUrl(skill.slug, identity.ownerHandle)
  };
}

/**
 * Attach persisted owner identity to owner-less list cards when exactly one
 * installed skill matches the slug. Pure helper — no network or Electron deps.
 */
export function attachPersistedClawhubIdentitiesToItems(
  items: MarketSkill[],
  installed: Array<{ marketSlug?: string | null; marketSkillId?: string | null }>
): MarketSkill[] {
  const installedBySlug = new Map<string, string[]>();
  for (const skill of installed) {
    if (!skill.marketSlug || !skill.marketSkillId?.includes("/")) continue;
    const list = installedBySlug.get(skill.marketSlug) ?? [];
    list.push(skill.marketSkillId);
    installedBySlug.set(skill.marketSlug, list);
  }

  return items.map((item) => {
    if (item.ownerHandle) return item;
    const matches = [...new Set(installedBySlug.get(item.slug) ?? [])];
    if (matches.length !== 1) return item;
    const nextId = matches[0];
    const ownerHandle = nextId.slice(0, nextId.length - item.slug.length - 1);
    if (!ownerHandle || nextId !== `${ownerHandle}/${item.slug}`) return item;
    return {
      ...item,
      ownerHandle,
      author: ownerHandle,
      marketSkillId: nextId,
      homepageUrl: clawhubHomepageUrl(item.slug, ownerHandle)
    };
  });
}

export async function searchClawhub(args: {
  query?: string;
  cursor?: string;
  limit?: number;
}): Promise<MarketSearchResult> {
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 50);
  const query = args.query?.trim() ?? "";

  if (query) {
    const url = new URL(`${API_BASE}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("nonSuspiciousOnly", "true");
    const data = await marketFetchJson<{ results?: ClawhubSearchHit[] }>(
      url.toString(),
      CLAWHUB_API_HOSTS
    );
    const mapped = (data.results ?? [])
      .filter((item) => text(item.slug))
      .map(mapSearchHit);
    const items = await Promise.all(
      mapped.map(async (skill) => {
        if (skill.ownerHandle && skill.version) return skill;
        if (!skill.ownerHandle) return skill;
        try {
          const identity = await resolveClawhubIdentity({
            slug: skill.slug,
            ownerHandle: skill.ownerHandle,
            version: skill.version
          });
          return withIdentity(skill, identity);
        } catch {
          return skill;
        }
      })
    );
    return {
      items,
      nextCursor: null,
      total: data.results?.length
    };
  }

  const url = new URL(`${API_BASE}/skills`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "downloads");
  url.searchParams.set("nonSuspiciousOnly", "true");
  if (args.cursor) url.searchParams.set("cursor", args.cursor);
  const data = await marketFetchJson<{
    items?: ClawhubListItem[];
    nextCursor?: string | null;
  }>(url.toString(), CLAWHUB_API_HOSTS);

  // List cards use only the /skills payload. Do not N+1 resolve owners via /search —
  // install-time resolveClawhubIdentity() handles ambiguous slugs with downloadsHint.
  const items = (data.items ?? [])
    .filter((item) => text(item.slug))
    .map(mapListItem);

  return {
    items,
    nextCursor: data.nextCursor ?? null
  };
}

export async function getClawhubScanStatus(args: {
  slug: string;
  ownerHandle?: string;
  version?: string;
}): Promise<MarketScanStatus> {
  const url = new URL(`${API_BASE}/skills/${encodeURIComponent(args.slug)}/scan`);
  if (args.ownerHandle) url.searchParams.set("ownerHandle", args.ownerHandle);
  if (args.version && args.version !== "latest") {
    url.searchParams.set("version", args.version);
  }
  try {
    const data = await marketFetchJson<ClawhubScanResponse>(url.toString(), CLAWHUB_API_HOSTS);
    return scanStatusFromClawhubScan(data, args.version);
  } catch {
    return "unscanned";
  }
}

function isValidGitHubRepo(repo: string): boolean {
  const [owner, name, ...rest] = repo.split("/");
  return Boolean(owner && name && rest.length === 0 && !owner.includes("..") && !name.includes(".."));
}

export function expectedGitHubZipballUrl(repo: string, commit: string): string {
  const [owner, name] = repo.split("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    name
  )}/zipball/${encodeURIComponent(commit)}`;
}

export function parseClawhubGithubHandoff(raw: GithubHandoff): ClawhubGithubHandoff {
  if (raw.sourceRef !== "public-github") {
    throw new Error("Unsupported ClawHub download descriptor");
  }
  const repo = text(raw.repo);
  const commit = text(raw.commit);
  const contentHash = text(raw.contentHash);
  const archiveUrl = text(raw.archiveUrl);
  const skillPathRaw = text(raw.path);
  if (!repo || !commit || !contentHash || !archiveUrl || !skillPathRaw) {
    throw new Error(
      "ClawHub GitHub handoff is missing repo, commit, path, contentHash, or archiveUrl"
    );
  }
  if (!isValidGitHubRepo(repo)) {
    throw new Error(`Invalid GitHub repo in ClawHub handoff: ${repo}`);
  }
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
    throw new Error(`Invalid GitHub commit in ClawHub handoff: ${commit}`);
  }
  const skillPath = normalizeGitHubSourcePath(skillPathRaw);
  const expected = expectedGitHubZipballUrl(repo, commit);
  let parsedArchive: URL;
  try {
    parsedArchive = new URL(archiveUrl);
  } catch {
    throw new Error("ClawHub GitHub handoff archiveUrl is invalid");
  }
  if (parsedArchive.href !== expected) {
    throw new Error("ClawHub GitHub handoff archiveUrl does not match repo/commit");
  }
  return {
    repo,
    commit,
    path: skillPath,
    contentHash,
    archiveUrl: expected
  };
}

function fileExtension(relativePath: string): string {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function hasDotPathSegment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

function isLikelyTextBytes(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 4096);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function readIgnoreLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

/** Matches ClawHub CLI: .gitignore / .clawhubignore / .clawdhubignore + defaults. */
function createClawhubIgnoreMatcher(root: string) {
  const ig = ignore();
  ig.add([".git/", "node_modules/", ".clawhub/", ".clawdhub/"]);
  for (const name of [".gitignore", ".clawhubignore", ".clawdhubignore"]) {
    const lines = readIgnoreLines(path.join(root, name));
    if (lines.length > 0) ig.add(lines);
  }
  return ig;
}

function listClawhubHashFiles(root: string): Array<{ path: string; bytes: Buffer }> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const ig = createClawhubIgnoreMatcher(root);
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!relative || hasDotPathSegment(relative)) continue;
      if (ig.ignores(relative)) continue;
      const ext = fileExtension(relative);
      const bytes = fs.readFileSync(absolute);
      if (ext) {
        if (!CLAWHUB_TEXT_EXTENSIONS.has(ext)) continue;
      } else if (!isLikelyTextBytes(bytes)) {
        continue;
      }
      files.push({ path: relative, bytes });
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** ClawHub fingerprint: sha256 of sorted `path:fileSha256` lines. */
export function computeClawhubContentHash(skillRoot: string): string {
  const files = listClawhubHashFiles(skillRoot);
  const payload = files
    .map((file) => {
      const digest = crypto.createHash("sha256").update(file.bytes).digest("hex");
      return `${file.path}:${digest}`;
    })
    .join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function assertClawhubContentHash(skillRoot: string, expected: string): void {
  const actual = computeClawhubContentHash(skillRoot);
  if (actual !== expected) {
    throw new Error("ClawHub GitHub handoff content hash mismatch");
  }
}

export interface ClawhubFileManifestEntry {
  path: string;
  sha256: string;
}

const CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE = "_meta.json";

function normalizeManifestPath(relative: string): string {
  return relative.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function listSkillRootFiles(skillRoot: string): Array<{ path: string; bytes: Buffer }> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = normalizeManifestPath(path.relative(skillRoot, absolute));
      if (!relative || relative.includes("..")) continue;
      files.push({ path: relative, bytes: fs.readFileSync(absolute) });
    }
  };
  visit(skillRoot);
  return files;
}

/**
 * Verify extracted skill files against ClawHub version `files[]` metadata.
 * Allows generated `_meta.json`; rejects missing, mismatched, or unexpected paths.
 * Returns a stable digest of the verified manifest for persistence.
 */
export function assertClawhubFileManifest(
  skillRoot: string,
  files: ClawhubFileManifestEntry[]
): string {
  if (!files.length) {
    throw new Error("ClawHub version file manifest is empty");
  }
  const expected = new Map<string, string>();
  for (const entry of files) {
    const relative = normalizeManifestPath(text(entry.path));
    const sha256 = text(entry.sha256).toLowerCase();
    if (!relative || relative.includes("..") || relative.includes("\0")) {
      throw new Error(`ClawHub file manifest has an invalid path: ${entry.path}`);
    }
    if (relative === CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE) {
      throw new Error("ClawHub file manifest must not include generated _meta.json");
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`ClawHub file manifest has an invalid sha256 for ${relative}`);
    }
    if (expected.has(relative)) {
      throw new Error(`ClawHub file manifest has a duplicate path: ${relative}`);
    }
    expected.set(relative, sha256);
  }

  const actual = new Map<string, string>();
  for (const file of listSkillRootFiles(skillRoot)) {
    if (file.path === CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE) {
      continue;
    }
    actual.set(file.path, crypto.createHash("sha256").update(file.bytes).digest("hex"));
  }

  for (const [relative, sha256] of expected) {
    const got = actual.get(relative);
    if (!got) {
      throw new Error(`ClawHub package is missing manifest file: ${relative}`);
    }
    if (got !== sha256) {
      throw new Error(`ClawHub package file hash mismatch: ${relative}`);
    }
    actual.delete(relative);
  }
  if (actual.size > 0) {
    const unexpected = [...actual.keys()].sort()[0];
    throw new Error(`ClawHub package contains unexpected file: ${unexpected}`);
  }

  const payload = [...expected.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relative, sha256]) => `${relative}:${sha256}`)
    .join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

interface ClawhubVersionDetail {
  version?: {
    version?: string;
    files?: Array<{ path?: string; sha256?: string }>;
  };
}

export async function fetchClawhubVersionFileManifest(args: {
  slug: string;
  ownerHandle: string;
  version: string;
}): Promise<ClawhubFileManifestEntry[]> {
  const url = new URL(
    `${API_BASE}/skills/${encodeURIComponent(args.slug)}/versions/${encodeURIComponent(args.version)}`
  );
  url.searchParams.set("ownerHandle", args.ownerHandle);
  const data = await marketFetchJson<ClawhubVersionDetail>(url.toString(), CLAWHUB_API_HOSTS);
  const files: ClawhubFileManifestEntry[] = [];
  for (const entry of data.version?.files ?? []) {
    const relative = normalizeManifestPath(text(entry.path));
    const sha256 = text(entry.sha256).toLowerCase();
    if (!relative || !/^[0-9a-f]{64}$/.test(sha256)) continue;
    files.push({ path: relative, sha256 });
  }
  return files;
}

export async function downloadClawhubSkill(args: {
  slug: string;
  version?: string;
  ownerHandle?: string;
  destination: string;
  downloadsHint?: number;
}): Promise<{
  contentHash?: string;
  scanStatus: MarketScanStatus;
  identity: ClawhubIdentity;
  githubHandoff?: ClawhubGithubHandoff;
  fileManifest?: ClawhubFileManifestEntry[];
}> {
  const identity = await resolveClawhubIdentity({
    slug: args.slug,
    ownerHandle: args.ownerHandle,
    version: args.version,
    downloadsHint: args.downloadsHint
  });

  const [scanStatus, fileManifest] = await Promise.all([
    getClawhubScanStatus({
      slug: args.slug,
      ownerHandle: identity.ownerHandle,
      version: identity.version
    }),
    fetchClawhubVersionFileManifest({
      slug: args.slug,
      ownerHandle: identity.ownerHandle,
      version: identity.version
    }).catch(() => [] as ClawhubFileManifestEntry[])
  ]);
  if (scanStatus === "malware") {
    throw new Error("This ClawHub skill version is blocked as malware");
  }

  const url = new URL(`${API_BASE}/download`);
  url.searchParams.set("slug", args.slug);
  url.searchParams.set("version", identity.version);
  url.searchParams.set("ownerHandle", identity.ownerHandle);

  // One timeout covers redirect/headers and the ZIP/handoff body write.
  return withMarketRequestTimeout(60_000, async (signal) => {
    const { response } = await marketFetch(
      url.toString(),
      CLAWHUB_API_HOSTS,
      undefined,
      60_000,
      signal
    );
    if (!response.ok) {
      const message =
        (
          await readMarketResponseText(response, MAX_MARKET_ERROR_BYTES, signal)
        ).trim() || `Download failed (${response.status})`;
      throw new Error(message);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const handoff = parseClawhubGithubHandoff(
        await readMarketResponseJson<GithubHandoff>(
          response,
          MAX_MARKET_JSON_BYTES,
          signal
        )
      );
      await marketDownloadToFile(
        handoff.archiveUrl,
        args.destination,
        CLAWHUB_DOWNLOAD_HOSTS,
        undefined,
        60_000,
        signal
      );
      return {
        contentHash: handoff.contentHash,
        scanStatus,
        identity,
        githubHandoff: handoff
      };
    }

    // Hosted ZIP: bind install trust to the version files[] manifest (not scan status alone).
    await marketWriteResponseToFile(response, args.destination, undefined, signal);
    return { scanStatus, identity, fileManifest };
  });
}

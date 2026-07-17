import crypto from "node:crypto";
import fs from "node:fs";

import AdmZip from "adm-zip";

import type {
  MarketSearchResult,
  MarketSkill,
  SkillMarketProviderId
} from "../skillTypes.js";
import { marketDownloadToFile, marketFetchJson } from "../skillMarketHttp.js";

export const SKILLHUB_PROVIDER_ID: SkillMarketProviderId = "skillhub.cn";
export const SKILLHUB_API_HOSTS = new Set(["api.skillhub.cn"]);

/** Exact HTTPS hosts allowed for SkillHub package downloads and redirects. */
export const SKILLHUB_DOWNLOAD_HOSTS = new Set([
  ...SKILLHUB_API_HOSTS,
  "skillhub.cn",
  "www.skillhub.cn",
  "skillhub-1388575217.cos.ap-guangzhou.myqcloud.com",
  "skillhub-1388575217.cos.accelerate.myqcloud.com"
]);

const API_BASE = "https://api.skillhub.cn";

interface SkillhubListItem {
  slug?: string;
  name?: string;
  description?: string;
  description_zh?: string;
  version?: string;
  ownerName?: string;
  downloads?: number;
  installs?: number;
  stars?: number;
  homepage?: string;
  upstream_url?: string;
}

interface SkillhubListResponse {
  code?: number;
  message?: string;
  data?: {
    skills?: SkillhubListItem[];
    total?: number;
  };
}

interface SkillhubSignatureResponse {
  content_hash?: string;
  key_id?: string;
  payload?: string;
  signature?: string;
  signed?: boolean;
  package_md5?: string;
}

interface SkillhubPlatformKey {
  key_id?: string;
  algorithm?: string;
  public_key_raw_b64?: string;
  status?: string;
}

interface SignaturePayload {
  content_hash?: string;
  package_md5?: string;
  skill_slug?: string;
  skill_version?: string;
  file_count?: number;
  issuer?: string;
}

export type SkillhubVerifyResult =
  | { status: "verified"; contentHash: string }
  | { status: "unsigned"; contentHash?: string };

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldIgnoreZipEntry(relativePath: string): boolean {
  const parts = relativePath.split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  if (!base) return true;
  if (parts.includes("__MACOSX")) return true;
  if (base === "_meta.json" || base === ".DS_Store" || base === "Thumbs.db") return true;
  if (base.startsWith("._")) return true;
  return false;
}

/** SkillHub official content fingerprint for a local ZIP package. */
export function computeSkillhubContentHash(zipPath: string): {
  contentHash: string;
  fileCount: number;
} {
  const archive = new AdmZip(zipPath);
  const entries: Array<{ path: string; hash: string }> = [];
  for (const entry of archive.getEntries()) {
    if (entry.isDirectory) continue;
    const relative = entry.entryName.replaceAll("\\", "/");
    if (!relative || shouldIgnoreZipEntry(relative)) continue;
    entries.push({
      path: relative,
      hash: crypto.createHash("sha256").update(entry.getData()).digest("hex")
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const joined = entries.map((entry) => `${entry.path}:${entry.hash}\n`).join("");
  return {
    contentHash: crypto.createHash("sha256").update(Buffer.from(joined, "utf8")).digest("hex"),
    fileCount: entries.length
  };
}

function mapItem(item: SkillhubListItem): MarketSkill {
  const slug = text(item.slug);
  const author = text(item.ownerName, "unknown");
  const homepage = text(item.homepage);
  const upstream = text(item.upstream_url);
  const fallback = `https://skillhub.cn/skills/${encodeURIComponent(slug)}`;
  return {
    provider: SKILLHUB_PROVIDER_ID,
    marketSkillId: slug,
    slug,
    name: text(item.name, slug),
    description: text(item.description_zh) || text(item.description),
    version: text(item.version, "latest"),
    author,
    downloads: number(item.installs) || number(item.downloads),
    stars: number(item.stars),
    homepageUrl:
      upstream ||
      (homepage.includes("api.skillhub.cn") ? fallback : homepage) ||
      fallback,
    scanStatus: "unknown"
  };
}

export async function searchSkillhub(args: {
  query?: string;
  cursor?: string;
  limit?: number;
}): Promise<MarketSearchResult> {
  const pageSize = Math.min(Math.max(args.limit ?? 30, 1), 50);
  const page = Math.max(1, Number(args.cursor ?? "1") || 1);
  const url = new URL(`${API_BASE}/api/skills`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("sortBy", "downloads");
  url.searchParams.set("order", "desc");
  if (args.query?.trim()) url.searchParams.set("keyword", args.query.trim());

  const data = await marketFetchJson<SkillhubListResponse>(url.toString(), SKILLHUB_API_HOSTS);
  if (data.code !== 0) {
    throw new Error(text(data.message, "SkillHub search failed"));
  }
  const skills = data.data?.skills ?? [];
  const total = number(data.data?.total);
  const loaded = page * pageSize;
  return {
    items: skills.filter((item) => text(item.slug)).map(mapItem),
    nextCursor: loaded < total ? String(page + 1) : null,
    total
  };
}

async function getPlatformPublicKey(keyId: string): Promise<Buffer> {
  const data = await marketFetchJson<{ keys?: SkillhubPlatformKey[] }>(
    `${API_BASE}/api/v1/open/platform/keys`,
    SKILLHUB_API_HOSTS
  );
  const key = (data.keys ?? []).find(
    (entry) => entry.key_id === keyId && entry.status === "active"
  );
  if (!key?.public_key_raw_b64) {
    throw new Error(`SkillHub signing key ${keyId} was not found`);
  }
  return Buffer.from(key.public_key_raw_b64, "base64");
}

export async function verifySkillhubPackage(args: {
  slug: string;
  version: string;
  zipPath: string;
}): Promise<SkillhubVerifyResult> {
  const url =
    `${API_BASE}/api/v1/open/skills/${encodeURIComponent(args.slug)}` +
    `/versions/${encodeURIComponent(args.version)}/signature`;
  let signature: SkillhubSignatureResponse;
  try {
    signature = await marketFetchJson<SkillhubSignatureResponse>(url, SKILLHUB_API_HOSTS);
  } catch (error) {
    throw new Error(
      `SkillHub signature metadata unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const local = computeSkillhubContentHash(args.zipPath);
  const localMd5 = crypto.createHash("md5").update(fs.readFileSync(args.zipPath)).digest("hex");

  // Only an explicit signed===false path is unsigned. Missing/invalid signed is fail-closed.
  if (signature.signed === false) {
    if (
      signature.content_hash &&
      signature.content_hash !== local.contentHash
    ) {
      throw new Error("SkillHub package content hash does not match unsigned metadata");
    }
    return { status: "unsigned", contentHash: local.contentHash };
  }

  if (signature.signed !== true) {
    throw new Error("SkillHub signature response is missing a valid signed flag");
  }
  if (!signature.payload || !signature.signature || !signature.key_id) {
    throw new Error("SkillHub signature response is incomplete");
  }

  let payload: SignaturePayload;
  try {
    payload = JSON.parse(signature.payload) as SignaturePayload;
  } catch {
    throw new Error("SkillHub signature payload is not valid JSON");
  }

  if (text(payload.skill_slug) !== args.slug) {
    throw new Error("SkillHub signature payload slug mismatch");
  }
  if (text(payload.skill_version) !== args.version) {
    throw new Error("SkillHub signature payload version mismatch");
  }

  const expectedHash = text(payload.content_hash);
  if (!expectedHash) {
    throw new Error("SkillHub signature payload is missing content_hash");
  }
  if (expectedHash !== local.contentHash) {
    throw new Error("SkillHub package content hash does not match the signed metadata");
  }
  if (typeof payload.file_count !== "number") {
    throw new Error("SkillHub signature payload is missing file_count");
  }
  if (payload.file_count !== local.fileCount) {
    throw new Error("SkillHub package file count does not match the signed metadata");
  }

  const expectedMd5 = text(payload.package_md5);
  if (!expectedMd5) {
    throw new Error("SkillHub signature payload is missing package_md5");
  }
  if (expectedMd5 !== localMd5) {
    throw new Error("SkillHub package MD5 does not match the signed metadata");
  }

  const publicKey = await getPlatformPublicKey(signature.key_id);
  const keyObject = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicKey
    ]),
    format: "der",
    type: "spki"
  });
  const ok = crypto.verify(
    null,
    Buffer.from(signature.payload, "utf8"),
    keyObject,
    Buffer.from(signature.signature, "base64")
  );
  if (!ok) throw new Error("SkillHub package signature verification failed");

  return { status: "verified", contentHash: local.contentHash };
}

export async function downloadSkillhubSkill(args: {
  slug: string;
  version?: string;
  destination: string;
}): Promise<void> {
  const url = new URL(`${API_BASE}/api/v1/download`);
  url.searchParams.set("slug", args.slug);
  if (args.version && args.version !== "latest") {
    url.searchParams.set("version", args.version);
  }
  await marketDownloadToFile(url.toString(), args.destination, SKILLHUB_DOWNLOAD_HOSTS);
}

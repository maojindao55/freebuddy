import crypto from "node:crypto";

import { getDb } from "./db.js";

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

function nowIso(): string {
  return new Date().toISOString();
}

function stableId(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 24);
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https feed URLs are supported");
  }
  return parsed.toString();
}

function rowToSource(row: any): FeedSource {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    enabled: row.enabled !== 0,
    lastFetchedAt: row.last_fetched_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToItem(row: any): FeedItem {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    title: row.title,
    link: row.link,
    summary: row.summary ?? undefined,
    author: row.author ?? undefined,
    publishedAt: row.published_at ?? undefined,
    rawId: row.raw_id ?? undefined,
    readAt: row.read_at ?? undefined,
    interpretedAt: row.interpreted_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listFeedSources(): FeedSource[] {
  return (getDb()
    .prepare("SELECT * FROM feed_sources ORDER BY created_at DESC")
    .all() as any[]).map(rowToSource);
}

export function addFeedSource(input: AddFeedSourceInput): FeedSource {
  const url = normalizeUrl(input.url);
  const title = input.title?.trim() || new URL(url).hostname;
  const id = stableId(url);
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO feed_sources
         (id, title, url, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title=excluded.title,
         enabled=excluded.enabled,
         updated_at=excluded.updated_at`
    )
    .run(id, title, url, input.enabled === false ? 0 : 1, now, now);
  return getFeedSourceByUrl(url) as FeedSource;
}

export function updateFeedSource(input: UpdateFeedSourceInput): FeedSource | undefined {
  const current = getFeedSource(input.id);
  if (!current) return undefined;
  const url = input.url === undefined ? current.url : normalizeUrl(input.url);
  const title = input.title === undefined ? current.title : input.title.trim();
  const enabled = input.enabled === undefined ? current.enabled : input.enabled;
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE feed_sources
       SET title = ?, url = ?, enabled = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(title || new URL(url).hostname, url, enabled ? 1 : 0, now, input.id);
  return getFeedSource(input.id);
}

export function deleteFeedSource(id: string): boolean {
  const result = getDb().prepare("DELETE FROM feed_sources WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getFeedSource(id: string): FeedSource | undefined {
  const row = getDb().prepare("SELECT * FROM feed_sources WHERE id = ?").get(id) as any;
  return row ? rowToSource(row) : undefined;
}

function getFeedSourceByUrl(url: string): FeedSource | undefined {
  const row = getDb().prepare("SELECT * FROM feed_sources WHERE url = ?").get(url) as any;
  return row ? rowToSource(row) : undefined;
}

export function listFeedItems(args: { limit?: number; offset?: number } = {}): FeedItem[] {
  const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
  const offset = Math.max(0, args.offset ?? 0);
  return (getDb()
    .prepare(
      `SELECT
         i.*,
         s.title AS source_title
       FROM feed_items i
       JOIN feed_sources s ON s.id = i.source_id
       ORDER BY COALESCE(i.published_at, i.created_at) DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as any[]).map(rowToItem);
}

export function markFeedItemInterpreted(id: string): FeedItem | undefined {
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE feed_items
       SET read_at = COALESCE(read_at, ?),
           interpreted_at = COALESCE(interpreted_at, ?),
           updated_at = ?
       WHERE id = ?`
    )
    .run(now, now, now, id);
  return getFeedItem(id);
}

function getFeedItem(id: string): FeedItem | undefined {
  const row = getDb()
    .prepare(
      `SELECT i.*, s.title AS source_title
       FROM feed_items i
       JOIN feed_sources s ON s.id = i.source_id
       WHERE i.id = ?`
    )
    .get(id) as any;
  return row ? rowToItem(row) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

function stripHtml(value: string): string {
  return decodeXml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(xml: string, names: string[]): string | undefined {
  for (const name of names) {
    const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match?.[1]) return decodeXml(match[1]);
  }
  return undefined;
}

function firstAttr(xml: string, tagName: string, attrName: string): string | undefined {
  const tag = xml.match(new RegExp(`<${tagName}\\b[^>]*>`, "i"))?.[0];
  if (!tag) return undefined;
  const attr = tag.match(new RegExp(`${attrName}=["']([^"']+)["']`, "i"));
  return attr?.[1] ? decodeXml(attr[1]) : undefined;
}

function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return undefined;
  return new Date(ts).toISOString();
}

interface ParsedFeedItem {
  title: string;
  link: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
  rawId?: string;
}

function splitBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi");
  for (const match of xml.matchAll(pattern)) {
    blocks.push(match[0]);
  }
  return blocks;
}

function parseRss(xml: string): { title?: string; items: ParsedFeedItem[] } {
  const title = firstTag(xml, ["channel\\s*>[\\s\\S]*?<title", "title"]);
  const items = splitBlocks(xml, "item").map((block) => {
    const itemTitle = stripHtml(firstTag(block, ["title"]) ?? "");
    const link = decodeXml(firstTag(block, ["link"]) ?? "");
    const summary = stripHtml(
      firstTag(block, ["description", "content:encoded", "summary"]) ?? ""
    );
    return {
      title: itemTitle,
      link,
      summary: summary || undefined,
      author: stripHtml(firstTag(block, ["author", "dc:creator"]) ?? "") || undefined,
      publishedAt: parseDate(firstTag(block, ["pubDate", "published", "updated"])),
      rawId: firstTag(block, ["guid", "id"])
    };
  });
  return { title: title ? stripHtml(title) : undefined, items };
}

function parseAtom(xml: string): { title?: string; items: ParsedFeedItem[] } {
  const feedTitle = firstTag(xml, ["title"]);
  const items = splitBlocks(xml, "entry").map((block) => {
    const link =
      firstAttr(block, "link", "href") ??
      decodeXml(firstTag(block, ["link"]) ?? "");
    const summary = stripHtml(firstTag(block, ["summary", "content"]) ?? "");
    return {
      title: stripHtml(firstTag(block, ["title"]) ?? ""),
      link,
      summary: summary || undefined,
      author: stripHtml(firstTag(block, ["name", "author"]) ?? "") || undefined,
      publishedAt: parseDate(firstTag(block, ["published", "updated"])),
      rawId: firstTag(block, ["id"])
    };
  });
  return { title: feedTitle ? stripHtml(feedTitle) : undefined, items };
}

function absolutizeUrl(link: string, baseUrl: string): string {
  try {
    return new URL(link, baseUrl).toString();
  } catch {
    return link;
  }
}

function parseFeed(xml: string, sourceUrl: string): { title?: string; items: ParsedFeedItem[] } {
  const parsed = splitBlocks(xml, "entry").length ? parseAtom(xml) : parseRss(xml);
  return {
    title: parsed.title,
    items: parsed.items
      .map((item) => ({
        ...item,
        link: absolutizeUrl(item.link, sourceUrl)
      }))
      .filter((item) => item.title && item.link)
  };
}

export async function refreshFeedSource(id: string): Promise<FeedRefreshResult> {
  const source = getFeedSource(id);
  if (!source) {
    return { sourceId: id, ok: false, added: 0, updated: 0, error: "Feed source not found" };
  }

  try {
    const response = await fetch(source.url, {
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "user-agent": "FreeBuddy/FeedReader"
      }
    });
    if (!response.ok) {
      throw new Error(`Fetch failed with HTTP ${response.status}`);
    }
    const xml = await response.text();
    const parsed = parseFeed(xml, source.url);
    const now = nowIso();
    let added = 0;
    let updated = 0;
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO feed_items
         (id, source_id, title, link, summary, author, published_at, raw_id, created_at, updated_at)
       VALUES (@id, @source_id, @title, @link, @summary, @author, @published_at, @raw_id, @created_at, @updated_at)
       ON CONFLICT(source_id, link) DO UPDATE SET
         title=excluded.title,
         summary=excluded.summary,
         author=excluded.author,
         published_at=COALESCE(excluded.published_at, feed_items.published_at),
         raw_id=COALESCE(excluded.raw_id, feed_items.raw_id),
         updated_at=excluded.updated_at`
    );
    const insertMany = db.transaction((items: ParsedFeedItem[]) => {
      for (const item of items.slice(0, 100)) {
        const result = insert.run({
          id: stableId(`${source.id}:${item.rawId || item.link}`),
          source_id: source.id,
          title: item.title,
          link: item.link,
          summary: item.summary ?? null,
          author: item.author ?? null,
          published_at: item.publishedAt ?? null,
          raw_id: item.rawId ?? null,
          created_at: now,
          updated_at: now
        });
        if (result.changes > 0) {
          const existed = db
            .prepare("SELECT created_at <> updated_at AS updated FROM feed_items WHERE id = ?")
            .get(stableId(`${source.id}:${item.rawId || item.link}`)) as { updated: number } | undefined;
          if (existed?.updated) updated += 1;
          else added += 1;
        }
      }
    });
    insertMany(parsed.items);
    db.prepare(
      `UPDATE feed_sources
       SET title = ?, last_fetched_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(parsed.title || source.title, now, now, source.id);
    return { sourceId: source.id, ok: true, added, updated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = nowIso();
    getDb()
      .prepare(
        `UPDATE feed_sources
         SET last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(message, now, source.id);
    return { sourceId: source.id, ok: false, added: 0, updated: 0, error: message };
  }
}

export async function refreshAllFeedSources(): Promise<FeedRefreshResult[]> {
  const sources = listFeedSources().filter((source) => source.enabled);
  const results: FeedRefreshResult[] = [];
  for (const source of sources) {
    results.push(await refreshFeedSource(source.id));
  }
  return results;
}

import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";

import { safeSendToWebContents } from "./ipcSend.js";
import {
  ASHARE_SOURCE_URL,
  fetchAshareQuotes,
  normalizeAshareSymbol,
  searchAshareSecurities
} from "./ashareMarket.js";
import {
  fetchNbaScores,
  SPORTS_EVENTS_SOURCE_URL
} from "./sportsEvents.js";
import type {
  CreateInfoCardInput,
  InfoCardConfig,
  InfoCardSnapshot,
  InfoCardType,
  MarketProviderConfig,
  SportsDateOffset,
  UpdateInfoCardInput
} from "../shared/infoCardProtocol.js";
import { getDb } from "./db.js";
import { getSetting, setSetting } from "./settings.js";

const INFO_CARDS_SETTING_KEY = "workspace.infoCards.v1";
const DEFAULT_RSS_CARD_ID = "rss-default";
const DEFAULT_MARKET_SYMBOLS = ["sh000001", "sz399001", "sz399006", "sh000300"];
const LEGACY_ALPHA_VANTAGE_DEFAULTS = new Set(["SPY", "QQQ", "DIA"]);
const LEGACY_SPORTS_TITLES = new Set([
  "Sports scores",
  "Football & basketball scores",
  "足球篮球赛况"
]);
const MAX_MARKET_SYMBOLS = 10;
const refreshes = new Map<string, Promise<InfoCardSnapshot>>();

function nowIso(): string {
  return new Date().toISOString();
}

function defaultTitle(type: InfoCardType): string {
  if (type === "market") return "Market indices";
  if (type === "sports") return "Sports events";
  return "Feed";
}

function defaultRssCard(): InfoCardConfig {
  const now = nowIso();
  return {
    id: DEFAULT_RSS_CARD_ID,
    type: "rss",
    title: defaultTitle("rss"),
    enabled: true,
    order: 0,
    refreshMinutes: 15,
    createdAt: now,
    updatedAt: now
  };
}

function sanitizeMarketSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_MARKET_SYMBOLS];
  const raw = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    raw.length === LEGACY_ALPHA_VANTAGE_DEFAULTS.size &&
    raw.every((entry) => LEGACY_ALPHA_VANTAGE_DEFAULTS.has(entry.toUpperCase()))
  ) {
    return [...DEFAULT_MARKET_SYMBOLS];
  }
  const symbols = Array.from(
    new Set(
      raw.map((entry) => normalizeAshareSymbol(entry) ?? entry.toUpperCase()).filter((entry) =>
        /^[A-Z0-9.^_-]{1,20}$|^(?:sh|sz)\d{6}$/.test(entry)
      )
    )
  );
  return symbols.slice(0, MAX_MARKET_SYMBOLS);
}

function sanitizeSportsDateOffset(value: unknown): SportsDateOffset {
  return value === -1 || value === 1 ? value : 0;
}

export function getMarketProviderConfig(): MarketProviderConfig {
  return {
    id: "ashare",
    name: "Ashare",
    sourceUrl: ASHARE_SOURCE_URL,
    configured: true
  };
}

export const searchMarketSymbols = searchAshareSecurities;

function normalizeCard(value: unknown, index: number): InfoCardConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<InfoCardConfig>;
  if (input.type !== "rss" && input.type !== "market" && input.type !== "sports") {
    return undefined;
  }
  const now = nowIso();
  const isLegacyMarketCard = input.type === "market" && !Array.isArray(input.marketSymbols);
  const isAlphaVantageDefault =
    input.type === "market" &&
    Array.isArray(input.marketSymbols) &&
    input.marketSymbols.length === LEGACY_ALPHA_VANTAGE_DEFAULTS.size &&
    input.marketSymbols.every((entry) =>
      LEGACY_ALPHA_VANTAGE_DEFAULTS.has(String(entry).toUpperCase())
    );
  const storedTitle = typeof input.title === "string" ? input.title.trim() : "";
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id : randomUUID(),
    type: input.type,
    title:
      storedTitle && !(input.type === "sports" && LEGACY_SPORTS_TITLES.has(storedTitle))
        ? storedTitle.slice(0, 80)
        : defaultTitle(input.type),
    enabled: input.enabled !== false,
    order: Number.isFinite(input.order) ? Number(input.order) : index,
    refreshMinutes: isLegacyMarketCard || isAlphaVantageDefault
      ? 5
      : Math.max(
          1,
          Math.min(
            Number(input.refreshMinutes) || (input.type === "market" ? 5 : 15),
            input.type === "market" ? 720 : 120
          )
        ),
    marketSymbols:
      input.type === "market" ? sanitizeMarketSymbols(input.marketSymbols) : undefined,
    sportsDateOffset:
      input.type === "sports" ? sanitizeSportsDateOffset(input.sportsDateOffset) : undefined,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now
  };
}

function notifyInfoCardsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSendToWebContents(win.webContents, "infoCards://changed", {
      updatedAt: nowIso()
    });
  }
}

function persistCards(cards: InfoCardConfig[]): void {
  const normalized = cards
    .sort((a, b) => a.order - b.order)
    .map((card, index) => ({ ...card, order: index }));
  setSetting(INFO_CARDS_SETTING_KEY, JSON.stringify(normalized));
  notifyInfoCardsChanged();
}

export function listInfoCards(): InfoCardConfig[] {
  const stored = getSetting(INFO_CARDS_SETTING_KEY);
  if (!stored) return [defaultRssCard()];
  try {
    const parsed = JSON.parse(stored);
    const cards = Array.isArray(parsed)
      ? parsed
          .map((entry, index) => normalizeCard(entry, index))
          .filter((entry): entry is InfoCardConfig => Boolean(entry))
      : [];
    if (!cards.some((card) => card.type === "rss")) {
      cards.unshift(defaultRssCard());
    }
    return cards.sort((a, b) => a.order - b.order);
  } catch {
    return [defaultRssCard()];
  }
}

export function createInfoCard(input: CreateInfoCardInput): InfoCardConfig {
  if (input.type !== "market" && input.type !== "sports") {
    throw new Error("Only market and sports cards can be added.");
  }
  const cards = listInfoCards();
  if (cards.some((card) => card.type === input.type)) {
    throw new Error(`Only one ${input.type} information card can be added.`);
  }
  const now = nowIso();
  const card: InfoCardConfig = {
    id: randomUUID(),
    type: input.type,
    title: input.title?.trim().slice(0, 80) || defaultTitle(input.type),
    enabled: true,
    order: cards.length,
    refreshMinutes: 5,
    marketSymbols: input.type === "market" ? [...DEFAULT_MARKET_SYMBOLS] : undefined,
    sportsDateOffset: input.type === "sports" ? 0 : undefined,
    createdAt: now,
    updatedAt: now
  };
  persistCards([...cards, card]);
  return card;
}

export function updateInfoCard(input: UpdateInfoCardInput): InfoCardConfig | undefined {
  const cards = listInfoCards();
  const index = cards.findIndex((card) => card.id === input.id);
  if (index < 0) return undefined;
  const current = cards[index];
  const next: InfoCardConfig = {
    ...current,
    ...(input.title !== undefined
      ? { title: input.title.trim().slice(0, 80) || defaultTitle(current.type) }
      : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.order !== undefined ? { order: Math.max(0, Math.floor(input.order)) } : {}),
    ...(input.refreshMinutes !== undefined
      ? {
          refreshMinutes: Math.max(
            1,
            Math.min(input.refreshMinutes, current.type === "market" ? 720 : 120)
          )
        }
      : {}),
    ...(input.marketSymbols !== undefined && current.type === "market"
      ? { marketSymbols: sanitizeMarketSymbols(input.marketSymbols) }
      : {}),
    ...(input.sportsDateOffset !== undefined && current.type === "sports"
      ? { sportsDateOffset: sanitizeSportsDateOffset(input.sportsDateOffset) }
      : {}),
    updatedAt: nowIso()
  };
  cards[index] = next;
  persistCards(cards);
  return next;
}

export function deleteInfoCard(id: string): boolean {
  const cards = listInfoCards();
  const target = cards.find((card) => card.id === id);
  if (!target || target.type === "rss") return false;
  persistCards(cards.filter((card) => card.id !== id));
  getDb().prepare("DELETE FROM info_card_snapshots WHERE card_id = ?").run(id);
  return true;
}

export function reorderInfoCards(ids: string[]): InfoCardConfig[] {
  const cards = listInfoCards();
  const byId = new Map(cards.map((card) => [card.id, card]));
  const ordered: InfoCardConfig[] = [];
  for (const id of ids) {
    const card = byId.get(id);
    if (!card) continue;
    ordered.push(card);
    byId.delete(id);
  }
  ordered.push(...byId.values());
  persistCards(ordered);
  return listInfoCards();
}

export function getInfoCardSnapshot(cardId: string): InfoCardSnapshot {
  const row = getDb()
    .prepare("SELECT * FROM info_card_snapshots WHERE card_id = ?")
    .get(cardId) as
    | {
        card_id: string;
        source_url: string | null;
        payload_json: string;
        fetched_at: string | null;
        last_error: string | null;
      }
    | undefined;
  if (!row) return { cardId, items: [], stale: false };
  let items: Array<Record<string, string>> = [];
  try {
    const parsed = JSON.parse(row.payload_json);
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    items = [];
  }
  const fetchedAt = row.fetched_at ?? undefined;
  const card = listInfoCards().find((entry) => entry.id === cardId);
  const staleAfterMs = (card?.refreshMinutes ?? 15) * 2 * 60_000;
  return {
    cardId,
    sourceUrl: row.source_url ?? undefined,
    items,
    fetchedAt,
    lastError: row.last_error ?? undefined,
    stale: Boolean(fetchedAt && Date.now() - new Date(fetchedAt).getTime() > staleAfterMs)
  };
}

function saveSnapshot(
  card: InfoCardConfig,
  items: Array<Record<string, string>>,
  error?: string
): InfoCardSnapshot {
  const previous = getInfoCardSnapshot(card.id);
  const fetchedAt = error ? previous.fetchedAt : nowIso();
  const nextItems = error ? previous.items : items;
  getDb()
    .prepare(
      `INSERT INTO info_card_snapshots
         (card_id, source_url, payload_json, fetched_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET
         source_url=excluded.source_url,
         payload_json=excluded.payload_json,
         fetched_at=excluded.fetched_at,
         last_error=excluded.last_error,
         updated_at=excluded.updated_at`
    )
    .run(
      card.id,
      (card.type === "market"
        ? ASHARE_SOURCE_URL
        : card.type === "sports"
          ? SPORTS_EVENTS_SOURCE_URL
          : undefined) ||
        previous.sourceUrl ||
        null,
      JSON.stringify(nextItems),
      fetchedAt ?? null,
      error ?? null,
      nowIso()
    );
  return getInfoCardSnapshot(card.id);
}

async function performRefresh(cardId: string): Promise<InfoCardSnapshot> {
  const card = listInfoCards().find((entry) => entry.id === cardId);
  if (!card) throw new Error("Info card not found.");
  if (card.type === "rss") return getInfoCardSnapshot(card.id);
  if (card.type === "market") {
    const symbols = sanitizeMarketSymbols(card.marketSymbols);
    if (!symbols.length) return saveSnapshot(card, [], "Add at least one market symbol.");
    try {
      return saveSnapshot(card, await fetchAshareQuotes(symbols));
    } catch (error) {
      return saveSnapshot(card, [], (error as Error)?.message || String(error));
    }
  }
  try {
    return saveSnapshot(
      card,
      await fetchNbaScores({
        dateOffset: sanitizeSportsDateOffset(card.sportsDateOffset)
      })
    );
  } catch (error) {
    return saveSnapshot(card, [], (error as Error)?.message || String(error));
  }
}

export function refreshInfoCard(cardId: string): Promise<InfoCardSnapshot> {
  const existing = refreshes.get(cardId);
  if (existing) return existing;
  const pending = performRefresh(cardId).finally(() => refreshes.delete(cardId));
  refreshes.set(cardId, pending);
  return pending;
}

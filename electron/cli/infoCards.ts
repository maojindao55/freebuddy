import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";

import { collectBrowserRecipe } from "../browserCollector.js";
import { safeSendToWebContents } from "./ipcSend.js";
import type {
  BrowserExtractionRecipe,
  CreateInfoCardInput,
  InfoCardConfig,
  InfoCardSnapshot,
  InfoCardType,
  UpdateInfoCardInput
} from "../shared/infoCardProtocol.js";
import { getDb } from "./db.js";
import { getSetting, setSetting } from "./settings.js";

const INFO_CARDS_SETTING_KEY = "workspace.infoCards.v1";
const DEFAULT_RSS_CARD_ID = "rss-default";
const refreshes = new Map<string, Promise<InfoCardSnapshot>>();

function nowIso(): string {
  return new Date().toISOString();
}

function defaultTitle(type: InfoCardType): string {
  if (type === "market") return "Market indices";
  if (type === "sports") return "Sports scores";
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

function sanitizeRecipe(
  value: BrowserExtractionRecipe | null | undefined
): BrowserExtractionRecipe | undefined {
  if (!value) return undefined;
  const url = value.url?.trim() ?? "";
  const rowSelector = value.rowSelector?.trim() ?? "";
  const fields = Object.fromEntries(
    Object.entries(value.fields ?? {})
      .map(([key, selector]) => [key.trim(), selector.trim()])
      .filter(([key, selector]) => key && selector)
  );
  if (!url && !rowSelector && Object.keys(fields).length === 0) return undefined;
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("Info card sources must use HTTPS.");
    }
  }
  return {
    url,
    rowSelector,
    fields,
    ...(value.waitForSelector?.trim()
      ? { waitForSelector: value.waitForSelector.trim() }
      : {}),
    maxItems: Math.max(1, Math.min(value.maxItems ?? 6, 20))
  };
}

function normalizeCard(value: unknown, index: number): InfoCardConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<InfoCardConfig>;
  if (input.type !== "rss" && input.type !== "market" && input.type !== "sports") {
    return undefined;
  }
  const now = nowIso();
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id : randomUUID(),
    type: input.type,
    title:
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim().slice(0, 80)
        : defaultTitle(input.type),
    enabled: input.enabled !== false,
    order: Number.isFinite(input.order) ? Number(input.order) : index,
    refreshMinutes: Math.max(1, Math.min(Number(input.refreshMinutes) || 15, 120)),
    recipe: input.type === "rss" ? undefined : sanitizeRecipe(input.recipe),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now
  };
}

function persistCards(cards: InfoCardConfig[]): void {
  const normalized = cards
    .sort((a, b) => a.order - b.order)
    .map((card, index) => ({ ...card, order: index }));
  setSetting(INFO_CARDS_SETTING_KEY, JSON.stringify(normalized));
  for (const win of BrowserWindow.getAllWindows()) {
    safeSendToWebContents(win.webContents, "infoCards://changed", {
      updatedAt: nowIso()
    });
  }
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
  const now = nowIso();
  const card: InfoCardConfig = {
    id: randomUUID(),
    type: input.type,
    title: input.title?.trim().slice(0, 80) || defaultTitle(input.type),
    enabled: true,
    order: cards.length,
    refreshMinutes: input.type === "sports" ? 5 : 15,
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
      ? { refreshMinutes: Math.max(1, Math.min(input.refreshMinutes, 120)) }
      : {}),
    ...(input.recipe !== undefined && current.type !== "rss"
      ? { recipe: sanitizeRecipe(input.recipe) }
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
      card.recipe?.url || previous.sourceUrl || null,
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
  if (!card.recipe?.url || !card.recipe.rowSelector || !Object.keys(card.recipe.fields).length) {
    return saveSnapshot(card, [], "Browser extraction recipe is incomplete.");
  }
  try {
    const rows = await collectBrowserRecipe(card.recipe);
    if (!rows.length) {
      return saveSnapshot(card, [], "The extraction rule returned no rows.");
    }
    return saveSnapshot(card, rows);
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

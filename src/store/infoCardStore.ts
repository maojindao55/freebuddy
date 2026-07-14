import { create } from "zustand";

import { infoCardClient } from "@/services/infoCards/client";
import type {
  CreateInfoCardInput,
  InfoCardConfig,
  InfoCardSnapshot,
  MarketProviderConfig,
  UpdateInfoCardInput
} from "@/services/infoCards/types";

interface InfoCardState {
  cards: InfoCardConfig[];
  snapshots: Record<string, InfoCardSnapshot>;
  refreshing: Record<string, boolean>;
  marketProvider?: MarketProviderConfig;
  loaded: boolean;
  loading: boolean;
  error?: string;
  load(): Promise<void>;
  createCard(input: CreateInfoCardInput): Promise<InfoCardConfig>;
  updateCard(input: UpdateInfoCardInput): Promise<InfoCardConfig | undefined>;
  deleteCard(id: string): Promise<boolean>;
  reorderCards(ids: string[]): Promise<void>;
  refreshCard(id: string): Promise<InfoCardSnapshot>;
}

function sorted(cards: InfoCardConfig[]): InfoCardConfig[] {
  return [...cards].sort((a, b) => a.order - b.order);
}

export const useInfoCardStore = create<InfoCardState>((set, get) => ({
  cards: [],
  snapshots: {},
  refreshing: {},
  marketProvider: undefined,
  loaded: false,
  loading: false,
  error: undefined,

  async load() {
    if (!infoCardClient.isAvailable()) return;
    set({ loading: true, error: undefined });
    try {
      const [cardsResult, marketProvider] = await Promise.all([
        infoCardClient.list(),
        infoCardClient.marketProvider()
      ]);
      const cards = sorted(cardsResult);
      const pairs = await Promise.all(
        cards
          .filter((card) => card.type !== "rss")
          .map(async (card) => [card.id, await infoCardClient.snapshot(card.id)] as const)
      );
      set({ cards, marketProvider, snapshots: Object.fromEntries(pairs), loaded: true });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  async createCard(input) {
    const card = await infoCardClient.create(input);
    set((state) => ({ cards: sorted([...state.cards, card]) }));
    return card;
  },

  async updateCard(input) {
    const card = await infoCardClient.update(input);
    if (card) {
      set((state) => ({
        cards: sorted(state.cards.map((entry) => (entry.id === card.id ? card : entry)))
      }));
    }
    return card;
  },

  async deleteCard(id) {
    const ok = await infoCardClient.delete(id);
    if (ok) {
      set((state) => {
        const snapshots = { ...state.snapshots };
        delete snapshots[id];
        return {
          cards: state.cards.filter((card) => card.id !== id),
          snapshots
        };
      });
    }
    return ok;
  },

  async reorderCards(ids) {
    set({ cards: sorted(await infoCardClient.reorder(ids)) });
  },

  async refreshCard(id) {
    set((state) => ({ refreshing: { ...state.refreshing, [id]: true } }));
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const snapshot = await infoCardClient.refresh(id, timeZone);
      set((state) => ({
        snapshots: { ...state.snapshots, [id]: snapshot },
        error: undefined
      }));
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      return get().snapshots[id] ?? { cardId: id, items: [], stale: true, lastError: message };
    } finally {
      set((state) => ({ refreshing: { ...state.refreshing, [id]: false } }));
    }
  }
}));

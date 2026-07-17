import { create } from "zustand";

import { skillsClient } from "@/services/skills/client";
import type {
  MarketInstallResult,
  MarketProviderInfo,
  MarketSkill,
  SkillMarketProviderId
} from "@/services/skills/types";
import { useSkillStore } from "@/store/skillStore";

type RowStatus = "idle" | "installing" | "error";

export const MARKET_CONFIRMATION_PREFIX = "MARKET_CONFIRMATION_REQUIRED";

interface SkillMarketState {
  provider: SkillMarketProviderId;
  providers: MarketProviderInfo[];
  query: string;
  items: MarketSkill[];
  nextCursor?: string | null;
  loading: boolean;
  loadingMore: boolean;
  error?: string;
  rowStatus: Record<string, RowStatus>;
  rowErrors: Record<string, string>;
  ready: boolean;
  searchSeq: number;
  init(): Promise<void>;
  setProvider(provider: SkillMarketProviderId): Promise<void>;
  setQuery(query: string): void;
  search(options?: { append?: boolean; query?: string }): Promise<void>;
  loadMore(): Promise<void>;
  install(
    skill: MarketSkill,
    flags?: { allowSuspicious?: boolean; allowLocalOverwrite?: boolean }
  ): Promise<MarketInstallResult | { needsConfirmation: true; reason: string; message: string } | undefined>;
  openHomepage(skill: MarketSkill): Promise<void>;
}

function rowKey(skill: MarketSkill): string {
  return `${skill.provider}:${skill.marketSkillId}`;
}

export function parseMarketConfirmationMessage(
  message: string
): { reason: string; detail: string } | undefined {
  // Electron wraps ipcRenderer.invoke errors, e.g.
  // "Error invoking remote method 'skills:installFromMarket': Error: MARKET_CONFIRMATION_REQUIRED:..."
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

export const useSkillMarketStore = create<SkillMarketState>((set, get) => ({
  provider: "skillhub.cn",
  providers: [],
  query: "",
  items: [],
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: undefined,
  rowStatus: {},
  rowErrors: {},
  ready: false,
  searchSeq: 0,
  async init() {
    if (get().ready) return;
    const [providers, provider] = await Promise.all([
      skillsClient.marketProviders(),
      skillsClient.getMarketProvider()
    ]);
    set({ providers, provider, ready: true });
    await get().search();
  },
  async setProvider(provider) {
    if (provider === get().provider) return;
    set({ provider, items: [], nextCursor: null, error: undefined });
    await skillsClient.setMarketProvider(provider);
    await get().search();
  },
  setQuery(query) {
    set({ query });
  },
  async search(options) {
    const append = Boolean(options?.append);
    const provider = get().provider;
    const query = options?.query ?? get().query;
    const nextCursor = get().nextCursor;
    const items = get().items;
    const seq = get().searchSeq + 1;
    if (options?.query !== undefined) {
      set({ query: options.query });
    }
    set({
      searchSeq: seq,
      loading: !append,
      loadingMore: append,
      error: undefined
    });
    try {
      const result = await skillsClient.searchMarket({
        provider,
        query: query.trim() || undefined,
        cursor: append ? nextCursor ?? undefined : undefined
      });
      const current = get();
      if (current.searchSeq !== seq) return;
      if (current.provider !== provider) return;
      if (current.query !== query) return;
      set({
        items: append ? [...items, ...result.items] : result.items,
        nextCursor: result.nextCursor ?? null
      });
    } catch (error) {
      const current = get();
      if (current.searchSeq !== seq) return;
      if (current.provider !== provider || current.query !== query) return;
      set({
        error: error instanceof Error ? error.message : String(error),
        items: append ? items : []
      });
    } finally {
      if (get().searchSeq === seq) {
        set({ loading: false, loadingMore: false });
      }
    }
  },
  async loadMore() {
    if (!get().nextCursor || get().loadingMore || get().loading) return;
    await get().search({ append: true });
  },
  async install(skill, flags = {}) {
    const key = rowKey(skill);
    const allowSuspicious = Boolean(flags.allowSuspicious);
    const allowLocalOverwrite = Boolean(flags.allowLocalOverwrite);
    set((state) => ({
      rowStatus: { ...state.rowStatus, [key]: "installing" },
      rowErrors: { ...state.rowErrors, [key]: "" }
    }));
    try {
      const result = await skillsClient.installFromMarket({
        provider: skill.provider,
        marketSkillId: skill.marketSkillId,
        slug: skill.slug,
        version: skill.version,
        ownerHandle: skill.ownerHandle,
        downloadsHint: skill.downloads,
        allowSuspicious,
        allowLocalOverwrite
      });
      await useSkillStore.getState().load();
      const installed = result.skill;
      const ownerHandle =
        installed.marketSkillId &&
        installed.marketSlug &&
        installed.marketSkillId.endsWith(`/${installed.marketSlug}`)
          ? installed.marketSkillId.slice(0, -(installed.marketSlug.length + 1))
          : skill.ownerHandle;
      set((state) => ({
        rowStatus: { ...state.rowStatus, [key]: "idle" },
        // Only rewrite the clicked row — never merge identity across same-slug authors.
        items: state.items.map((item) => {
          if (rowKey(item) !== key) return item;
          return {
            ...item,
            marketSkillId: installed.marketSkillId || item.marketSkillId,
            ownerHandle: ownerHandle || item.ownerHandle,
            author: ownerHandle || item.author,
            version: installed.marketVersion || item.version,
            homepageUrl: installed.marketUrl || item.homepageUrl
          };
        })
      }));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const confirmation = parseMarketConfirmationMessage(message);
      const alreadyAllowed =
        (confirmation?.reason === "local-drift" && allowLocalOverwrite) ||
        (confirmation?.reason !== "local-drift" &&
          confirmation != null &&
          allowSuspicious);
      if (confirmation && !alreadyAllowed) {
        set((state) => ({
          rowStatus: { ...state.rowStatus, [key]: "idle" },
          rowErrors: { ...state.rowErrors, [key]: "" }
        }));
        return {
          needsConfirmation: true as const,
          reason: confirmation.reason,
          message: confirmation.detail
        };
      }
      set((state) => ({
        rowStatus: { ...state.rowStatus, [key]: "error" },
        rowErrors: { ...state.rowErrors, [key]: message }
      }));
      return undefined;
    }
  },
  async openHomepage(skill) {
    let url = skill.homepageUrl?.trim() || "";
    let ownerHandle = skill.ownerHandle;
    if (!url) {
      url =
        (await skillsClient.resolveMarketHomepage({
          provider: skill.provider,
          slug: skill.slug,
          ownerHandle: skill.ownerHandle,
          version: skill.version,
          downloadsHint: skill.downloads
        })) || "";
      if (url && skill.provider === "clawhub.ai") {
        ownerHandle =
          ownerHandle ||
          url.match(/^https:\/\/clawhub\.ai\/([^/]+)\/skills\//)?.[1] ||
          undefined;
      }
      if (url) {
        const key = rowKey(skill);
        set((state) => ({
          items: state.items.map((item) => {
            if (rowKey(item) !== key) return item;
            return {
              ...item,
              homepageUrl: url,
              ownerHandle: ownerHandle || item.ownerHandle,
              author: ownerHandle || item.author,
              marketSkillId:
                ownerHandle && !item.marketSkillId.includes("/")
                  ? `${ownerHandle}/${item.slug}`
                  : item.marketSkillId
            };
          })
        }));
      }
    }
    if (!url) return;
    await skillsClient.openMarketUrl(url);
  }
}));

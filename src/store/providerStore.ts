import { create } from "zustand";

import { providersClient } from "@/services/providers/client";
import { isProviderCompatibleWithAdapter } from "@/services/providers/types";
import type { Provider, ProviderInput } from "@/services/providers/types";

interface ProviderState {
  providers: Provider[];
  loaded: boolean;
  loading: boolean;
  error?: string;
  load(): Promise<void>;
  refresh(): Promise<void>;
  upsert(input: ProviderInput & { apiKey?: string }): Promise<Provider>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  test(id: string): Promise<{ ok: boolean; error?: string; latencyMs?: number }>;
  /**
   * Patch a single provider's health fields in place. Used after connectivity
   * tests so the sidebar dots update immediately without a full `refresh()`
   * (which would also clobber any unsaved state the editor is holding).
   */
  applyHealth(
    id: string,
    result: { ok: boolean; latencyMs: number; error?: string; checkedAt: string },
  ): void;
  compatibleWith(adapter: string): Provider[];
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  loaded: false,
  loading: false,
  error: undefined,

  async load() {
    if (get().loaded || get().loading) return;
    await get().refresh();
  },

  async refresh() {
    if (!providersClient.isAvailable()) {
      set({ loaded: true, loading: false, providers: [] });
      return;
    }
    set({ loading: true, error: undefined });
    try {
      const providers = await providersClient.list();
      set({ providers, loaded: true, error: undefined });
    } catch (e) {
      set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  async upsert(input) {
    const rec = await providersClient.upsert(input);
    await get().refresh();
    return get().providers.find((p) => p.id === rec.id) ?? rec;
  },

  async remove(id) {
    await providersClient.remove(id);
    await get().refresh();
  },

  async setEnabled(id, enabled) {
    const rec = await providersClient.setEnabled(id, enabled);
    set((s) => ({
      providers: s.providers.map((p) => (p.id === id ? rec : p)),
    }));
  },

  async reorder(ids) {
    const providers = await providersClient.reorder(ids);
    set({ providers });
  },

  async test(id) {
    const r = await providersClient.test(id);
    get().applyHealth(id, {
      ok: r.ok,
      latencyMs: r.latencyMs,
      error: r.error,
      checkedAt: r.checkedAt,
    });
    return r;
  },

  applyHealth(id, result) {
    set((s) => ({
      providers: s.providers.map((p) =>
        p.id === id
          ? {
              ...p,
              lastHealth: result.ok ? "ok" : "error",
              lastLatencyMs: result.latencyMs,
              lastError: result.error,
              lastCheckedAt: result.checkedAt,
            }
          : p,
      ),
    }));
  },

  compatibleWith(adapter: string): Provider[] {
    return get().providers.filter(
      (p) => p.enabled && isProviderCompatibleWithAdapter(p, adapter),
    );
  },
}));

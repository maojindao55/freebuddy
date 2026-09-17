import { create } from "zustand";

import { providersClient } from "@/services/providers/client";
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
    await get().refresh();
    return r;
  },

  compatibleWith(adapter) {
    const base = adapter.replace(/^cli-/, "");
    return get().providers.filter((p) => {
      if (!p.enabled) return false;
      const protos = p.protocols?.length ? p.protocols : [p.protocol];
      if (base === "codex-acp" || base === "codex") {
        return protos.some((x) => x === "openai-chat" || x === "openai-responses" || x === "deepseek");
      }
      if (base === "claude-agent-acp" || base === "claude") {
        return protos.some((x) => x === "anthropic");
      }
      if (base === "dsh-acp") {
        return protos.some((x) => x === "deepseek" || x === "openai-chat");
      }
      return protos.some((x) => x === "openai-chat" || x === "openai-responses");
    });
  },
}));

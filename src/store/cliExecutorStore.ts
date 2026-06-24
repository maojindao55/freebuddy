import { create } from "zustand";

import {
  cliAdapterDefinitions,
  type CLIAdapterDefinition,
  type CLIAdapterId
} from "@/config/cliAdapters";
import { cliClient } from "@/services/cli/client";
import type {
  CLIExecutorOverride,
  CliRuntime
} from "@/services/cli/types";

export interface ResolvedExecutor extends CLIAdapterDefinition {
  binary: string;
  extraArgs: string[];
  env?: Record<string, string>;
  enabled: boolean;
  runtime?: CliRuntime;
  override?: CLIExecutorOverride;
}

interface State {
  loaded: boolean;
  adapters: CLIAdapterDefinition[];
  overrides: Record<string, CLIExecutorOverride>;
  runtimes: Record<string, CliRuntime>;

  load(): Promise<void>;
  refreshRuntimes(): Promise<void>;
  check(adapter: CLIAdapterId): Promise<void>;
  checkAll(): Promise<void>;
  upsertOverride(o: CLIExecutorOverride): Promise<void>;
  resetOverride(id: string): Promise<void>;

  resolve(id: CLIAdapterId): ResolvedExecutor | undefined;
  listResolved(): ResolvedExecutor[];
}

export const useCliExecutorStore = create<State>((set, get) => ({
  loaded: false,
  adapters: cliAdapterDefinitions,
  overrides: {},
  runtimes: {},

  async load() {
    if (!cliClient.isAvailable()) {
      set({ loaded: true });
      return;
    }
    const [adapters, overrides, runtimes] = await Promise.all([
      cliClient.listAdapters(),
      cliClient.listOverrides(),
      cliClient.listRuntimes()
    ]);
    const overridesMap: Record<string, CLIExecutorOverride> = {};
    overrides.forEach((o) => (overridesMap[o.id] = o));
    const runtimesMap: Record<string, CliRuntime> = {};
    runtimes.forEach((r) => (runtimesMap[r.adapter] = r));
    set({
      loaded: true,
      adapters: adapters.length ? adapters : cliAdapterDefinitions,
      overrides: overridesMap,
      runtimes: runtimesMap
    });
  },

  async refreshRuntimes() {
    if (!cliClient.isAvailable()) return;
    const runtimes = await cliClient.listRuntimes();
    const runtimesMap: Record<string, CliRuntime> = {};
    runtimes.forEach((r) => (runtimesMap[r.adapter] = r));
    set({ runtimes: runtimesMap });
  },

  async check(adapter) {
    if (!cliClient.isAvailable()) return;
    const override = get().overrides[adapter];
    await cliClient.check(adapter, override?.binary);
    await get().refreshRuntimes();
  },

  async checkAll() {
    if (!cliClient.isAvailable()) return;
    const { adapters, overrides } = get();
    const acpAdapters = adapters.filter((a) => a.protocol === "acp");
    for (const adapter of acpAdapters) {
      await cliClient.check(adapter.id, overrides[adapter.id]?.binary);
    }
    await get().refreshRuntimes();
  },

  async upsertOverride(o) {
    if (!cliClient.isAvailable()) return;
    await cliClient.upsertOverride(o);
    set((s) => ({ overrides: { ...s.overrides, [o.id]: o } }));
  },

  async resetOverride(id) {
    if (!cliClient.isAvailable()) return;
    await cliClient.resetOverride(id);
    set((s) => {
      const next = { ...s.overrides };
      delete next[id];
      return { overrides: next };
    });
  },

  resolve(id) {
    const { adapters, overrides, runtimes } = get();
    const def = adapters.find((a) => a.id === id);
    if (!def) return undefined;
    const o = overrides[id];
    return {
      ...def,
      label: o?.label?.trim() || def.label,
      binary: (o?.binary?.trim() || def.defaultBinary) ?? def.id,
      extraArgs: o?.extraArgs?.filter(Boolean) ?? [],
      env: o?.env,
      enabled: o?.enabled !== false,
      runtime: runtimes[id],
      override: o
    };
  },

  listResolved() {
    return get()
      .adapters.map((a) => get().resolve(a.id))
      .filter((x): x is ResolvedExecutor => !!x);
  }
}));

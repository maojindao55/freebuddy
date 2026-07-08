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
  baseAdapter?: CLIAdapterId;
  isClone?: boolean;
  binary: string;
  extraArgs: string[];
  env?: Record<string, string>;
  icon?: string;
  enabled: boolean;
  codexByok?: CLIExecutorOverride["codexByok"];
  claudeByok?: CLIExecutorOverride["claudeByok"];
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
    const resolved = get().resolve(adapter);
    if (!resolved) return;
    await cliClient.check(
      resolved.baseAdapter ?? resolved.id,
      resolved.binary,
      resolved.env,
      resolved.id
    );
    await get().refreshRuntimes();
  },

  async checkAll() {
    if (!cliClient.isAvailable()) return;
    const acpAdapters = get().listResolved().filter((a) => a.protocol === "acp");
    for (const adapter of acpAdapters) {
      const targetId = adapter.baseAdapter ?? adapter.id;
      await cliClient.check(targetId, adapter.binary, adapter.env, adapter.id);
    }
    await get().refreshRuntimes();
  },

  async upsertOverride(o) {
    if (!cliClient.isAvailable()) return;
    await cliClient.upsertOverride(o);
    const overrides = await cliClient.listOverrides();
    const overridesMap: Record<string, CLIExecutorOverride> = {};
    overrides.forEach((override) => (overridesMap[override.id] = override));
    set({ overrides: overridesMap });
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
    const o = overrides[id];
    const baseAdapter = o?.baseAdapter ?? id;
    const def = adapters.find((a) => a.id === baseAdapter);
    if (!def) return undefined;
    const isClone = def.id !== id;
    return {
      ...def,
      id,
      baseAdapter: isClone ? def.id : undefined,
      isClone,
      label: o?.label?.trim() || def.label,
      binary: (o?.binary?.trim() || def.defaultBinary) ?? def.id,
      extraArgs: o?.extraArgs?.filter(Boolean) ?? [],
      env: o?.env,
      icon: o?.icon,
      enabled: o?.enabled !== false,
      codexByok: o?.codexByok,
      claudeByok: o?.claudeByok,
      runtime: isClone ? runtimes[id] : runtimes[def.id],
      override: o
    };
  },

  listResolved() {
    const { adapters, overrides } = get();
    const ids = new Set<string>(adapters.map((a) => a.id));
    for (const override of Object.values(overrides)) {
      if (override.baseAdapter) ids.add(override.id);
    }
    return Array.from(ids)
      .map((id) => get().resolve(id))
      .filter((x): x is ResolvedExecutor => !!x);
  }
}));

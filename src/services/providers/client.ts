import type { Provider, ProviderInput, ProviderTestResult, TestProviderOptions } from "./types";

interface ProvidersBridge {
  list(): Promise<Provider[]>;
  upsert(input: ProviderInput & { apiKey?: string }): Promise<Provider>;
  remove(id: string): Promise<void>;
  setEnabled(input: { id: string; enabled: boolean }): Promise<Provider>;
  reorder(ids: string[]): Promise<Provider[]>;
  test(target: string | TestProviderOptions): Promise<ProviderTestResult>;
}

function api(): ProvidersBridge {
  const p = (window.freebuddy as unknown as { providers?: ProvidersBridge })?.providers;
  if (!p) throw new Error("providers bridge unavailable");
  return p;
}

export const providersClient = {
  isAvailable(): boolean {
    return Boolean((window.freebuddy as unknown as { providers?: unknown })?.providers);
  },
  list(): Promise<Provider[]> {
    return api().list();
  },
  upsert(input: ProviderInput & { apiKey?: string }): Promise<Provider> {
    return api().upsert(input);
  },
  remove(id: string): Promise<void> {
    return api().remove(id);
  },
  setEnabled(id: string, enabled: boolean): Promise<Provider> {
    return api().setEnabled({ id, enabled });
  },
  reorder(ids: string[]): Promise<Provider[]> {
    return api().reorder(ids);
  },
  test(target: string | TestProviderOptions): Promise<ProviderTestResult> {
    return api().test(target);
  },
};

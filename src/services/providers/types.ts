/**
 * Provider: unified entity for model API channels (relays / BYOK).
 *
 * Naming (fixed):
 * - UI label: Provider
 * - Code: provider / ProviderPreset / ProviderModel
 * - Presets: read-only, shipped (the old FreebieProviderPreset)
 * - Instances: user-created, one preset can spawn many, holds key/url/models
 *
 * FreeBuddy-specific (Cherry lacks): baseAdapter / protocol / envKey / wireApi
 * because we do not call APIs directly; we inject env into CLI agent processes.
 */

export const PROVIDER_PROTOCOLS = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "deepseek",
] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

export type ProviderBaseAdapter = "codex-acp" | "claude-agent-acp" | "dsh-acp";

export type ProviderHealth = "unknown" | "ok" | "error";

export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  supportsVision?: boolean;
}

export interface ProviderWebsites {
  official?: string;
  apiKey?: string;
  docs?: string;
  models?: string;
}

/** Read-only preset: the old providers.json / FreebieProviderPreset. */
export interface ProviderPreset {
  id: string;
  name: string;
  region?: "cn" | "global";
  homepage?: string;
  consoleUrl?: string;
  websites?: ProviderWebsites;
  freeTierSummary?: Record<string, string>;
  icon?: string;
  protocol: ProviderProtocol;
  protocols?: ProviderProtocol[];
  baseUrl: string;
  envKey?: string;
  models: ProviderModel[];
  contextWindow?: number;
  verifiedAt?: string;
}

/** User instance stored in the DB providers table (read-back has preview only, never plaintext keys). */
export interface ProviderInput {
  id?: string;
  presetId?: string;
  name: string;
  baseAdapter: ProviderBaseAdapter;
  protocol: ProviderProtocol;
  protocols?: ProviderProtocol[];
  baseUrl: string;
  envKey?: string;
  models?: ProviderModel[];
  contextWindow?: number;
  icon?: string;
  enabled?: boolean;
  position?: number;
  wireApi?: "chat" | "responses";
  notes?: string;
}

export interface Provider extends ProviderInput {
  id: string;
  envKey: string;
  apiKeyPreview?: string;
  hasKey: boolean;
  models: ProviderModel[];
  lastHealth?: ProviderHealth;
  lastLatencyMs?: number;
  lastError?: string;
  lastCheckedAt?: string;
  updatedAt?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  models?: string[];
  error?: string;
  checkedAt: string;
}

export const PROVIDER_ID_PREFIX = "provider-";

const PROVIDER_ID_PATTERN = /^(provider|freebie)-(.+)-([0-9a-z]{6})$/;

export function providerSlugFromId(id: string): string | null {
  const m = PROVIDER_ID_PATTERN.exec(id);
  return m ? m[2] : null;
}

/** Filter providers compatible with a base adapter (Agent BYOK picker). */
export function isProviderCompatibleWithAdapter(
  provider: Pick<ProviderPreset, "protocol" | "protocols"> & {
    baseAdapter?: string;
    protocol?: ProviderProtocol;
  },
  adapter: string,
): boolean {
  const protocols: ProviderProtocol[] =
    (provider.protocols?.length ? provider.protocols : [(provider as { protocol: ProviderProtocol }).protocol]).filter(
      Boolean,
    ) as ProviderProtocol[];
  if (adapter === "codex-acp" || adapter === "codex") {
    return protocols.some((p) => p === "openai-chat" || p === "openai-responses" || p === "deepseek");
  }
  if (adapter === "claude-agent-acp" || adapter === "claude") {
    return protocols.some((p) => p === "anthropic");
  }
  if (adapter === "dsh-acp") {
    return protocols.some((p) => p === "deepseek" || p === "openai-chat");
  }
  // Other agents: only openai-chat compatible relays by default
  return protocols.some((p) => p === "openai-chat" || p === "openai-responses");
}

export function baseAdapterForProtocol(protocol: ProviderProtocol): ProviderBaseAdapter {
  switch (protocol) {
    case "anthropic":
      return "claude-agent-acp";
    case "deepseek":
      return "dsh-acp";
    case "openai-chat":
    case "openai-responses":
    default:
      return "codex-acp";
  }
}

export function defaultEnvKeyForProvider(
  adapter: ProviderBaseAdapter,
  protocol: ProviderProtocol,
): string {
  switch (adapter) {
    case "claude-agent-acp":
      return "ANTHROPIC_API_KEY";
    case "dsh-acp":
      return protocol === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
    case "codex-acp":
    default:
      return "OPENAI_API_KEY";
  }
}

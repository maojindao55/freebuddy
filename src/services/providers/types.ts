/**
 * Provider: unified entity for model API channels (relays / BYOK).
 *
 * Naming (fixed):
 * - UI label: Provider
 * - Code: provider / ProviderPreset / ProviderModel
 * - Presets: read-only, shipped (the old FreebieProviderPreset)
 * - Instances: user-created, one preset can spawn many, holds key/url/models
 *
 * FreeBuddy-specific (Cherry lacks): protocol / envKey / wireApi, because we do
 * not call APIs directly; we inject env into CLI agent processes.
 *
 * There is deliberately no adapter binding here. A provider is described by the
 * wire protocol it speaks, and any CLI agent whose adapter speaks that protocol
 * can use it. Which agents that is gets derived in
 * {@link isProviderCompatibleWithAdapter} instead of being stored, so one relay
 * can serve Codex and DeepSeek Harness at the same time.
 */

export const PROVIDER_PROTOCOLS = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "deepseek",
] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

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

/** Normalises `protocols` to a non-empty list, falling back to `protocol`. */
export function protocolsOf(
  provider: Pick<ProviderPreset, "protocol" | "protocols"> & { protocol?: ProviderProtocol },
): ProviderProtocol[] {
  const list = provider.protocols?.length ? provider.protocols : [provider.protocol];
  return (list ?? []).filter((p): p is ProviderProtocol => Boolean(p));
}

/**
 * Which CLI agents can run against a provider, derived from its wire protocol.
 * Storing this on the row would go stale the moment a new adapter lands, and it
 * would stop a single relay from serving several agents at once.
 */
export function isProviderCompatibleWithAdapter(
  provider: Pick<ProviderPreset, "protocol" | "protocols"> & { protocol?: ProviderProtocol },
  adapter: string,
): boolean {
  const protocols = protocolsOf(provider);
  const id = adapter.replace(/^cli-/, "");
  if (id === "codex-acp" || id === "codex") {
    return protocols.some((p) => p === "openai-chat" || p === "openai-responses" || p === "deepseek");
  }
  if (id === "claude-agent-acp" || id === "claude") {
    return protocols.some((p) => p === "anthropic");
  }
  if (id === "dsh-acp") {
    return protocols.some((p) => p === "deepseek" || p === "openai-chat");
  }
  // Other agents: only openai-chat compatible relays by default
  return protocols.some((p) => p === "openai-chat" || p === "openai-responses");
}

/** Env var name the adapter reads the key from, derived from the protocol alone. */
export function defaultEnvKeyForProtocol(protocol: ProviderProtocol): string {
  if (protocol === "anthropic") return "ANTHROPIC_API_KEY";
  if (protocol === "deepseek") return "DEEPSEEK_API_KEY";
  return "OPENAI_API_KEY";
}

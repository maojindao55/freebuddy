import { customAlphabet } from "nanoid";

import type { CLIAdapterId } from "@/config/cliAdapters";
import type { CLIByokModel, CLIExecutorOverride } from "@/services/cli/types";

import type { FreebieProtocol, FreebieProviderPreset, FreebieRuntimeState } from "./protocol";

export const FREEBIE_OVERRIDE_PREFIX = "freebie-";

const overrideSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 6);
const OVERRIDE_ID_PATTERN = /^freebie-(.+)-([0-9a-z]{6})$/;

export type FreebieBaseAdapter = "codex-acp" | "claude-agent-acp" | "dsh-acp";

export function baseAdapterForProtocol(protocol: FreebieProtocol): FreebieBaseAdapter {
  switch (protocol) {
    case "anthropic":
      return "claude-agent-acp";
    case "deepseek":
      return "dsh-acp";
    case "openai-chat":
    case "openai-responses":
      return "codex-acp";
  }
}

export function runtimeKeyForAdapter(adapter: FreebieBaseAdapter): keyof FreebieRuntimeState {
  switch (adapter) {
    case "claude-agent-acp":
      return "claude";
    case "dsh-acp":
      return "deepseek";
    default:
      return "codex";
  }
}

export function runtimeKeyForProtocol(protocol: FreebieProtocol): keyof FreebieRuntimeState {
  return runtimeKeyForAdapter(baseAdapterForProtocol(protocol));
}

export function defaultEnvKeyForAdapter(
  adapter: FreebieBaseAdapter,
  protocol: FreebieProtocol
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

export function defaultEnvKeyForProtocol(protocol: FreebieProtocol): string {
  return defaultEnvKeyForAdapter(baseAdapterForProtocol(protocol), protocol);
}

export function normalizeFreebieIcon(rawIcon?: string | null): string | undefined {
  if (!rawIcon) return undefined;
  const trimmed = rawIcon.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("lobehub:")) return trimmed;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
    return trimmed;
  }
  const clean = trimmed.replace(/-color$/i, "");
  return `lobehub:${clean}`;
}

export interface AvailableAgentOption {
  adapter: FreebieBaseAdapter;
  label: string;
  isRecommended?: boolean;
}

export function resolveAvailableAgents(
  protocols: FreebieProtocol[] | undefined,
  fallbackProtocol: FreebieProtocol
): AvailableAgentOption[] {
  const list = protocols?.length ? protocols : [fallbackProtocol];
  const set = new Set(list);
  const options: AvailableAgentOption[] = [];

  // Codex: supports openai-chat, openai-responses, deepseek
  if (set.has("openai-chat") || set.has("openai-responses") || set.has("deepseek")) {
    options.push({
      adapter: "codex-acp",
      label: "Codex",
      isRecommended: set.has("openai-chat") || set.has("openai-responses")
    });
  }

  // DeepSeek (Dsh): supports deepseek, openai-chat
  if (set.has("deepseek") || set.has("openai-chat")) {
    options.push({
      adapter: "dsh-acp",
      label: "DeepSeek",
      isRecommended: set.has("deepseek") && !set.has("openai-chat")
    });
  }

  // Claude Code: supports anthropic
  if (set.has("anthropic")) {
    options.push({
      adapter: "claude-agent-acp",
      label: "Claude Code",
      isRecommended: true
    });
  }

  if (options.length === 0) {
    const fallback = baseAdapterForProtocol(fallbackProtocol);
    options.push({
      adapter: fallback,
      label: fallback === "claude-agent-acp" ? "Claude Code" : fallback === "dsh-acp" ? "DeepSeek" : "Codex",
      isRecommended: true
    });
  }

  return options;
}

export function newFreebieOverrideId(providerId: string): string {
  return `${FREEBIE_OVERRIDE_PREFIX}${providerId}-${overrideSuffix()}`;
}

/** Extracts the provider slug from an override id created by {@link newFreebieOverrideId}. */
export function freebieProviderIdFromOverrideId(overrideId: string): string | null {
  const match = OVERRIDE_ID_PATTERN.exec(overrideId);
  return match ? match[1] : null;
}

export function importedFreebieProviderIds(overrideIds: Iterable<string>): string[] {
  const ids = new Set<string>();
  for (const overrideId of overrideIds) {
    const providerId = freebieProviderIdFromOverrideId(overrideId);
    if (providerId) ids.add(providerId);
  }
  return [...ids].sort();
}

export interface BuildFreebieOverrideInput {
  preset: FreebieProviderPreset;
  apiKey: string;
  /** Subset of `preset.models` ids the user kept; empty means all. */
  modelIds?: string[];
  label: string;
  overrideId?: string;
  baseAdapter?: FreebieBaseAdapter;
  icon?: string;
}

/**
 * Turns a validated provider preset plus the user's API key into a BYOK clone
 * override that `cliExecutorStore.upsertOverride` accepts. The first selected
 * model becomes the default via `--model=`, matching what the Agents settings
 * editor writes.
 */
export function buildFreebieOverride(input: BuildFreebieOverrideInput): CLIExecutorOverride {
  const { preset } = input;
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("apiKey is required");

  const keep = input.modelIds?.length ? new Set(input.modelIds) : null;
  const models: CLIByokModel[] = preset.models
    .filter((model) => !keep || keep.has(model.id))
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      supportsVision: model.supportsVision
    }));
  if (!models.length) throw new Error("at least one model must be selected");

  const baseAdapter: FreebieBaseAdapter = input.baseAdapter ?? baseAdapterForProtocol(preset.protocol);
  const envKey = preset.envKey ?? defaultEnvKeyForAdapter(baseAdapter, preset.protocol);
  const icon = input.icon !== undefined ? input.icon : normalizeFreebieIcon(preset.icon);
  const override: CLIExecutorOverride = {
    id: input.overrideId ?? newFreebieOverrideId(preset.id),
    baseAdapter,
    label: input.label,
    icon: icon || undefined,
    extraArgs: [`--model=${models[0].id}`],
    enabled: true
  };

  switch (baseAdapter) {
    case "claude-agent-acp":
      override.claudeByok = {
        enabled: true,
        baseUrl: preset.baseUrl,
        envKey,
        apiKey,
        models,
        contextWindow: preset.contextWindow
      };
      break;
    case "dsh-acp":
      override.deepseekByok = {
        enabled: true,
        baseUrl: preset.baseUrl,
        envKey,
        wireApi: "chat",
        apiKey,
        models,
        contextWindow: preset.contextWindow
      };
      break;
    default:
      override.codexByok = {
        enabled: true,
        providerId: preset.id,
        providerName: preset.name,
        baseUrl: preset.baseUrl,
        envKey,
        wireApi: preset.protocol === "openai-responses" ? "responses" : "chat",
        apiKey,
        models,
        contextWindow: preset.contextWindow
      };
  }

  return override;
}

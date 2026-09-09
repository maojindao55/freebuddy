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

export function runtimeKeyForProtocol(protocol: FreebieProtocol): keyof FreebieRuntimeState {
  switch (protocol) {
    case "anthropic":
      return "claude";
    case "deepseek":
      return "deepseek";
    default:
      return "codex";
  }
}

export function defaultEnvKeyForProtocol(protocol: FreebieProtocol): string {
  switch (protocol) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    default:
      return "OPENAI_API_KEY";
  }
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

  const baseAdapter: CLIAdapterId = baseAdapterForProtocol(preset.protocol);
  const envKey = preset.envKey ?? defaultEnvKeyForProtocol(preset.protocol);
  const override: CLIExecutorOverride = {
    id: input.overrideId ?? newFreebieOverrideId(preset.id),
    baseAdapter,
    label: input.label,
    extraArgs: [`--model=${models[0].id}`],
    enabled: true
  };

  switch (preset.protocol) {
    case "anthropic":
      override.claudeByok = {
        enabled: true,
        baseUrl: preset.baseUrl,
        envKey,
        apiKey,
        models,
        contextWindow: preset.contextWindow
      };
      break;
    case "deepseek":
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

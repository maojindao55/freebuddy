import { safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CLIAdapterId } from "./adapters.js";
import {
  resolveCodexBinaryHint,
  resolveNodeBinaryHint
} from "./codexBinaryHint.js";
import { buildCodexAppServerWrapperContent } from "./codexByokWrapper.js";
import {
  registerCodexChatBridgeRoute,
  setResponsesBridgeLogger,
  startResponsesBridge
} from "./responsesBridge.js";
import { getDataDir, getDb } from "./db.js";
import { getCallerUserId, isCallerAdmin } from "./callerContext.js";
import { logMain } from "../debugLog.js";

export interface CLICodexByokConfig {
  enabled?: boolean;
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  envKey?: string;
  wireApi?: "responses" | "chat";
  apiKey?: string;
  apiKeyPreview?: string;
  apiKeyEncrypted?: string;
  models?: CLIByokModel[];
  contextWindow?: number;
}

export interface CLIClaudeByokConfig {
  enabled?: boolean;
  baseUrl?: string;
  envKey?: string;
  apiKey?: string;
  apiKeyPreview?: string;
  apiKeyEncrypted?: string;
  models?: CLIByokModel[];
  contextWindow?: number;
  compaction?: CLIClaudeCompactionConfig;
}

export interface CLIDeepSeekByokConfig {
  enabled?: boolean;
  baseUrl?: string;
  envKey?: string;
  wireApi?: "chat" | "responses";
  apiKey?: string;
  apiKeyPreview?: string;
  apiKeyEncrypted?: string;
  officialApiKey?: string;
  officialApiKeyPreview?: string;
  officialApiKeyEncrypted?: string;
  models?: CLIByokModel[];
  contextWindow?: number;
}

export interface CLIClaudeCompactionConfig {
  enabled?: boolean;
  window?: number;
}

export interface CLIByokModel {
  id: string;
  name?: string;
  contextWindow?: number;
  supportsVision?: boolean;
}

export interface CLIExecutorOverride {
  id: CLIAdapterId;
  baseAdapter?: CLIAdapterId;
  label?: string;
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  installHint?: string;
  docsUrl?: string;
  icon?: string;
  enabled?: boolean;
  codexByok?: CLICodexByokConfig;
  claudeByok?: CLIClaudeByokConfig;
  deepseekByok?: CLIDeepSeekByokConfig;
  skillIds?: string[];
}

const SAFE_STORAGE_PREFIX = "safe:";
const FALLBACK_STORAGE_PREFIX = "base64:";
const secretDecryptCache = new Map<string, string>();

export function redactApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const suffix = trimmed.slice(-4);
  return `${"•".repeat(8)}${suffix}`;
}

export function encryptSecret(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(value).toString("base64")}`;
  }
  return `${FALLBACK_STORAGE_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
}

export function decryptSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cached = secretDecryptCache.get(value);
  if (cached !== undefined) return cached;
  try {
    if (value.startsWith(SAFE_STORAGE_PREFIX)) {
      const decrypted = safeStorage.decryptString(
        Buffer.from(value.slice(SAFE_STORAGE_PREFIX.length), "base64")
      );
      secretDecryptCache.set(value, decrypted);
      return decrypted;
    }
    if (value.startsWith(FALLBACK_STORAGE_PREFIX)) {
      const decrypted = Buffer.from(
        value.slice(FALLBACK_STORAGE_PREFIX.length),
        "base64"
      ).toString("utf8");
      secretDecryptCache.set(value, decrypted);
      return decrypted;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readOverrideExtraArgs(id: string): string[] {
  const row = getDb()
    .prepare(`SELECT extra_args FROM cli_executor_overrides WHERE id = ?`)
    .get(id) as { extra_args: string | null } | undefined;
  if (!row?.extra_args) return [];
  try {
    const parsed = JSON.parse(row.extra_args);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function extractModelArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-m" || arg === "--model") {
      const model = args[i + 1]?.trim();
      if (model) return model;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const model = arg.slice("--model=".length).trim();
      if (model) return model;
    }
    if (arg === "-c" || arg === "--config") {
      const model = extractModelFromConfigPair(args[i + 1]);
      if (model) return model;
      i += args[i + 1] ? 1 : 0;
      continue;
    }
    if (arg.startsWith("-c=") || arg.startsWith("--config=")) {
      const model = extractModelFromConfigPair(arg.slice(arg.indexOf("=") + 1));
      if (model) return model;
    }
  }
  return undefined;
}

function extractModelFromConfigPair(pair: string | undefined): string | undefined {
  if (!pair) return undefined;
  const eq = pair.indexOf("=");
  if (eq <= 0 || pair.slice(0, eq).trim() !== "model") return undefined;
  const raw = pair.slice(eq + 1).trim();
  const quoted = raw.match(/^(['"])(.*)\1$/);
  return (quoted ? quoted[2] : raw).trim() || undefined;
}

/**
 * Slugs from ~/.codex/models_cache.json. Used so the BYOK catalog covers
 * every model the in-session ACP model picker can select — the selected model
 * arrives via session/set_config_option AFTER the env is resolved, so the
 * catalog must be prepared for any of codex's known models.
 */
function readCachedCodexModelSlugs(): string[] {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8")
    );
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const slugs: string[] = [];
    for (const entry of models) {
      const slug =
        entry && typeof entry.slug === "string" ? entry.slug.trim() : "";
      if (slug) slugs.push(slug);
    }
    return slugs;
  } catch {
    return [];
  }
}

function safeCatalogFilePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url").slice(0, 80);
}

function readCodexModelTemplate(): Record<string, unknown> | undefined {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const cacheFile = path.join(codexHome, "models_cache.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const cached =
      models.find((entry: any) => entry?.slug === "gpt-5.4") ??
      models.find((entry: any) => entry?.slug === "gpt-5.5") ??
      models[0];
    if (!cached) return undefined;
    // The models cache may lack required catalog fields (base_instructions,
    // truncation_policy, …) and may carry Responses-Lite / code-mode flags that
    // hide tools behind a Codex-proprietary input item for custom providers
    // (openai/codex#34758). Merge over the fallback so the written catalog
    // always parses and always exposes the shell tool.
    const merged: Record<string, unknown> = {
      ...fallbackCodexModelTemplate(),
      ...cached
    };
    merged.shell_type = "shell_command";
    merged.use_responses_lite = false;
    delete merged.tool_mode;
    delete merged.code_mode;
    return merged;
  } catch {
    return undefined;
  }
}

function fallbackCodexModelTemplate(): Record<string, unknown> {
  return {
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses" },
      { effort: "medium", description: "Balanced responses" },
      { effort: "high", description: "Deeper reasoning" }
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    base_instructions:
      "You are Codex, a coding agent. Help the user with software engineering tasks, inspect the workspace before making changes, keep edits focused, and verify your work with relevant checks.",
    supports_reasoning_summaries: true,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272000,
    max_context_window: 272000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false
  };
}

const BYOK_CONTEXT_WINDOW_MIN = 100_000;
const BYOK_CONTEXT_WINDOW_MAX = 1_000_000;

function normalizeByokContextWindow(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= BYOK_CONTEXT_WINDOW_MIN &&
    value <= BYOK_CONTEXT_WINDOW_MAX
    ? value
    : undefined;
}

function normalizeByokModels(
  models: CLIByokModel[] | undefined,
  options: { defaultSupportsVision?: boolean } = {}
): CLIByokModel[] {
  const seen = new Set<string>();
  const normalized: CLIByokModel[] = [];
  for (const model of models ?? []) {
    const id = model?.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = model.name?.trim();
    const contextWindow = normalizeByokContextWindow(model.contextWindow);
    const supportsVision =
      typeof model.supportsVision === "boolean"
        ? model.supportsVision
        : options.defaultSupportsVision;
    normalized.push({
      id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(supportsVision !== undefined ? { supportsVision } : {})
    });
  }
  return normalized;
}

function normalizeCodexByokModels(
  models: CLIByokModel[] | undefined
): CLIByokModel[] {
  // Direct ACP image attachments have always been forwarded for custom Codex
  // providers. Default legacy model entries to the same capability so path-
  // based view_image calls are not incorrectly blocked as text-only. Providers
  // that are genuinely text-only can opt out per model in Settings.
  return normalizeByokModels(models, { defaultSupportsVision: true });
}

function createCodexByokModelCatalog(
  models: CLIByokModel[],
  defaultContextWindow?: number
): string | undefined {
  if (!models.length) return undefined;
  const baseTemplate = readCodexModelTemplate() ?? fallbackCodexModelTemplate();
  const normalizedDefault = normalizeByokContextWindow(defaultContextWindow);
  const catalog = {
    models: models.map((model, index) => {
      const contextWindow =
        normalizeByokContextWindow(model.contextWindow) ?? normalizedDefault;
      const template = contextWindow
        ? {
            ...baseTemplate,
            context_window: contextWindow,
            max_context_window: contextWindow
          }
        : baseTemplate;
      return {
        ...template,
        slug: model.id,
        display_name: model.name || model.id,
        description: "Custom BYOK model",
        priority: index,
        supported_in_api: true,
        visibility: "list",
        supports_reasoning_summaries: true,
        input_modalities:
          model.supportsVision === false ? ["text"] : ["text", "image"],
        supports_image_detail_original: model.supportsVision !== false
      };
    })
  };
  const dir = path.join(getDataDir(), "codex-model-catalogs");
  fs.mkdirSync(dir, { recursive: true });
  const signature = models
    .map(
      (model) =>
        `${model.id}\u0000${model.name ?? ""}\u0000${model.contextWindow ?? ""}\u0000${
          model.supportsVision === false ? "text" : "vision"
        }`
    )
    .join("\u0001");
  const file = path.join(dir, `${safeCatalogFilePart(signature)}.json`);
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2), "utf8");
  return file;
}

function readOverrideBinary(id: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT binary FROM cli_executor_overrides WHERE id = ?`)
    .get(id) as { binary: string | null } | undefined;
  const binary = row?.binary?.trim();
  return binary || undefined;
}

function createCodexAppServerWrapper(
  modelCatalogPath: string
): string | undefined {
  const dir = path.join(getDataDir(), "codex-wrappers");
  fs.mkdirSync(dir, { recursive: true });
  const { extension, script } =
    buildCodexAppServerWrapperContent(modelCatalogPath);
  const file = path.join(
    dir,
    `${safeCatalogFilePart(modelCatalogPath)}${extension}`
  );
  fs.writeFileSync(file, script, { encoding: "utf8", mode: 0o755 });
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o755);
  }
  return file;
}

function readByokPublic<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as any;
    const {
      apiKey,
      apiKeyEncrypted,
      officialApiKey,
      officialApiKeyEncrypted,
      ...publicConfig
    } = parsed;
    return publicConfig as T;
  } catch {
    return undefined;
  }
}

function readPrivateByok<T>(
  id: string,
  column: "codex_byok" | "claude_byok" | "deepseek_byok"
) {
  const row = getDb()
    .prepare(`SELECT ${column} FROM cli_executor_overrides WHERE id = ?`)
    .get(id) as Record<typeof column, string | null> | undefined;
  const raw = row?.[column];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function readCodexByokPrivate(id: string): CLICodexByokConfig | undefined {
  return readPrivateByok<CLICodexByokConfig>(id, "codex_byok");
}

function readClaudeByokPrivate(id: string): CLIClaudeByokConfig | undefined {
  return readPrivateByok<CLIClaudeByokConfig>(id, "claude_byok");
}

function readDeepSeekByokPrivate(id: string): CLIDeepSeekByokConfig | undefined {
  return readPrivateByok<CLIDeepSeekByokConfig>(id, "deepseek_byok");
}

// codex >= 0.146 removed `wire_api = "chat"` support: the codex binary only
// speaks the Responses API. Keep the user's "chat" selection in storage —
// resolveCodexByokEnv serves it through the local Responses↔chat bridge — and
// coerce anything else (legacy/stale values) to "responses".
function normalizeWireApi(
  value: CLICodexByokConfig["wireApi"]
): "responses" | "chat" {
  return value === "chat" ? "chat" : "responses";
}

function hasCodexChatWireByok(): boolean {
  try {
    const row = getDb()
      .prepare(
        `SELECT 1 FROM cli_executor_overrides
         WHERE codex_byok LIKE '%"wireApi":"chat"%' LIMIT 1`
      )
      .get();
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Pre-start the local Responses↔chat bridge so resolveCodexByokEnv can point
 * codex at a bridge route. Session runners await this before resolving BYOK
 * env; it is a no-op unless some codex BYOK config selects wireApi "chat".
 */
export async function ensureCodexChatBridge(): Promise<void> {
  if (!hasCodexChatWireByok()) return;
  setResponsesBridgeLogger((log) => {
    logMain().info("responsesBridge", "request translated", {
      model: log.model,
      stream: log.stream,
      tools: log.toolNames,
      localShell: log.localShellToolNames,
      custom: log.customToolNames,
      droppedToolTypes: log.droppedToolTypes
    });
  });
  await startResponsesBridge();
}

function normalizeByokForStorage(
  id: string,
  input: CLICodexByokConfig | undefined
): CLICodexByokConfig | undefined {
  if (!input?.enabled) return undefined;
  const previous = readCodexByokPrivate(id);
  const apiKey = input.apiKey?.trim();
  const apiKeyEncrypted = apiKey
    ? encryptSecret(apiKey)
    : previous?.apiKeyEncrypted;
  const apiKeyPreview = apiKey
    ? redactApiKey(apiKey)
    : input.apiKeyPreview ?? previous?.apiKeyPreview;
  const hasContextWindowInput = Object.prototype.hasOwnProperty.call(
    input,
    "contextWindow"
  );
  const contextWindow = hasContextWindowInput
    ? normalizeByokContextWindow(input.contextWindow)
    : normalizeByokContextWindow(previous?.contextWindow);
  return {
    enabled: true,
    providerId: input.providerId?.trim() || "proxy",
    providerName: input.providerName?.trim() || "BYOK provider",
    baseUrl: input.baseUrl?.trim(),
    envKey: input.envKey?.trim() || "OPENAI_API_KEY",
    wireApi: normalizeWireApi(input.wireApi),
    models: normalizeCodexByokModels(input.models),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    apiKeyPreview,
    apiKeyEncrypted
  };
}

function normalizeClaudeByokForStorage(
  id: string,
  input: CLIClaudeByokConfig | undefined
): CLIClaudeByokConfig | undefined {
  if (!input?.enabled) return undefined;
  const previous = readClaudeByokPrivate(id);
  const apiKey = input.apiKey?.trim();
  const apiKeyEncrypted = apiKey
    ? encryptSecret(apiKey)
    : previous?.apiKeyEncrypted;
  const apiKeyPreview = apiKey
    ? redactApiKey(apiKey)
    : input.apiKeyPreview ?? previous?.apiKeyPreview;
  const hasContextWindowInput =
    Object.prototype.hasOwnProperty.call(input, "contextWindow") ||
    Object.prototype.hasOwnProperty.call(input.compaction ?? {}, "window");
  const contextWindow = hasContextWindowInput
    ? normalizeByokContextWindow(
        input.contextWindow ?? input.compaction?.window
      )
    : normalizeByokContextWindow(
        previous?.contextWindow ?? previous?.compaction?.window
      );
  const compaction = normalizeClaudeCompaction(
    input.compaction ?? previous?.compaction,
    contextWindow
  );
  return {
    enabled: true,
    baseUrl: input.baseUrl?.trim(),
    envKey: input.envKey?.trim() || "ANTHROPIC_API_KEY",
    models: normalizeByokModels(input.models),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(compaction ? { compaction } : {}),
    apiKeyPreview,
    apiKeyEncrypted
  };
}

function normalizeDeepSeekByokForStorage(
  id: string,
  input: CLIDeepSeekByokConfig | undefined
): CLIDeepSeekByokConfig | undefined {
  const previous = readDeepSeekByokPrivate(id);

  // Official Key (for official api.deepseek.com)
  const officialApiKey = input?.officialApiKey?.trim();
  const officialApiKeyEncrypted = officialApiKey
    ? encryptSecret(officialApiKey)
    : input?.officialApiKey === ""
      ? undefined
      : previous?.officialApiKeyEncrypted;
  const officialApiKeyPreview = officialApiKey
    ? redactApiKey(officialApiKey)
    : input?.officialApiKey === ""
      ? undefined
      : input?.officialApiKeyPreview ?? previous?.officialApiKeyPreview;

  // Custom BYOK Key (for custom proxy / Base URL)
  const apiKey = input?.apiKey?.trim();
  const apiKeyEncrypted = apiKey
    ? encryptSecret(apiKey)
    : input?.apiKey === ""
      ? undefined
      : previous?.apiKeyEncrypted;
  const apiKeyPreview = apiKey
    ? redactApiKey(apiKey)
    : input?.apiKey === ""
      ? undefined
      : input?.apiKeyPreview ?? previous?.apiKeyPreview;

  if (!input?.enabled) {
    if (officialApiKeyEncrypted || apiKeyEncrypted) {
      return {
        enabled: false,
        officialApiKeyPreview,
        officialApiKeyEncrypted,
        apiKeyPreview,
        apiKeyEncrypted
      };
    }
    return undefined;
  }

  const hasContextWindowInput = Object.prototype.hasOwnProperty.call(
    input,
    "contextWindow"
  );
  const contextWindow = hasContextWindowInput
    ? normalizeByokContextWindow(input.contextWindow)
    : normalizeByokContextWindow(previous?.contextWindow);
  return {
    enabled: true,
    baseUrl: input.baseUrl?.trim(),
    envKey: input.envKey?.trim() || "DEEPSEEK_API_KEY",
    wireApi: "chat",
    models: normalizeByokModels(input.models),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    officialApiKeyPreview,
    officialApiKeyEncrypted,
    apiKeyPreview,
    apiKeyEncrypted
  };
}

function normalizeClaudeCompaction(
  input: CLIClaudeCompactionConfig | undefined,
  contextWindow?: number
): CLIClaudeCompactionConfig | undefined {
  if (!input) return undefined;
  if (input.enabled === undefined) return undefined;
  // contextWindow (top-level) is canonical; compaction.window mirrors it for
  // configs that still read the legacy field. Preserve the window instead of
  // silently dropping it on persist.
  const window = contextWindow ?? normalizeByokContextWindow(input.window);
  return {
    enabled: input.enabled === true,
    ...(window !== undefined ? { window } : {})
  };
}

export function listOverrides(): CLIExecutorOverride[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, base_adapter, label, binary, extra_args, env, install_hint, docs_url, icon, enabled, codex_byok
              , claude_byok, deepseek_byok, skill_ids
       FROM cli_executor_overrides ORDER BY id`
    )
    .all() as Array<{
    id: string;
    base_adapter: string | null;
    label: string | null;
    binary: string | null;
    extra_args: string | null;
    env: string | null;
    install_hint: string | null;
    docs_url: string | null;
    icon: string | null;
    enabled: number;
    codex_byok: string | null;
    claude_byok: string | null;
    deepseek_byok: string | null;
    skill_ids: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    baseAdapter: r.base_adapter ?? undefined,
    label: r.label ?? undefined,
    binary: r.binary ?? undefined,
    extraArgs: r.extra_args ? (JSON.parse(r.extra_args) as string[]) : [],
    env: r.env ? (JSON.parse(r.env) as Record<string, string>) : undefined,
    installHint: r.install_hint ?? undefined,
    docsUrl: r.docs_url ?? undefined,
    icon: r.icon ?? undefined,
    enabled: r.enabled !== 0,
    codexByok: readByokPublic<CLICodexByokConfig>(r.codex_byok),
    claudeByok: readByokPublic<CLIClaudeByokConfig>(r.claude_byok),
    deepseekByok: readByokPublic<CLIDeepSeekByokConfig>(r.deepseek_byok),
    skillIds: r.skill_ids ? (JSON.parse(r.skill_ids) as string[]) : []
  }));
}

export function upsertOverride(o: CLIExecutorOverride): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cli_executor_overrides
       (id, base_adapter, label, binary, extra_args, env, install_hint, docs_url, icon, enabled, codex_byok, claude_byok, deepseek_byok, skill_ids, updated_at)
     VALUES (@id, @base_adapter, @label, @binary, @extra_args, @env, @install_hint, @docs_url, @icon, @enabled, @codex_byok, @claude_byok, @deepseek_byok, @skill_ids, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       base_adapter=excluded.base_adapter,
       label=excluded.label,
       binary=excluded.binary,
       extra_args=excluded.extra_args,
       env=excluded.env,
       install_hint=excluded.install_hint,
       docs_url=excluded.docs_url,
       icon=excluded.icon,
       enabled=excluded.enabled,
       codex_byok=excluded.codex_byok,
       claude_byok=excluded.claude_byok,
       deepseek_byok=excluded.deepseek_byok,
       skill_ids=excluded.skill_ids,
       updated_at=excluded.updated_at`
  ).run({
    id: o.id,
    base_adapter: o.baseAdapter ?? null,
    label: o.label ?? null,
    binary: o.binary ?? null,
    extra_args: JSON.stringify(o.extraArgs ?? []),
    env: o.env ? JSON.stringify(o.env) : null,
    install_hint: o.installHint ?? null,
    docs_url: o.docsUrl ?? null,
    icon: o.icon ?? null,
    enabled: o.enabled === false ? 0 : 1,
    codex_byok: (() => {
      const byok = normalizeByokForStorage(String(o.id), o.codexByok);
      return byok ? JSON.stringify(byok) : null;
    })(),
    claude_byok: (() => {
      const byok = normalizeClaudeByokForStorage(String(o.id), o.claudeByok);
      return byok ? JSON.stringify(byok) : null;
    })(),
    deepseek_byok: (() => {
      const byok = normalizeDeepSeekByokForStorage(String(o.id), o.deepseekByok);
      return byok ? JSON.stringify(byok) : null;
    })(),
    skill_ids: JSON.stringify(o.skillIds ?? []),
    updated_at: now
  });
}

export function resetOverride(id: string): void {
  getDb().prepare(`DELETE FROM cli_executor_overrides WHERE id = ?`).run(id);
}

export function resolveCodexByokEnv(
  agentId: string,
  adapter: string,
  selectedModel?: string
): Record<string, string> | undefined {
  if (adapter !== "codex-acp") return undefined;
  const overrideId = agentId.startsWith("cli-") ? agentId.slice(4) : agentId;
  const byok = readCodexByokPrivate(overrideId);
  if (!byok?.enabled) return undefined;
  const apiKey = decryptSecret(byok.apiKeyEncrypted);
  const providerId = byok.providerId?.trim() || "proxy";
  const envKey = byok.envKey?.trim() || "OPENAI_API_KEY";
  const configuredModels = normalizeCodexByokModels(byok.models);
  const model =
    selectedModel?.trim() ||
    extractModelArg(readOverrideExtraArgs(overrideId)) ||
    configuredModels[0]?.id;
  // The catalog must cover configured models, any explicitly selected model,
  // and — because the in-session picker selects models via ACP after env
  // resolution — every cached codex model slug. Without a matching catalog
  // entry codex falls back to its bundled gpt-5.6* metadata, which hides all
  // tools behind Responses-Lite for custom providers (openai/codex#34758).
  const catalogModels = normalizeCodexByokModels([
    ...configuredModels,
    ...(model ? [{ id: model }] : []),
    ...readCachedCodexModelSlugs().map((slug) => ({ id: slug }))
  ]);
  const modelCatalogPath = createCodexByokModelCatalog(
    catalogModels,
    byok.contextWindow
  );
  const codexPath = modelCatalogPath
    ? createCodexAppServerWrapper(modelCatalogPath)
    : undefined;
  const wireApi = normalizeWireApi(byok.wireApi);
  let baseUrl = byok.baseUrl?.trim();
  if (wireApi === "chat" && baseUrl) {
    // codex itself no longer speaks chat/completions; hand codex a local
    // bridge route that translates Responses ↔ chat/completions instead.
    // Without a running bridge fall back to direct "responses" (previous
    // behavior) so codex still starts.
    const route = registerCodexChatBridgeRoute(baseUrl);
    if (route) baseUrl = `http://127.0.0.1:${route.port}/v1/${route.routeId}`;
  }
  const config: Record<string, unknown> = {
    model_provider: providerId,
    ...(model ? { model } : {}),
    model_supports_reasoning_summaries: true,
    model_providers: {
      [providerId]: {
        name: byok.providerName?.trim() || "BYOK provider",
        base_url: baseUrl,
        env_key: envKey,
        wire_api: wireApi === "chat" ? "responses" : wireApi
      }
    },
    ...(modelCatalogPath ? { model_catalog_json: modelCatalogPath } : {})
  };
  const env: Record<string, string> = {
    CODEX_CONFIG: JSON.stringify(config),
    MODEL_PROVIDER: providerId
  };
  if (codexPath) env.CODEX_PATH = codexPath;
  const codexBin = resolveCodexBinaryHint({
    acpBinaryHint: readOverrideBinary(overrideId)
  });
  if (codexBin) env.FREEBUDDY_CODEX_BIN = codexBin;
  const nodeBin = resolveNodeBinaryHint();
  if (nodeBin) env.FREEBUDDY_NODE_BIN = nodeBin;
  if (apiKey) env[envKey] = apiKey;
  return env;
}

export function resolveClaudeByokEnv(
  agentId: string,
  adapter: string,
  selectedModel?: string
): Record<string, string> | undefined {
  if (adapter !== "claude-agent-acp" && adapter !== "claude") return undefined;
  const overrideId = agentId.startsWith("cli-") ? agentId.slice(4) : agentId;
  const byok = readClaudeByokPrivate(overrideId);
  if (!byok?.enabled) return undefined;
  const apiKey = decryptSecret(byok.apiKeyEncrypted);
  const envKey = byok.envKey?.trim() || "ANTHROPIC_API_KEY";
  const env: Record<string, string> = {};
  const baseUrl = byok.baseUrl?.trim();
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey) env[envKey] = apiKey;
  // Claude Code assumes 200K for model names it does not recognize (e.g. a
  // non-Claude model served through a proxy). autoCompactWindow alone cannot
  // raise that perceived limit — it is capped at the model's assumed window.
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS is the documented override for exactly this
  // case, so a BYOK provider's real context window is honored.
  const contextWindow = normalizeByokContextWindow(
    byok.contextWindow ?? byok.compaction?.window
  );
  if (contextWindow) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow);
  const models = normalizeByokModels(byok.models);
  if (models.length) {
    const requestedModel = selectedModel?.trim();
    const activeModel =
      models.find((model) => model.id === requestedModel)?.id ?? models[0].id;
    env.CLAUDE_MODEL_CONFIG = JSON.stringify({
      availableModels: models.map((model) => model.id)
    });
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = activeModel;
    env.ANTHROPIC_MODEL = activeModel;
  }
  return Object.keys(env).length ? env : undefined;
}

export function resolveClaudeByokSessionOptions(
  agentId: string,
  adapter: string
): {
  settings: {
    autoCompactEnabled: boolean;
  };
} | undefined {
  if (adapter !== "claude-agent-acp" && adapter !== "claude") return undefined;
  const overrideId = agentId.startsWith("cli-") ? agentId.slice(4) : agentId;
  const byok = readClaudeByokPrivate(overrideId);
  if (!byok?.enabled) return undefined;
  const compaction = normalizeClaudeCompaction(byok.compaction);
  // The context window itself is set via CLAUDE_CODE_MAX_CONTEXT_TOKENS in
  // resolveClaudeByokEnv. We intentionally do NOT set autoCompactWindow here:
  // setting it switches the SDK into proactive compaction, which summarizes
  // at a percentage of the window (~50-60%) instead of near the limit. Letting
  // the SDK compact at the model's context limit matches what users expect.
  return {
    settings: {
      // Existing Claude BYOK configurations predate this setting. Enable it
      // by default so they also get protection from context-window overflow.
      autoCompactEnabled: compaction?.enabled !== false
    }
  };
}

export function resolveDeepSeekByokEnv(
  agentId: string,
  adapter: string,
  selectedModel?: string
): Record<string, string> | undefined {
  if (adapter !== "dsh-acp") return undefined;
  const overrideId = agentId.startsWith("cli-") ? agentId.slice(4) : agentId;
  const byok = readDeepSeekByokPrivate(overrideId);
  if (!byok) return undefined;
  const env: Record<string, string> = {};

  if (!byok.enabled) {
    const officialKey = decryptSecret(
      byok.officialApiKeyEncrypted ?? byok.apiKeyEncrypted
    );
    if (officialKey) {
      env.DEEPSEEK_API_KEY = officialKey;
    }
    return Object.keys(env).length ? env : undefined;
  }

  const apiKey = decryptSecret(byok.apiKeyEncrypted);
  const envKey = byok.envKey?.trim() || "DEEPSEEK_API_KEY";
  const baseUrl = byok.baseUrl?.trim();
  if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl;
  if (apiKey) {
    env[envKey] = apiKey;
    if (envKey !== "DEEPSEEK_API_KEY") {
      env.DEEPSEEK_API_KEY = apiKey;
    }
  }
  if (byok.envKey?.trim()) {
    env.DEEPSEEK_API_KEY_ENV = byok.envKey.trim();
  }
  if (byok.wireApi) {
    env.DEEPSEEK_WIRE_API = byok.wireApi;
  }
  const contextWindow = normalizeByokContextWindow(byok.contextWindow);
  if (contextWindow) {
    env.DEEPSEEK_MAX_CONTEXT_TOKENS = String(contextWindow);
  }
  const models = normalizeByokModels(byok.models);
  if (models.length) {
    const requestedModel = selectedModel?.trim();
    const activeModel =
      models.find((model) => model.id === requestedModel)?.id ?? models[0].id;
    env.DEEPSEEK_MODEL = activeModel;
    env.DSH_MODEL = activeModel;
    env.MODEL = activeModel;
  }
  return Object.keys(env).length ? env : undefined;
}

export function resolveCliByokEnv(
  agentId: string,
  adapter: string,
  selectedModel?: string
): Record<string, string> | undefined {
  return (
    resolveCodexByokEnv(agentId, adapter, selectedModel) ??
    resolveClaudeByokEnv(agentId, adapter, selectedModel) ??
    resolveDeepSeekByokEnv(agentId, adapter, selectedModel)
  );
}

export function cliByokModelSignature(
  agentId: string,
  adapter: string
): string {
  const overrideId = agentId.startsWith("cli-") ? agentId.slice(4) : agentId;
  const byok =
    adapter === "codex-acp"
      ? readCodexByokPrivate(overrideId)
      : adapter === "claude-agent-acp" || adapter === "claude"
        ? readClaudeByokPrivate(overrideId)
        : adapter === "dsh-acp"
          ? readDeepSeekByokPrivate(overrideId)
          : undefined;
  return JSON.stringify(
    adapter === "codex-acp"
      ? normalizeCodexByokModels(byok?.models)
      : normalizeByokModels(byok?.models)
  );
}

export function hasCliByokModels(agentId: string, adapter: string): boolean {
  const overrideId = agentId.startsWith("cli-") ? agentId.slice(4) : agentId;
  const byok =
    adapter === "codex-acp"
      ? readCodexByokPrivate(overrideId)
      : adapter === "claude-agent-acp" || adapter === "claude"
        ? readClaudeByokPrivate(overrideId)
        : adapter === "dsh-acp"
          ? readDeepSeekByokPrivate(overrideId)
          : undefined;
  return byok?.enabled === true && normalizeByokModels(byok.models).length > 0;
}

export function mergeCliByokModelOption<T extends {
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  currentLabel?: string;
  values?: { id: string; name?: string }[];
}>(
  agentId: string,
  adapter: string,
  options: T[],
  selectedModel?: string
): T[] {
  const overrideId = agentId.startsWith("cli-") ? agentId.slice(4) : agentId;
  const byok =
    adapter === "codex-acp"
      ? readCodexByokPrivate(overrideId)
      : adapter === "claude-agent-acp" || adapter === "claude"
        ? readClaudeByokPrivate(overrideId)
        : adapter === "dsh-acp"
          ? readDeepSeekByokPrivate(overrideId)
          : undefined;
  if (!byok?.enabled) return options;
  const models = normalizeByokModels(byok.models);
  if (!models.length) return options;

  const existingIndex = options.findIndex(
    (option) => option.id === "model" || option.category === "model"
  );
  const existing = existingIndex >= 0 ? options[existingIndex] : undefined;
  const requested = selectedModel?.trim();
  const existingCurrent = existing?.currentValue?.trim();
  const currentValue =
    adapter === "codex-acp" && existingCurrent
      ? existingCurrent
      : models.some((model) => model.id === requested)
        ? requested
        : existingCurrent &&
            models.some((model) => model.id === existingCurrent)
          ? existingCurrent
          : models[0].id;
  const modelOption = {
    ...(existing ?? {}),
    id: existing?.id || "model",
    name: existing?.name || "Model",
    category: "model",
    currentValue,
    currentLabel:
      models.find((model) => model.id === currentValue)?.name || currentValue,
    values: models.map((model) => ({
      id: model.id,
      name: model.name || model.id
    }))
  } as T;
  if (existingIndex < 0) return [modelOption, ...options];
  return options.map((option, index) =>
    index === existingIndex ? modelOption : option
  );
}

// ---- Tool sessions ------------------------------------------------------

export interface ToolSessionRecord {
  key: string;
  agentId: string;
  workspacePath: string;
  adapter: string;
  sessionId: string;
  title?: string;
  ownerId?: string | null;
  updatedAt: string;
}

export function toolSessionKey(
  agentId: string,
  workspacePath: string,
  ownerId: string | null = getCallerUserId()
): string {
  return ownerId
    ? `${ownerId}::${agentId}::${workspacePath}`
    : `${agentId}::${workspacePath}`;
}

export function getToolSession(
  agentId: string,
  workspacePath: string
): ToolSessionRecord | undefined {
  const ownerId = getCallerUserId();
  let row = getDb()
    .prepare(
      `SELECT key, agent_id, workspace_path, adapter, session_id, title,
              owner_id, updated_at
       FROM cli_tool_sessions WHERE key = ?`
    )
    .get(toolSessionKey(agentId, workspacePath, ownerId)) as
    | {
        key: string;
        agent_id: string;
        workspace_path: string;
        adapter: string;
        session_id: string;
        title: string | null;
        owner_id: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row && (isCallerAdmin() || ownerId === null)) {
    row = getDb()
      .prepare(
        `SELECT key, agent_id, workspace_path, adapter, session_id, title,
                owner_id, updated_at
         FROM cli_tool_sessions WHERE key = ?`
      )
      .get(toolSessionKey(agentId, workspacePath, null)) as typeof row;
  }
  if (!row) return undefined;
  return {
    key: row.key,
    agentId: row.agent_id,
    workspacePath: row.workspace_path,
    adapter: row.adapter,
    sessionId: row.session_id,
    title: row.title ?? undefined,
    ownerId: row.owner_id ?? null,
    updatedAt: row.updated_at
  };
}

export function saveToolSession(
  agentId: string,
  workspacePath: string,
  adapter: string,
  sessionId: string,
  title?: string
): void {
  const now = new Date().toISOString();
  const ownerId = getCallerUserId();
  getDb()
    .prepare(
      `INSERT INTO cli_tool_sessions
         (key, agent_id, workspace_path, adapter, session_id, title, owner_id,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         adapter=excluded.adapter,
         session_id=excluded.session_id,
         title=COALESCE(excluded.title, cli_tool_sessions.title),
         owner_id=excluded.owner_id,
         updated_at=excluded.updated_at`
    )
    .run(
      toolSessionKey(agentId, workspacePath, ownerId),
      agentId,
      workspacePath,
      adapter,
      sessionId,
      title ?? null,
      ownerId,
      now
    );
}

export function clearToolSessionsForAgent(agentId: string): void {
  getDb()
    .prepare("DELETE FROM cli_tool_sessions WHERE agent_id = ?")
    .run(agentId);
}

export function clearToolSession(
  agentId: string,
  workspacePath: string
): void {
  const ownerId = getCallerUserId();
  const db = getDb();
  db.prepare("DELETE FROM cli_tool_sessions WHERE key = ?").run(
    toolSessionKey(agentId, workspacePath, ownerId)
  );
  if (isCallerAdmin() || ownerId === null) {
    db.prepare("DELETE FROM cli_tool_sessions WHERE key = ?").run(
      toolSessionKey(agentId, workspacePath, null)
    );
  }
}

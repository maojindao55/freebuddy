import { safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CLIAdapterId } from "./adapters.js";
import { getDataDir, getDb } from "./db.js";

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
}

export interface CLIClaudeByokConfig {
  enabled?: boolean;
  baseUrl?: string;
  envKey?: string;
  apiKey?: string;
  apiKeyPreview?: string;
  apiKeyEncrypted?: string;
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
}

const SAFE_STORAGE_PREFIX = "safe:";
const FALLBACK_STORAGE_PREFIX = "base64:";
const secretDecryptCache = new Map<string, string>();

function redactApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const suffix = trimmed.slice(-4);
  return `${"•".repeat(8)}${suffix}`;
}

function encryptSecret(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(value).toString("base64")}`;
  }
  return `${FALLBACK_STORAGE_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
}

function decryptSecret(value: string | undefined): string | undefined {
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

function shouldCreateCodexModelCatalog(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  return !/^(gpt-|o[1345](?:-|$)|openai[/:])/.test(normalized);
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
    return (
      models.find((entry: any) => entry?.slug === "gpt-5.4") ??
      models.find((entry: any) => entry?.slug === "gpt-5.5") ??
      models[0]
    );
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
    context_window: 128000,
    max_context_window: 128000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false
  };
}

function createCodexByokModelCatalog(model: string): string | undefined {
  if (!shouldCreateCodexModelCatalog(model)) return undefined;
  const trimmed = model.trim();
  const template = readCodexModelTemplate() ?? fallbackCodexModelTemplate();
  const catalog = {
    models: [
      {
        ...template,
        slug: trimmed,
        display_name: trimmed,
        description: "Custom BYOK model",
        supported_in_api: true,
        visibility: "list",
        supports_reasoning_summaries: true
      }
    ]
  };
  const dir = path.join(getDataDir(), "codex-model-catalogs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeCatalogFilePart(trimmed)}.json`);
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2), "utf8");
  return file;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createCodexAppServerWrapper(
  modelCatalogPath: string
): string | undefined {
  const dir = path.join(getDataDir(), "codex-wrappers");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeCatalogFilePart(modelCatalogPath)}.sh`);
  const catalogArg = `model_catalog_json=${JSON.stringify(modelCatalogPath)}`;
  const script = `#!/bin/sh
catalog_arg=${shellSingleQuote(catalogArg)}
for candidate in "$FREEBUDDY_CODEX_BIN" "$(command -v codex 2>/dev/null)" "/opt/homebrew/bin/codex" "/usr/local/bin/codex"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$@" -c "$catalog_arg"
  fi
done
echo "FreeBuddy Codex BYOK wrapper could not find the codex binary." >&2
exit 127
`;
  fs.writeFileSync(file, script, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

function readByokPublic<T extends { apiKey?: string; apiKeyEncrypted?: string }>(
  raw: string | null
): Omit<T, "apiKey" | "apiKeyEncrypted"> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as T;
    const { apiKey, apiKeyEncrypted, ...publicConfig } = parsed;
    return publicConfig;
  } catch {
    return undefined;
  }
}

function readPrivateByok<T>(id: string, column: "codex_byok" | "claude_byok") {
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
  return {
    enabled: true,
    providerId: input.providerId?.trim() || "proxy",
    providerName: input.providerName?.trim() || "BYOK provider",
    baseUrl: input.baseUrl?.trim(),
    envKey: input.envKey?.trim() || "OPENAI_API_KEY",
    wireApi: input.wireApi || "responses",
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
  return {
    enabled: true,
    baseUrl: input.baseUrl?.trim(),
    envKey: input.envKey?.trim() || "ANTHROPIC_API_KEY",
    apiKeyPreview,
    apiKeyEncrypted
  };
}

export function listOverrides(): CLIExecutorOverride[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, base_adapter, label, binary, extra_args, env, install_hint, docs_url, icon, enabled, codex_byok
              , claude_byok
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
    claudeByok: readByokPublic<CLIClaudeByokConfig>(r.claude_byok)
  }));
}

export function upsertOverride(o: CLIExecutorOverride): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cli_executor_overrides
       (id, base_adapter, label, binary, extra_args, env, install_hint, docs_url, icon, enabled, codex_byok, claude_byok, updated_at)
     VALUES (@id, @base_adapter, @label, @binary, @extra_args, @env, @install_hint, @docs_url, @icon, @enabled, @codex_byok, @claude_byok, @updated_at)
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
    updated_at: now
  });
}

export function resetOverride(id: string): void {
  getDb().prepare(`DELETE FROM cli_executor_overrides WHERE id = ?`).run(id);
}

export function resolveCodexByokEnv(
  agentId: string,
  adapter: string
): Record<string, string> | undefined {
  if (adapter !== "codex-acp") return undefined;
  const overrideId = agentId.startsWith("cli-") ? agentId.slice(4) : agentId;
  const byok = readCodexByokPrivate(overrideId);
  if (!byok?.enabled) return undefined;
  const apiKey = decryptSecret(byok.apiKeyEncrypted);
  const providerId = byok.providerId?.trim() || "proxy";
  const envKey = byok.envKey?.trim() || "OPENAI_API_KEY";
  const model = extractModelArg(readOverrideExtraArgs(overrideId));
  const modelCatalogPath = model
    ? createCodexByokModelCatalog(model)
    : undefined;
  const codexPath = modelCatalogPath
    ? createCodexAppServerWrapper(modelCatalogPath)
    : undefined;
  const config: Record<string, unknown> = {
    model_provider: providerId,
    model_supports_reasoning_summaries: true,
    model_providers: {
      [providerId]: {
        name: byok.providerName?.trim() || "BYOK provider",
        base_url: byok.baseUrl?.trim(),
        env_key: envKey,
        wire_api: byok.wireApi || "responses"
      }
    },
    ...(modelCatalogPath ? { model_catalog_json: modelCatalogPath } : {})
  };
  const env: Record<string, string> = {
    CODEX_CONFIG: JSON.stringify(config),
    MODEL_PROVIDER: providerId
  };
  if (codexPath) env.CODEX_PATH = codexPath;
  if (apiKey) env[envKey] = apiKey;
  return env;
}

export function resolveClaudeByokEnv(
  agentId: string,
  adapter: string
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
  return Object.keys(env).length ? env : undefined;
}

export function resolveCliByokEnv(
  agentId: string,
  adapter: string
): Record<string, string> | undefined {
  return (
    resolveCodexByokEnv(agentId, adapter) ??
    resolveClaudeByokEnv(agentId, adapter)
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
  updatedAt: string;
}

export function toolSessionKey(
  agentId: string,
  workspacePath: string
): string {
  return `${agentId}::${workspacePath}`;
}

export function getToolSession(
  agentId: string,
  workspacePath: string
): ToolSessionRecord | undefined {
  const row = getDb()
    .prepare(
      `SELECT key, agent_id, workspace_path, adapter, session_id, title, updated_at
       FROM cli_tool_sessions WHERE key = ?`
    )
    .get(toolSessionKey(agentId, workspacePath)) as
    | {
        key: string;
        agent_id: string;
        workspace_path: string;
        adapter: string;
        session_id: string;
        title: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    key: row.key,
    agentId: row.agent_id,
    workspacePath: row.workspace_path,
    adapter: row.adapter,
    sessionId: row.session_id,
    title: row.title ?? undefined,
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
  getDb()
    .prepare(
      `INSERT INTO cli_tool_sessions
         (key, agent_id, workspace_path, adapter, session_id, title, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         adapter=excluded.adapter,
         session_id=excluded.session_id,
         title=COALESCE(excluded.title, cli_tool_sessions.title),
         updated_at=excluded.updated_at`
    )
    .run(
      toolSessionKey(agentId, workspacePath),
      agentId,
      workspacePath,
      adapter,
      sessionId,
      title ?? null,
      now
    );
}

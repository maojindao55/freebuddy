import { safeStorage } from "electron";
import type { CLIAdapterId } from "./adapters.js";
import { getDb } from "./db.js";

export interface CLICodexByokConfig {
  enabled?: boolean;
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  envKey?: string;
  wireApi?: "responses";
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
  try {
    if (value.startsWith(SAFE_STORAGE_PREFIX)) {
      return safeStorage.decryptString(
        Buffer.from(value.slice(SAFE_STORAGE_PREFIX.length), "base64")
      );
    }
    if (value.startsWith(FALLBACK_STORAGE_PREFIX)) {
      return Buffer.from(
        value.slice(FALLBACK_STORAGE_PREFIX.length),
        "base64"
      ).toString("utf8");
    }
  } catch {
    return undefined;
  }
  return undefined;
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
  const config: Record<string, unknown> = {
    model_provider: providerId,
    model_providers: {
      [providerId]: {
        name: byok.providerName?.trim() || "BYOK provider",
        base_url: byok.baseUrl?.trim(),
        env_key: envKey,
        wire_api: byok.wireApi || "responses"
      }
    }
  };
  const env: Record<string, string> = {
    CODEX_CONFIG: JSON.stringify(config),
    MODEL_PROVIDER: providerId
  };
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

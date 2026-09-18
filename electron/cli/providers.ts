import { getDb } from "./db.js";
import { decryptSecret, encryptSecret, redactApiKey } from "./store.js";

export type ProviderProtocol = "openai-chat" | "openai-responses" | "anthropic" | "deepseek";

export interface ProviderModel { id: string; name?: string; contextWindow?: number; supportsVision?: boolean; }

export interface ProviderRecord {
  id: string; presetId?: string; name: string;
  protocol: ProviderProtocol;
  protocols?: ProviderProtocol[]; baseUrl: string; envKey: string;
  apiKeyPreview?: string; hasKey: boolean; models: ProviderModel[];
  contextWindow?: number; icon?: string; enabled: boolean; position: number;
  wireApi?: "chat" | "responses"; notes?: string;
  lastHealth?: "unknown" | "ok" | "error"; lastLatencyMs?: number;
  lastError?: string; lastCheckedAt?: string; updatedAt: string;
}

export interface ProviderInput {
  id?: string; presetId?: string; name: string;
  protocol: ProviderProtocol;
  protocols?: ProviderProtocol[]; baseUrl: string; envKey?: string;
  apiKey?: string; models?: ProviderModel[]; contextWindow?: number;
  icon?: string; enabled?: boolean; position?: number;
  wireApi?: "chat" | "responses"; notes?: string;
}

interface ProviderRow {
  id: string; preset_id: string | null; name: string;
  protocol: string; protocols: string | null;
  base_url: string; env_key: string | null;
  api_key_encrypted: string | null; api_key_preview: string | null;
  models: string | null; context_window: number | null; icon: string | null;
  enabled: number; position: number; wire_api: string | null; notes: string | null;
  last_health: string | null; last_latency_ms: number | null;
  last_error: string | null; last_checked_at: string | null; updated_at: string;
}

const SUFFIX = "0123456789abcdefghijklmnopqrstuvwxyz";

function newProviderId(slug: string): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "custom";
  let s = "";
  for (let i = 0; i < 6; i += 1) s += SUFFIX[Math.floor(Math.random() * SUFFIX.length)];
  return `provider-${clean}-${s}`;
}

function parseModels(raw: string | null): ProviderModel[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    if (!Array.isArray(p)) return [];
    return p.filter((m) => m && typeof m.id === "string").map((m) => ({
      id: String(m.id),
      ...(typeof m.name === "string" ? { name: m.name } : {}),
      ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
      ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
      ...(typeof m.supportsVision === "boolean" ? { supportsVision: m.supportsVision } : {}),
      ...(typeof m.supportsReasoning === "boolean" ? { supportsReasoning: m.supportsReasoning } : {}),
      ...(typeof m.supportsTools === "boolean" ? { supportsTools: m.supportsTools } : {}),
      ...(typeof m.group === "string" ? { group: m.group } : {}),
    }));
  } catch { return []; }
}

function parseProtocols(raw: string | null, fb: ProviderProtocol): ProviderProtocol[] {
  if (!raw) return [fb];
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p) && p.length) return p.filter((x): x is ProviderProtocol => typeof x === "string");
  } catch { /* ignore */ }
  return [fb];
}

function rowToRecord(r: ProviderRow): ProviderRecord {
  const protocol = (r.protocol || "openai-chat") as ProviderProtocol;
  return {
    id: r.id, presetId: r.preset_id ?? undefined, name: r.name,
    protocol, protocols: parseProtocols(r.protocols, protocol), baseUrl: r.base_url,
    envKey: r.env_key || "OPENAI_API_KEY",
    apiKeyPreview: r.api_key_preview ?? undefined, hasKey: Boolean(r.api_key_encrypted),
    models: parseModels(r.models), contextWindow: r.context_window ?? undefined,
    icon: r.icon ?? undefined, enabled: r.enabled !== 0, position: r.position ?? 100,
    wireApi: (r.wire_api as ProviderRecord["wireApi"]) ?? undefined,
    notes: r.notes ?? undefined,
    lastHealth: (r.last_health as ProviderRecord["lastHealth"]) ?? "unknown",
    lastLatencyMs: r.last_latency_ms ?? undefined, lastError: r.last_error ?? undefined,
    lastCheckedAt: r.last_checked_at ?? undefined, updatedAt: r.updated_at,
  };
}

function reqName(v: string): string {
  const t = (v || "").trim();
  if (!t) throw new Error("服务商名称不能为空");
  if (t.length > 80) throw new Error("服务商名称过长（最多 80 字）");
  return t;
}

function reqUrl(v: string): string {
  const t = (v || "").trim().replace(/\/+$/, "");
  if (!t) throw new Error("Base URL 不能为空");
  try {
    const u = new URL(t);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("x");
  } catch { throw new Error("Base URL 格式不正确，需 http(s):// 开头"); }
  return t;
}

export function listProviders(): ProviderRecord[] {
  const rows = getDb().prepare(`SELECT * FROM providers ORDER BY position ASC, name ASC`).all() as ProviderRow[];
  return rows.map(rowToRecord);
}

export function getProvider(id: string): ProviderRecord | undefined {
  const row = getDb().prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as ProviderRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

/** 明文 Key 只在主进程内用，绝不返回渲染进程 */
export function getProviderApiKey(id: string): string | undefined {
  const row = getDb().prepare(`SELECT api_key_encrypted FROM providers WHERE id = ?`).get(id) as {
    api_key_encrypted: string | null;
  } | undefined;
  return decryptSecret(row?.api_key_encrypted ?? undefined);
}

export function upsertProvider(input: ProviderInput): ProviderRecord {
  const name = reqName(input.name);
  const baseUrl = reqUrl(input.baseUrl);
  const id = (input.id || "").trim() || newProviderId(input.presetId || input.name);
  const now = new Date().toISOString();
  const db = getDb();
  const ex = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as ProviderRow | undefined;
  if (input.presetId) {
    const dup = db.prepare(
      `SELECT id FROM providers WHERE preset_id = ? AND base_url = ? AND id <> ? LIMIT 1`,
    ).get(input.presetId, baseUrl, id) as { id: string } | undefined;
    if (dup) throw new Error(`该服务商已存在（${dup.id}），请勿重复导入`);
  }
  let enc = ex?.api_key_encrypted ?? null;
  let prev = ex?.api_key_preview ?? null;
  if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    enc = encryptSecret(input.apiKey.trim());
    prev = redactApiKey(input.apiKey.trim());
  }
  const maxPos = (db.prepare(`SELECT COALESCE(MAX(position),0) AS m FROM providers`).get() as { m: number }).m;
  db.prepare(
    `INSERT INTO providers (id,preset_id,name,protocol,protocols,base_url,env_key,
      api_key_encrypted,api_key_preview,models,context_window,icon,enabled,position,wire_api,notes,updated_at)
     VALUES (@id,@preset_id,@name,@protocol,@protocols,@base_url,@env_key,
      @api_key_encrypted,@api_key_preview,@models,@context_window,@icon,@enabled,@position,@wire_api,@notes,@updated_at)
     ON CONFLICT(id) DO UPDATE SET preset_id=excluded.preset_id,name=excluded.name,
      protocol=excluded.protocol,protocols=excluded.protocols,
      base_url=excluded.base_url,env_key=excluded.env_key,
      api_key_encrypted=excluded.api_key_encrypted,api_key_preview=excluded.api_key_preview,
      models=excluded.models,context_window=excluded.context_window,icon=excluded.icon,
      enabled=excluded.enabled,position=excluded.position,wire_api=excluded.wire_api,
      notes=excluded.notes,updated_at=excluded.updated_at`,
  ).run({
    id, preset_id: input.presetId ?? ex?.preset_id ?? null, name,
    protocol: input.protocol,
    protocols: JSON.stringify(input.protocols ?? parseProtocols(ex?.protocols ?? null, input.protocol)),
    base_url: baseUrl, env_key: input.envKey?.trim() || ex?.env_key || "OPENAI_API_KEY",
    api_key_encrypted: enc, api_key_preview: prev,
    models: JSON.stringify(input.models ?? parseModels(ex?.models ?? null)),
    context_window: input.contextWindow ?? ex?.context_window ?? null,
    icon: input.icon ?? ex?.icon ?? null,
    enabled: input.enabled === undefined ? (ex ? ex.enabled : 1) : input.enabled ? 1 : 0,
    position: input.position ?? ex?.position ?? maxPos + 10,
    wire_api: input.wireApi ?? ex?.wire_api ?? null,
    notes: input.notes ?? ex?.notes ?? null, updated_at: now,
  });
  const rec = getProvider(id);
  if (!rec) throw new Error("保存服务商失败");
  return rec;
}

export function deleteProvider(id: string): void {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id,codex_byok,claude_byok,deepseek_byok FROM cli_executor_overrides`,
  ).all() as Array<{ id: string; codex_byok: string | null; claude_byok: string | null; deepseek_byok: string | null }>;
  const hit: string[] = [];
  for (const r of rows) {
    for (const c of [r.codex_byok, r.claude_byok, r.deepseek_byok]) {
      if (!c) continue;
      try {
        const p = JSON.parse(c) as { providerId?: string };
        if (p?.providerId === id) { hit.push(r.id); break; }
      } catch { /* ignore */ }
    }
  }
  if (hit.length) throw new Error(`仍有 ${hit.length} 个 Agent 正在使用（${hit.slice(0, 3).join("、")}），请先解绑`);
  db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
}

export function setProviderEnabled(id: string, enabled: boolean): ProviderRecord {
  getDb().prepare(`UPDATE providers SET enabled=?,updated_at=? WHERE id=?`)
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
  const rec = getProvider(id);
  if (!rec) throw new Error("服务商不存在");
  return rec;
}

export function reorderProviders(ids: string[]): ProviderRecord[] {
  const db = getDb();
  const txn = db.transaction(() => {
    ids.forEach((pid, i) => {
      db.prepare(`UPDATE providers SET position=? WHERE id=?`).run((i + 1) * 10, pid);
    });
  });
  txn();
  return listProviders();
}

export function recordProviderHealth(
  id: string, h: { ok: boolean; latencyMs?: number; error?: string; models?: string[] },
): ProviderRecord | undefined {
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE providers SET last_health=?,last_latency_ms=?,last_error=?,last_checked_at=?,updated_at=? WHERE id=?`,
  ).run(h.ok ? "ok" : "error", h.latencyMs ?? null, h.error ?? null, now, now, id);
  if (h.ok && h.models?.length) {
    const cur = getProvider(id);
    if (cur && !cur.models.length) {
      getDb().prepare(`UPDATE providers SET models=? WHERE id=?`)
        .run(JSON.stringify(h.models.slice(0, 200).map((m) => ({ id: m }))), id);
    }
  }
  return getProvider(id);
}

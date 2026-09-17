import { getProvider, getProviderApiKey, recordProviderHealth } from "./providers.js";

export interface ProviderTestResult {
  ok: boolean; latencyMs: number; models?: string[]; error?: string; checkedAt: string;
}

function timeoutMs(): number {
  const v = Number(process.env.FREEBUDDY_PROVIDER_CHECK_TIMEOUT_MS || 15000);
  return Number.isFinite(v) ? Math.min(Math.max(v, 3000), 60000) : 15000;
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? m.slice(0, 300) : m;
}

/** 检查服务商连通性：GET {baseUrl}/models，Key 经 Authorization 注入，绝不打日志 */
export async function testProvider(id: string): Promise<ProviderTestResult> {
  const rec = getProvider(id);
  if (!rec) throw new Error("服务商不存在");
  const apiKey = getProviderApiKey(id);
  if (!apiKey) {
    const r = { ok: false, latencyMs: 0, error: "未填写 API Key", checkedAt: new Date().toISOString() };
    recordProviderHealth(id, r);
    return r;
  }
  const url = `${rec.baseUrl.replace(/\/+$/, "")}/models`;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    // Anthropic 原生走 x-api-key，其余走 Bearer
    const headers: Record<string, string> =
      rec.protocol === "anthropic"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${apiKey}` };
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const r = { ok: false, latencyMs, error: `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
      recordProviderHealth(id, r);
      return r;
    }
    let models: string[] | undefined;
    try {
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      if (Array.isArray(data?.data)) {
        models = data.data.map((m) => String(m?.id || "")).filter(Boolean).slice(0, 200);
      }
    } catch { /* 有些站 /models 非标准，忽略 */ }
    const r = { ok: true, latencyMs, models, checkedAt: new Date().toISOString() };
    recordProviderHealth(id, r);
    return r;
  } catch (e) {
    const r = {
      ok: false, latencyMs: Date.now() - started,
      error: (e as Error)?.name === "AbortError" ? "连接超时" : errText(e),
      checkedAt: new Date().toISOString(),
    };
    recordProviderHealth(id, r);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

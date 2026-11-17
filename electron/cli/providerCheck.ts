import { getProvider, getProviderApiKey, recordProviderHealth, type ProviderProtocol } from "./providers.js";

export interface ProviderEndpointTestResult {
  endpoint: "openai" | "anthropic";
  baseUrl: string;
  ok: boolean;
  latencyMs: number;
  models?: string[];
  error?: string;
}

export interface ProviderTestResult {
  ok: boolean; latencyMs: number; models?: string[]; error?: string; checkedAt: string;
  endpoints?: ProviderEndpointTestResult[];
}

export interface TestProviderOptions {
  id?: string;
  baseUrl: string;
  anthropicBaseUrl?: string;
  protocol?: ProviderProtocol;
  protocols?: ProviderProtocol[];
  endpoint?: "all" | "openai" | "anthropic";
  apiKey?: string;
  model?: string;
}

function timeoutMs(): number {
  const v = Number(process.env.FREEBUDDY_PROVIDER_CHECK_TIMEOUT_MS || 15000);
  return Number.isFinite(v) ? Math.min(Math.max(v, 3000), 60000) : 15000;
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? m.slice(0, 300) : m;
}

function buildAuthHeaders(protocol: ProviderProtocol, apiKey: string): Record<string, string> {
  // Anthropic 原生走 x-api-key，其余走 Bearer
  return protocol === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
}

function isAuthFailureBody(text: string): boolean {
  return /(invalid[_\s-]*(api[_\s-]*key|iam[_\s-]*token|x-api-key|token|auth)|authentication_error|unauthorized|permission[_\s-]*denied|expired[_\s-]*(api[_\s-]*key|token))/i.test(
    text,
  );
}

function isModelNotFound404Body(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as {
      detail?: unknown;
      error?: { code?: unknown; type?: unknown; message?: unknown } | string;
    };
    if (!parsed || typeof parsed !== "object" || !parsed.error) return false;
    const errStr =
      typeof parsed.error === "string"
        ? parsed.error
        : [parsed.error.code, parsed.error.type, parsed.error.message]
            .filter((v): v is string => typeof v === "string")
            .join(" ");
    return /model[_\s-]*not[_\s-]*found|unknown[_\s-]*model|does not exist|unsupported[_\s-]*model/i.test(
      errStr,
    );
  } catch {
    return false;
  }
}

async function probeMessageFallback(
  cleanUrl: string,
  protocol: ProviderProtocol,
  apiKey: string,
  signal: AbortSignal,
  probeModel?: string,
): Promise<{ ok: boolean; error?: string }> {
  const withV1 = cleanUrl.endsWith("/v1");
  let candidateUrls: string[];
  let payload: Record<string, unknown>;
  if (protocol === "anthropic") {
    candidateUrls = withV1 ? [`${cleanUrl}/messages`] : [`${cleanUrl}/v1/messages`, `${cleanUrl}/messages`];
    payload = {
      model: probeModel || "claude-sonnet-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    };
  } else if (protocol === "openai-responses") {
    candidateUrls = withV1 ? [`${cleanUrl}/responses`] : [`${cleanUrl}/v1/responses`, `${cleanUrl}/responses`];
    payload = {
      model: probeModel || "gpt-4o-mini",
      max_output_tokens: 16,
      input: "hi",
    };
  } else {
    candidateUrls = withV1
      ? [`${cleanUrl}/chat/completions`]
      : [`${cleanUrl}/v1/chat/completions`, `${cleanUrl}/chat/completions`];
    payload = {
      model: probeModel || (protocol === "deepseek" ? "deepseek-chat" : "gpt-4o-mini"),
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    };
  }

  let lastStatus = 404;
  for (const candidateUrl of candidateUrls) {
    const res = await fetch(candidateUrl, {
      method: "POST",
      headers: {
        ...buildAuthHeaders(protocol, apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });
    lastStatus = res.status;
    if (res.ok || res.status === 429) {
      await res.body?.cancel().catch(() => {});
      return { ok: true };
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `HTTP ${res.status}` };
    }
    if (res.status === 404 || res.status === 405) {
      const bodyText = res.status === 404 ? await res.text().catch(() => "") : "";
      if (res.status === 404 && isModelNotFound404Body(bodyText)) {
        return { ok: true };
      }
      continue;
    }
    if (res.status === 400 || res.status === 422) {
      const bodyText = await res.text().catch(() => "");
      if (isAuthFailureBody(bodyText)) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      return { ok: true };
    }
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: `HTTP ${res.status}` };
  }
  return { ok: false, error: `HTTP ${lastStatus}` };
}

async function probeSingleEndpoint(
  endpoint: "openai" | "anthropic",
  baseUrl: string,
  protocol: ProviderProtocol,
  apiKey: string,
  probeModel?: string,
): Promise<ProviderEndpointTestResult> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const url = `${cleanUrl}/models`;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    const headers = buildAuthHeaders(protocol, apiKey);
    let res = await fetch(url, { headers, signal: ctrl.signal });
    if (res.status === 404 && !cleanUrl.endsWith("/v1")) {
      try {
        const fallback = await fetch(`${cleanUrl}/v1/models`, { headers, signal: ctrl.signal });
        if (fallback.status !== 404) {
          await res.body?.cancel().catch(() => {});
          res = fallback;
        }
      } catch { /* ignore fallback error */ }
    }
    if (res.status === 404 || res.status === 405) {
      // Many coding-plan and Anthropic-compatible gateways only implement chat/messages endpoints and omit /models.
      await res.body?.cancel().catch(() => {});
      const fallbackResult = await probeMessageFallback(
        cleanUrl,
        protocol,
        apiKey,
        ctrl.signal,
        probeModel,
      );
      return {
        endpoint,
        baseUrl: cleanUrl,
        ok: fallbackResult.ok,
        latencyMs: Date.now() - started,
        error: fallbackResult.error,
      };
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { endpoint, baseUrl: cleanUrl, ok: false, latencyMs, error: `HTTP ${res.status}` };
    }
    let models: string[] | undefined;
    try {
      const data = (await res.json()) as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
      if (data && Array.isArray((data as { data?: Array<{ id?: string }> }).data)) {
        models = (data as { data: Array<{ id?: string }> }).data
          .map((m) => String(m?.id || "").trim())
          .filter(Boolean)
          .slice(0, 300);
      } else if (Array.isArray(data)) {
        models = data
          .map((m) => String(m?.id || "").trim())
          .filter(Boolean)
          .slice(0, 300);
      }
    } catch { /* 有些站 /models 非标准，忽略 */ }
    return { endpoint, baseUrl: cleanUrl, ok: true, latencyMs, models };
  } catch (e) {
    return {
      endpoint,
      baseUrl: cleanUrl,
      ok: false,
      latencyMs: Date.now() - started,
      error: (e as Error)?.name === "AbortError" ? "连接超时" : errText(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 检查服务商连通性：GET {baseUrl}/models，Key 经 Authorization/x-api-key 注入，绝不打日志 */
export async function testProvider(target: string | TestProviderOptions): Promise<ProviderTestResult> {
  let id: string | undefined;
  let baseUrl: string;
  let anthropicBaseUrl: string | undefined;
  let protocol: ProviderProtocol = "openai-chat";
  let protocols: ProviderProtocol[];
  let endpointMode: "all" | "openai" | "anthropic" = "all";
  let apiKey: string | undefined;
  let probeModel: string | undefined;

  if (typeof target === "string") {
    id = target;
    const rec = getProvider(id);
    if (!rec) throw new Error("服务商不存在");
    baseUrl = rec.baseUrl;
    anthropicBaseUrl = rec.anthropicBaseUrl;
    protocol = rec.protocol;
    protocols = rec.protocols?.length ? rec.protocols : [rec.protocol];
    apiKey = getProviderApiKey(id);
    probeModel = rec.models.find((m) => m.enabled !== false)?.id ?? rec.models[0]?.id;
  } else {
    id = target.id;
    baseUrl = (target.baseUrl || "").trim();
    anthropicBaseUrl = target.anthropicBaseUrl?.trim() || undefined;
    protocol = target.protocol || "openai-chat";
    protocols = target.protocols?.length ? target.protocols : [protocol];
    endpointMode = target.endpoint ?? "all";
    apiKey = target.apiKey?.trim();
    probeModel = target.model?.trim() || undefined;
    if ((!apiKey || !probeModel) && id) {
      if (!apiKey) apiKey = getProviderApiKey(id);
      if (!probeModel) {
        const rec = getProvider(id);
        probeModel = rec?.models.find((m) => m.enabled !== false)?.id ?? rec?.models[0]?.id;
      }
    }
  }

  const hasOpenAi = protocols.some((p) => p !== "anthropic");
  const hasAnthropic = protocols.includes("anthropic");
  const cleanOpenAi = baseUrl.replace(/\/+$/, "");
  const cleanAnthropic = (anthropicBaseUrl || (!hasOpenAi ? cleanOpenAi : "")).replace(/\/+$/, "");
  const openAiProtocol = protocols.find((p) => p !== "anthropic") || (protocol === "anthropic" ? "openai-chat" : protocol);

  const probes: Array<{ endpoint: "openai" | "anthropic"; url: string; protocol: ProviderProtocol }> = [];
  if (endpointMode === "openai") {
    if (cleanOpenAi) probes.push({ endpoint: "openai", url: cleanOpenAi, protocol: openAiProtocol });
  } else if (endpointMode === "anthropic") {
    const targetUrl = cleanAnthropic || cleanOpenAi;
    if (targetUrl) probes.push({ endpoint: "anthropic", url: targetUrl, protocol: "anthropic" });
  } else if (hasOpenAi && hasAnthropic && cleanAnthropic && cleanAnthropic !== cleanOpenAi) {
    if (cleanOpenAi) probes.push({ endpoint: "openai", url: cleanOpenAi, protocol: openAiProtocol });
    probes.push({ endpoint: "anthropic", url: cleanAnthropic, protocol: "anthropic" });
  } else if (!hasOpenAi && hasAnthropic) {
    const targetUrl = cleanAnthropic || cleanOpenAi;
    if (targetUrl) probes.push({ endpoint: "anthropic", url: targetUrl, protocol: "anthropic" });
  } else if (cleanOpenAi) {
    probes.push({ endpoint: "openai", url: cleanOpenAi, protocol: openAiProtocol });
  }

  const checkedAt = new Date().toISOString();
  if (!probes.length) {
    const r: ProviderTestResult = { ok: false, latencyMs: 0, error: "未填写 Base URL", checkedAt };
    if (id && endpointMode === "all") recordProviderHealth(id, r);
    return r;
  }
  if (!apiKey) {
    const r: ProviderTestResult = { ok: false, latencyMs: 0, error: "未填写 API Key", checkedAt };
    if (id && endpointMode === "all") recordProviderHealth(id, r);
    return r;
  }

  const key = apiKey;
  const results = await Promise.all(
    probes.map((p) => probeSingleEndpoint(p.endpoint, p.url, p.protocol, key, probeModel)),
  );
  const ok = results.every((x) => x.ok);
  const latencyMs = Math.max(...results.map((x) => x.latencyMs));
  const mergedModels = Array.from(
    new Set(results.flatMap((x) => x.models ?? [])),
  ).slice(0, 300);
  const models = mergedModels.length ? mergedModels : undefined;
  const error = ok
    ? undefined
    : results.length === 1
      ? results[0].error
      : results
          .filter((x) => !x.ok)
          .map((x) => `${x.endpoint === "anthropic" ? "Anthropic" : "OpenAI"}: ${x.error || "连接失败"}`)
          .join("；");

  const finalResult: ProviderTestResult = {
    ok,
    latencyMs,
    models,
    error,
    checkedAt,
    endpoints: results,
  };
  if (id && endpointMode === "all") recordProviderHealth(id, finalResult);
  return finalResult;
}

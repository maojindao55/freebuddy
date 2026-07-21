export const TOKSCALE_USAGE_CLIENTS = [
  "codex",
  "claude",
  "opencode",
  "cursor",
  "kimi",
  "codebuddy",
  "grok"
] as const;

export type TokscaleClient = (typeof TOKSCALE_USAGE_CLIENTS)[number];

export const AGENT_USAGE_PERIODS = [
  "today",
  "week",
  "month",
  "year",
  "all"
] as const;

export type AgentUsagePeriod = (typeof AGENT_USAGE_PERIODS)[number];

const AGENT_USAGE_PERIOD_SET = new Set<string>(AGENT_USAGE_PERIODS);

export function normalizeAgentUsagePeriod(value: unknown): AgentUsagePeriod {
  return typeof value === "string" && AGENT_USAGE_PERIOD_SET.has(value)
    ? value as AgentUsagePeriod
    : "all";
}

const USAGE_CLIENT_SET = new Set<string>(TOKSCALE_USAGE_CLIENTS);

const ADAPTER_CLIENTS: Record<string, TokscaleClient> = {
  codex: "codex",
  "codex-acp": "codex",
  claude: "claude",
  "claude-agent-acp": "claude",
  opencode: "opencode",
  "opencode-acp": "opencode",
  kimi: "kimi",
  "kimi-acp": "kimi",
  codebuddy: "codebuddy",
  "codebuddy-acp": "codebuddy",
  grok: "grok",
  "grok-acp": "grok"
};

/**
 * Cursor's tokscale source is account/day based and cannot currently be joined
 * to Cursor ACP session ids. It intentionally has no adapter mapping here;
 * Cursor reports are stored as an explicit unattributed bucket instead.
 * Qoder has no tokscale parser and remains unsupported.
 */
export function tokscaleClientForAdapter(
  adapter: string,
  baseAdapter?: string | null
): TokscaleClient | undefined {
  return ADAPTER_CLIENTS[baseAdapter ?? ""] ?? ADAPTER_CLIENTS[adapter];
}

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Codex sometimes exposes the UUID over ACP while tokscale falls back to the
 * rollout filename (`rollout-<timestamp>-<uuid>`). Normalize both to the UUID.
 */
export function normalizeUsageSessionKey(
  client: string,
  sessionId: string
): string {
  const trimmed = sessionId.trim();
  if (client !== "codex") return trimmed;
  const matches = [...trimmed.matchAll(UUID_PATTERN)];
  return matches.at(-1)?.[0].toLowerCase() ?? trimmed;
}

export interface TokscaleUsageEntry {
  client: TokscaleClient;
  sessionId: string;
  sessionKey: string;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  messageCount: number;
  estimatedCostUsd: number;
}

export interface TokscaleUsageReport {
  entries: TokscaleUsageEntry[];
  processingTimeMs?: number;
}

export interface TokscaleDailyUsageEntry {
  date: string;
  client: TokscaleClient;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  messageCount: number;
}

export interface TokscaleDailyUsageReport {
  entries: TokscaleDailyUsageEntry[];
}

export interface TokscaleHourlyUsageEntry {
  hour: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messageCount: number;
}

export interface TokscaleHourlyUsageReport {
  entries: TokscaleHourlyUsageEntry[];
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Keep the runner tolerant of a launcher writing a notice before the JSON.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("tokscale returned no JSON object");
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
}

export function parseTokscaleUsageReport(stdout: string): TokscaleUsageReport {
  const payload = parseJsonObject(stdout);
  if (!Array.isArray(payload.entries)) {
    throw new Error("tokscale JSON did not contain an entries array");
  }

  const entries: TokscaleUsageEntry[] = [];
  for (const raw of payload.entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const client = typeof entry.client === "string" ? entry.client.trim() : "";
    const sessionId =
      typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
    const modelId = typeof entry.model === "string" ? entry.model.trim() : "";
    if (!USAGE_CLIENT_SET.has(client) || !sessionId || !modelId) continue;

    entries.push({
      client: client as TokscaleClient,
      sessionId,
      sessionKey: normalizeUsageSessionKey(client, sessionId),
      modelId,
      providerId:
        typeof entry.provider === "string" ? entry.provider.trim() : "",
      inputTokens: nonNegativeInteger(entry.input),
      outputTokens: nonNegativeInteger(entry.output),
      cacheReadTokens: nonNegativeInteger(entry.cacheRead),
      cacheWriteTokens: nonNegativeInteger(entry.cacheWrite),
      reasoningTokens: nonNegativeInteger(entry.reasoning),
      messageCount: nonNegativeInteger(entry.messageCount),
      estimatedCostUsd: nonNegativeNumber(entry.cost)
    });
  }

  return {
    entries,
    ...(typeof payload.processingTimeMs === "number" &&
    Number.isFinite(payload.processingTimeMs)
      ? { processingTimeMs: Math.max(0, payload.processingTimeMs) }
      : {})
  };
}

export function parseTokscaleDailyUsageReport(
  stdout: string
): TokscaleDailyUsageReport {
  const payload = parseJsonObject(stdout);
  if (!Array.isArray(payload.contributions)) {
    throw new Error("tokscale graph JSON did not contain a contributions array");
  }

  const totals = new Map<string, TokscaleDailyUsageEntry>();
  for (const rawContribution of payload.contributions) {
    if (!rawContribution || typeof rawContribution !== "object") continue;
    const contribution = rawContribution as Record<string, unknown>;
    const date = typeof contribution.date === "string"
      ? contribution.date.trim()
      : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(contribution.clients)) {
      continue;
    }
    for (const rawClient of contribution.clients) {
      if (!rawClient || typeof rawClient !== "object") continue;
      const clientEntry = rawClient as Record<string, unknown>;
      const client = typeof clientEntry.client === "string"
        ? clientEntry.client.trim()
        : "";
      if (!USAGE_CLIENT_SET.has(client)) continue;
      const tokens = clientEntry.tokens && typeof clientEntry.tokens === "object"
        ? clientEntry.tokens as Record<string, unknown>
        : {};
      const key = `${date}\u0000${client}`;
      const current = totals.get(key) ?? {
        date,
        client: client as TokscaleClient,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        messageCount: 0
      };
      current.inputTokens += nonNegativeInteger(tokens.input);
      current.outputTokens += nonNegativeInteger(tokens.output);
      current.cacheReadTokens += nonNegativeInteger(tokens.cacheRead);
      current.cacheWriteTokens += nonNegativeInteger(tokens.cacheWrite);
      current.reasoningTokens += nonNegativeInteger(tokens.reasoning);
      current.messageCount += nonNegativeInteger(clientEntry.messages);
      totals.set(key, current);
    }
  }

  return {
    entries: [...totals.values()].sort((left, right) => (
      left.date.localeCompare(right.date) || left.client.localeCompare(right.client)
    ))
  };
}

export function parseTokscaleHourlyUsageReport(
  stdout: string
): TokscaleHourlyUsageReport {
  const payload = parseJsonObject(stdout);
  if (!Array.isArray(payload.entries)) {
    throw new Error("tokscale hourly JSON did not contain an entries array");
  }
  const entries: TokscaleHourlyUsageEntry[] = [];
  for (const raw of payload.entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const hour = typeof entry.hour === "string" ? entry.hour.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:00$/.test(hour)) continue;
    entries.push({
      hour,
      inputTokens: nonNegativeInteger(entry.input),
      outputTokens: nonNegativeInteger(entry.output),
      cacheReadTokens: nonNegativeInteger(entry.cacheRead),
      cacheWriteTokens: nonNegativeInteger(entry.cacheWrite),
      messageCount: nonNegativeInteger(entry.messageCount)
    });
  }
  return { entries: entries.sort((left, right) => left.hour.localeCompare(right.hour)) };
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function tokscalePeriodArgs(
  period: AgentUsagePeriod,
  now = new Date()
): string[] {
  if (period === "today") return ["--today"];
  if (period === "week") return ["--week"];
  if (period === "all") return [];
  const days = period === "month" ? 29 : 364;
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return ["--since", localDateString(since), "--until", localDateString(now)];
}

export function buildTokscaleUsageArgs(
  clients: readonly TokscaleClient[],
  period: AgentUsagePeriod = "all",
  now = new Date()
): string[] {
  const selected = [...new Set(clients)].sort();
  if (!selected.length) throw new Error("At least one tokscale client is required");
  return [
    "models",
    "--json",
    "--no-spinner",
    "--client",
    selected.join(","),
    ...tokscalePeriodArgs(period, now),
    "--group-by",
    "client,session,model"
  ];
}

export function buildTokscaleDailyUsageArgs(
  clients: readonly TokscaleClient[],
  period: AgentUsagePeriod = "all",
  now = new Date()
): string[] {
  const selected = [...new Set(clients)].sort();
  if (!selected.length) throw new Error("At least one tokscale client is required");
  return [
    "graph",
    "--client",
    selected.join(","),
    ...tokscalePeriodArgs(period, now),
    "--no-spinner"
  ];
}

export function buildTokscaleHourlyUsageArgs(
  clients: readonly TokscaleClient[]
): string[] {
  const selected = [...new Set(clients)].sort();
  if (!selected.length) throw new Error("At least one tokscale client is required");
  return [
    "hourly",
    "--json",
    "--client",
    selected.join(","),
    "--today",
    "--no-spinner"
  ];
}

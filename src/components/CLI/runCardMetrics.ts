import type { AgentRunMetrics, CliStreamItem } from "@freebuddy/protocol/cli";

type Usage = Extract<CliStreamItem, { kind: "usage" }>;
type Message = { role: string; content: string; taskId?: string };
type Live = {
  taskSessionId: string;
  items: CliStreamItem[];
  status: string;
  runMetricsReceivedAt?: number;
};

export function validMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function selectRunMetrics(
  items: readonly CliStreamItem[],
  runId?: string,
  live?: { status: string; runMetricsReceivedAt?: number }
) {
  let summary: AgentRunMetrics | undefined;
  let usage: Usage | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const item of items) {
    if (item.kind !== "usage") continue;
    if (runId && item.runId && item.runId !== runId) continue;
    if (item.runMetrics) {
      if (!runId || item.runMetrics.runId === runId) summary = item.runMetrics;
      continue;
    }
    if (item.usageScope === "turn") {
      inputTokens = validMetric(item.inputTokens) ?? inputTokens;
      outputTokens = validMetric(item.outputTokens) ?? outputTokens;
    }
    usage = { ...usage, ...item, metrics: { ...usage?.metrics, ...item.metrics } };
  }
  const running = live?.status === "starting" || live?.status === "running";
  const activeSummary = summary?.status === "preparing" || summary?.status === "running";
  const done = items.findLast(item => item.kind === "done");
  let status: AgentRunMetrics["status"] | "unknown" = "unknown";
  if (summary && !activeSummary) status = summary.status;
  else if (live?.status === "killed") status = "cancelled";
  else if (live?.status === "starting") status = summary?.status ?? "preparing";
  else if (live?.status === "running") status = summary?.status ?? "running";
  else if (activeSummary) status = "unknown";
  else if (live?.status === "failed" || items.some(item => item.kind === "error" && item.terminal)) status = "failed";
  else if (done?.kind === "done") status = (done.exitCode ?? 0) === 0 ? "done" : "failed";
  return {
    running, status, summary, usage,
    receivedAt: live?.runMetricsReceivedAt,
    firstOutputTracked: summary?.firstOutputTracked === true || !summary,
    firstOutputMs: validMetric(summary?.firstOutputLatencyMs),
    firstOutputKind: summary?.firstOutputKind,
    firstTextMs: validMetric(summary?.firstTextLatencyMs),
    reportedTtftMs: validMetric(summary?.reportedTtftMs ?? usage?.metrics?.avgTtftMs),
    tokensPerSecond: validMetric(summary?.tokensPerSecond ?? usage?.metrics?.tokensPerSecond),
    speedSource: summary?.speedSource ?? "reported",
    automaticSpeed: summary?.automaticSpeed ?? false,
    inputTokens: validMetric(summary?.inputTokens ?? inputTokens),
    outputTokens: validMetric(summary?.outputTokens ?? outputTokens)
  };
}

export type RunMetrics = ReturnType<typeof selectRunMetrics>;

/** A new live execution always wins, including before it has any usage. */
export function selectRunCardMetrics(messages: readonly Message[], live?: Live) {
  let items: CliStreamItem[] = [];
  let runId = live?.taskSessionId;
  let exists = Boolean(live);
  if (live) {
    items = live.items;
  } else {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === "user") break;
      if (message.role !== "assistant") continue;
      exists = true;
      runId = message.taskId;
      try {
        const parsed = JSON.parse(message.content);
        if (Array.isArray(parsed)) items = parsed.filter(item => item && typeof item === "object");
      } catch { /* Legacy plain text has no measured metrics. */ }
      break;
    }
  }
  return { exists, ...selectRunMetrics(items, runId, live) };
}

export type RunCardMetrics = ReturnType<typeof selectRunCardMetrics>;

export function runCardElapsedMs(
  summary: AgentRunMetrics | undefined,
  running: boolean,
  receivedAt: number | undefined,
  now: number
): number | undefined {
  if (!summary || validMetric(summary.elapsedMs) === undefined) return undefined;
  const active = summary.status === "preparing" || summary.status === "running";
  if (active && !running) return undefined;
  return summary.elapsedMs + (running && active && receivedAt !== undefined ? Math.max(0, now - receivedAt) : 0);
}

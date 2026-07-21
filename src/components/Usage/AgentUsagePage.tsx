import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  Database,
  RefreshCw,
  TriangleAlert,
  X
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentAvatar } from "@/components/CLI/AgentAvatar";
import { cliClient } from "@/services/cli/client";
import type {
  AgentModelUsage,
  AgentUsagePeriod,
  AgentUsageSummary,
  CursorUsageStatus,
  DailyTokenUsage,
  HourlyTokenUsage
} from "@/services/cli/types";

const USAGE_PERIODS: AgentUsagePeriod[] = [
  "today",
  "week",
  "month",
  "year",
  "all"
];

interface AgentRollup {
  agentId: string;
  agentName: string;
  modelCount: number;
  sessionCount: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  attribution: "agent" | "unattributed";
}

interface ModelRollup {
  key: string;
  modelId: string;
  totalTokens: number;
}

interface UsageTotals {
  input: number;
  output: number;
  cache: number;
  reasoning: number;
  messages: number;
  total: number;
}

type UsageAnalysisView = "agent" | "model" | "detail";

function rowTotal(row: AgentModelUsage): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
}

function usageAgentAdapter(agentId: string): string {
  if (agentId === "usage:cursor:unattributed") return "cursor-agent-acp";
  return agentId.startsWith("cli-") ? agentId.slice(4) : agentId;
}

function aggregateAgents(rows: AgentModelUsage[]): AgentRollup[] {
  const agents = new Map<string, AgentRollup>();
  for (const row of rows) {
    const current = agents.get(row.agentId) ?? {
      agentId: row.agentId,
      agentName: row.agentName,
      modelCount: 0,
      sessionCount: 0,
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      attribution: row.attribution
    };
    current.agentName = row.agentName;
    current.attribution = row.attribution;
    current.modelCount += 1;
    current.sessionCount += row.sessionCount;
    current.messageCount += row.messageCount;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheTokens += row.cacheReadTokens + row.cacheWriteTokens;
    current.totalTokens += rowTotal(row);
    agents.set(row.agentId, current);
  }
  return [...agents.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function aggregateModels(rows: AgentModelUsage[]): ModelRollup[] {
  const models = new Map<string, ModelRollup>();
  for (const row of rows) {
    const key = row.modelId;
    const current = models.get(key) ?? {
      key,
      modelId: row.modelId,
      totalTokens: 0
    };
    current.totalTokens += rowTotal(row);
    models.set(key, current);
  }
  return [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function sumUsageRows(rows: AgentModelUsage[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (result, row) => {
      result.input += row.inputTokens;
      result.output += row.outputTokens;
      result.cache += row.cacheReadTokens + row.cacheWriteTokens;
      result.reasoning += row.reasoningTokens;
      result.messages += row.messageCount;
      result.total += rowTotal(row);
      return result;
    },
    { input: 0, output: 0, cache: 0, reasoning: 0, messages: 0, total: 0 }
  );
}

function formatTokens(value: number, locale: string): string {
  if (value < 1_000) return new Intl.NumberFormat(locale).format(value);
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: value < 100_000 ? 1 : 0
  }).format(value);
}

function formatExact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatTime(value: string | undefined, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

type UsageTrendGranularity = "hour" | "day" | "month";

interface UsageTrendPoint {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messageCount: number;
  totalTokens: number;
}

function emptyTrendPoint(key: string): UsageTrendPoint {
  return {
    key,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messageCount: 0,
    totalTokens: 0
  };
}

function dailyTrendPoint(row: DailyTokenUsage): UsageTrendPoint {
  return {
    key: row.date,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    messageCount: row.messageCount,
    totalTokens: row.totalTokens
  };
}

function completeDailyTrend(
  rows: DailyTokenUsage[],
  days: number,
  now = new Date()
): UsageTrendPoint[] {
  if (!rows.length) return [];
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1);
  const result: UsageTrendPoint[] = [];
  for (
    let date = first;
    date.getTime() <= today.getTime();
    date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
  ) {
    const key = localDateKey(date);
    const row = byDate.get(key);
    result.push(row ? dailyTrendPoint(row) : emptyTrendPoint(key));
  }
  return result;
}

function completeHourlyTrend(
  rows: HourlyTokenUsage[],
  now = new Date()
): UsageTrendPoint[] {
  if (!rows.length) return [];
  const date = localDateKey(now);
  const currentRows = rows.filter((row) => row.hour.startsWith(`${date} `));
  if (!currentRows.length) return [];
  const byHour = new Map(currentRows.map((row) => [row.hour, row]));
  return Array.from({ length: 24 }, (_, hour) => {
    const key = `${date} ${String(hour).padStart(2, "0")}:00`;
    const row = byHour.get(key);
    return row
      ? {
          key,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          messageCount: row.messageCount,
          totalTokens: row.totalTokens
        }
      : emptyTrendPoint(key);
  });
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function aggregateMonthlyTrend(
  rows: DailyTokenUsage[],
  period: "year" | "all",
  now = new Date()
): UsageTrendPoint[] {
  if (!rows.length) return [];
  const monthly = new Map<string, UsageTrendPoint>();
  for (const row of rows) {
    const key = row.date.slice(0, 7);
    const point = monthly.get(key) ?? emptyTrendPoint(key);
    point.inputTokens += row.inputTokens;
    point.outputTokens += row.outputTokens;
    point.cacheReadTokens += row.cacheReadTokens;
    point.cacheWriteTokens += row.cacheWriteTokens;
    point.messageCount += row.messageCount;
    point.totalTokens += row.totalTokens;
    monthly.set(key, point);
  }
  const current = new Date(now.getFullYear(), now.getMonth(), 1);
  const first = period === "year"
    ? new Date(current.getFullYear(), current.getMonth() - 11, 1)
    : new Date(parseLocalDate(`${rows[0].date.slice(0, 7)}-01`));
  const points: UsageTrendPoint[] = [];
  for (
    let date = first;
    date.getTime() <= current.getTime();
    date = new Date(date.getFullYear(), date.getMonth() + 1, 1)
  ) {
    const key = monthKey(date);
    points.push(monthly.get(key) ?? emptyTrendPoint(key));
  }
  return points;
}

function buildUsageTrend(
  summary: AgentUsageSummary,
  period: AgentUsagePeriod
): { granularity: UsageTrendGranularity; points: UsageTrendPoint[] } {
  if (period === "today") {
    return { granularity: "hour", points: completeHourlyTrend(summary.hourlyTrend) };
  }
  if (period === "week" || period === "month") {
    return {
      granularity: "day",
      points: completeDailyTrend(summary.dailyTrend, period === "week" ? 7 : 30)
    };
  }
  return {
    granularity: "month",
    points: aggregateMonthlyTrend(summary.dailyTrend, period)
  };
}

function usageTrendGranularity(period: AgentUsagePeriod): UsageTrendGranularity {
  if (period === "today") return "hour";
  if (period === "week" || period === "month") return "day";
  return "month";
}

function UsageTrend({
  points,
  granularity,
  locale
}: {
  points: UsageTrendPoint[];
  granularity: UsageTrendGranularity;
  locale: string;
}) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(Math.max(0, points.length - 1));

  useEffect(() => {
    setActiveIndex(Math.max(0, points.length - 1));
  }, [points]);

  if (!points.length) {
    return (
      <section className="usage-panel usage-trend-panel" aria-labelledby="usage-trend-heading">
        <div className="usage-panel-heading">
          <div>
            <div className="usage-trend-title-row">
              <h3 id="usage-trend-heading">{t("usage.tokenTrend")}</h3>
              <span>{t(`usage.trendGranularity.${granularity}`)}</span>
            </div>
            <p>{t("usage.tokenTrendHint")}</p>
          </div>
        </div>
        <div className="usage-trend-empty">{t("usage.tokenTrendEmpty")}</div>
      </section>
    );
  }

  const maximum = Math.max(...points.map((point) => point.totalTokens), 1);
  const total = points.reduce((sum, point) => sum + point.totalTokens, 0);
  const average = Math.round(total / points.length);
  const peak = points.reduce((current, point) => (
    point.totalTokens > current.totalTokens ? point : current
  ));
  const activePoint = points[Math.min(activeIndex, points.length - 1)];
  const labelStep = granularity === "hour"
    ? 3
    : granularity === "day"
      ? points.length <= 7 ? 1 : 3
      : points.length <= 12 ? 1 : Math.ceil(points.length / 12);
  const barWidth = granularity === "hour"
    ? "calc(100% - 12px)"
    : granularity === "day"
      ? points.length <= 7 ? "min(56%, 72px)" : "calc(100% - 8px)"
      : "calc(100% - 12px)";
  const cacheTokens = activePoint.cacheReadTokens + activePoint.cacheWriteTokens;
  const formatBucket = (value: string, compact = false) => {
    if (granularity === "hour") return value.slice(11, 16);
    return new Intl.DateTimeFormat(locale, granularity === "month"
      ? compact ? { month: "short" } : { year: "numeric", month: "short" }
      : compact ? { month: "numeric", day: "numeric" } : { month: "short", day: "numeric" }
    ).format(parseLocalDate(granularity === "month" ? `${value}-01` : value));
  };
  const handleChartKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next = activeIndex;
    if (event.key === "ArrowLeft") next = Math.max(0, activeIndex - 1);
    else if (event.key === "ArrowRight") next = Math.min(points.length - 1, activeIndex + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = points.length - 1;
    else return;
    event.preventDefault();
    setActiveIndex(next);
  };

  return (
    <section className="usage-panel usage-trend-panel" aria-labelledby="usage-trend-heading">
      <div className="usage-panel-heading usage-trend-heading">
        <div>
          <div className="usage-trend-title-row">
            <h3 id="usage-trend-heading">{t("usage.tokenTrend")}</h3>
            <span>{t(`usage.trendGranularity.${granularity}`)}</span>
          </div>
          <p>{t("usage.tokenTrendHint")}</p>
        </div>
        <div className="usage-trend-summary">
          <span>
            {t(`usage.trendAverage.${granularity}`)}
            <strong title={formatExact(average, locale)}>{formatTokens(average, locale)}</strong>
          </span>
          <span>
            {t(`usage.trendPeak.${granularity}`)}
            <strong title={formatExact(peak.totalTokens, locale)}>
              {formatTokens(peak.totalTokens, locale)}
            </strong>
          </span>
        </div>
      </div>
      <div className="usage-trend-active-detail" aria-live="polite">
        <strong>{formatBucket(activePoint.key)}</strong>
        <span>{t("usage.trendTotal")}</span>
        <b>{formatTokens(activePoint.totalTokens, locale)}</b>
        <span>{t("usage.inputShort")} {formatTokens(activePoint.inputTokens, locale)}</span>
        <span>{t("usage.outputShort")} {formatTokens(activePoint.outputTokens, locale)}</span>
        <span>{t("usage.cacheShort")} {formatTokens(cacheTokens, locale)}</span>
      </div>
      <div className="usage-trend-chart-shell">
        <div className="usage-trend-y-axis" aria-hidden="true">
          <span>{formatTokens(maximum, locale)}</span>
          <span>{formatTokens(Math.round(maximum / 2), locale)}</span>
          <span>0</span>
        </div>
        <div className="usage-trend-scroll">
          <div
            className="usage-trend-chart"
            role="img"
            tabIndex={0}
            aria-label={t("usage.tokenTrendAriaLabel", {
              bucket: formatBucket(activePoint.key),
              total: formatExact(activePoint.totalTokens, locale),
              input: formatExact(activePoint.inputTokens, locale),
              output: formatExact(activePoint.outputTokens, locale),
              cache: formatExact(cacheTokens, locale)
            })}
            onKeyDown={handleChartKeyDown}
          >
            <div className="usage-trend-grid" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div
              className="usage-trend-bars"
              aria-hidden="true"
              style={{
                gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))`,
                "--usage-trend-bar-width": barWidth
              } as CSSProperties}
            >
              {points.map((point, index) => {
                const showLabel = index === 0
                  || index === points.length - 1
                  || index % labelStep === 0;
                const height = point.totalTokens > 0
                  ? Math.max(2, (point.totalTokens / maximum) * 100)
                  : 0;
                return (
                  <div
                    className={`usage-trend-column${index === activeIndex ? " active" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    title={`${formatBucket(point.key)} · ${formatExact(point.totalTokens, locale)} Token`}
                    key={point.key}
                  >
                    <span
                      className="usage-trend-bar"
                      style={{ "--usage-trend-height": `${height}%` } as CSSProperties}
                    />
                    <time dateTime={point.key}>
                      {showLabel ? formatBucket(point.key, true) : ""}
                    </time>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function AgentUsagePage() {
  const { t, i18n } = useTranslation();
  const [summary, setSummary] = useState<AgentUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [analysisView, setAnalysisView] = useState<UsageAnalysisView>("agent");
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedModelKey, setSelectedModelKey] = useState<string>();
  const [period, setPeriod] = useState<AgentUsagePeriod>("today");
  const [cursorStatus, setCursorStatus] = useState<CursorUsageStatus>();
  const [cursorSetupOpen, setCursorSetupOpen] = useState(false);
  const [cursorToken, setCursorToken] = useState("");
  const [cursorTokenHelpOpen, setCursorTokenHelpOpen] = useState(false);
  const [cursorAccountName, setCursorAccountName] = useState("");
  const [cursorAction, setCursorAction] = useState<"connect" | "disconnect">();
  const [cursorError, setCursorError] = useState<string>();
  const requestSequence = useRef(0);
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const displayAgentName = (agent: Pick<AgentRollup, "agentName" | "attribution">) =>
    agent.attribution === "unattributed"
      ? t("usage.cursorUnattributed")
      : agent.agentName;

  const refreshPeriod = async (
    targetPeriod: AgentUsagePeriod,
    requestId: number
  ) => {
    setRefreshing(true);
    try {
      const fresh = await cliClient.refreshUsage(targetPeriod);
      if (requestSequence.current !== requestId) return;
      setSummary(fresh);
      setError(undefined);
    } catch (refreshError) {
      if (requestSequence.current !== requestId) return;
      setError(
        refreshError instanceof Error ? refreshError.message : String(refreshError)
      );
      try {
        const cached = await cliClient.usageSummary(targetPeriod);
        if (requestSequence.current === requestId) setSummary(cached);
      } catch {
        // Keep the previous summary visible when both refresh and fallback fail.
      }
    } finally {
      if (requestSequence.current === requestId) setRefreshing(false);
    }
  };

  const load = async (targetPeriod: AgentUsagePeriod, refreshAfter = true) => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setRefreshing(false);
    setSummary(null);
    setError(undefined);
    setSelectedAgentId(undefined);
    setSelectedModelKey(undefined);
    if (!cliClient.isAvailable()) {
      setError(t("usage.bridgeUnavailable"));
      setLoading(false);
      return;
    }
    try {
      const cached = await cliClient.usageSummary(targetPeriod);
      if (requestSequence.current !== requestId) return;
      setSummary(cached);
      setLoading(false);
      if (refreshAfter) await refreshPeriod(targetPeriod, requestId);
    } catch (loadError) {
      if (requestSequence.current !== requestId) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestSequence.current === requestId) setLoading(false);
    }
  };

  useEffect(() => {
    void load(period);
  }, [period]);

  useEffect(() => {
    if (!cliClient.isAvailable()) return;
    let active = true;
    void cliClient.cursorUsageStatus()
      .then((status) => {
        if (active) setCursorStatus(status);
      })
      .catch(() => {
        if (active) setCursorStatus({ connected: false, accounts: [] });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!cursorTokenHelpOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCursorTokenHelpOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cursorTokenHelpOpen]);

  useEffect(() => {
    if (summary?.scan?.status !== "running") return;
    let canceled = false;
    const timer = window.setInterval(() => {
      void cliClient.usageSummary(period).then((next) => {
        if (!canceled) setSummary(next);
      }).catch(() => undefined);
    }, 1_500);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [period, summary?.scan?.status]);

  const refresh = async () => {
    if (!cliClient.isAvailable() || refreshing) return;
    const requestId = ++requestSequence.current;
    setError(undefined);
    await refreshPeriod(period, requestId);
  };

  const connectCursor = async () => {
    if (!cursorToken.trim()) {
      setCursorError(t("usage.cursorErrors.tokenRequired"));
      return;
    }
    setCursorAction("connect");
    setCursorError(undefined);
    try {
      const status = await cliClient.connectCursorUsage({
        token: cursorToken,
        accountName: cursorAccountName.trim() || undefined
      });
      setCursorStatus(status);
      setCursorToken("");
      setCursorTokenHelpOpen(false);
      setCursorAccountName("");
      setCursorSetupOpen(false);
      await refresh();
    } catch (connectError) {
      const message = String(connectError);
      setCursorError(
        message.includes("cursor_usage_invalid_account_name")
          ? t("usage.cursorErrors.invalidAccountName")
          : message.includes("cursor_usage_invalid_token")
            ? t("usage.cursorErrors.invalidToken")
            : t("usage.cursorErrors.loginFailed")
      );
    } finally {
      setCursorAction(undefined);
    }
  };

  const disconnectCursor = async () => {
    if (!window.confirm(t("usage.cursorDisconnectConfirm"))) return;
    setCursorAction("disconnect");
    setCursorError(undefined);
    try {
      const status = await cliClient.disconnectCursorUsage();
      setCursorStatus(status);
      setCursorSetupOpen(false);
      await load(period, false);
    } catch {
      setCursorError(t("usage.cursorErrors.logoutFailed"));
    } finally {
      setCursorAction(undefined);
    }
  };

  const allRows = summary?.byAgentModel ?? [];
  const allAgents = useMemo(
    () => aggregateAgents(summary?.byAgentModel ?? []),
    [summary?.byAgentModel]
  );
  const allModels = useMemo(
    () => aggregateModels(summary?.byAgentModel ?? []),
    [summary?.byAgentModel]
  );
  const agentViewRows = useMemo(
    () => allRows.filter((row) => (
      !selectedModelKey
      || row.modelId === selectedModelKey
    )),
    [allRows, selectedModelKey]
  );
  const visibleAgents = useMemo(
    () => aggregateAgents(agentViewRows),
    [agentViewRows]
  );
  const modelViewRows = useMemo(
    () => allRows.filter((row) => !selectedAgentId || row.agentId === selectedAgentId),
    [allRows, selectedAgentId]
  );
  const visibleModels = useMemo(
    () => aggregateModels(modelViewRows),
    [modelViewRows]
  );
  const filteredRows = useMemo(() => {
    return allRows
      .filter((row) => (
        (!selectedAgentId || row.agentId === selectedAgentId)
        && (!selectedModelKey
          || row.modelId === selectedModelKey)
      ))
      .sort((a, b) => rowTotal(b) - rowTotal(a));
  }, [allRows, selectedAgentId, selectedModelKey]);
  const totals = useMemo(() => sumUsageRows(allRows), [allRows]);
  const usageTrend = useMemo(
    () => summary
      ? buildUsageTrend(summary, period)
      : { granularity: usageTrendGranularity(period), points: [] },
    [period, summary]
  );
  const agentViewTotals = useMemo(() => sumUsageRows(agentViewRows), [agentViewRows]);
  const modelViewTotal = useMemo(
    () => visibleModels.reduce((total, model) => total + model.totalTokens, 0),
    [visibleModels]
  );
  const coverage = summary?.linkedSessionCount
    ? Math.round((summary.attributedSessionCount / summary.linkedSessionCount) * 100)
    : 0;
  const hasUsage = Boolean(summary?.byAgentModel.length);
  const hasCursorGap = summary?.coverageGaps.some(
    (gap) => gap.reason === "session_attribution_unavailable"
  );
  const hasCursorUsage = allRows.some((row) => row.attribution === "unattributed");
  const scanRunning = refreshing || summary?.scan?.status === "running";
  const selectedAgent = selectedAgentId
    ? allAgents.find((agent) => agent.agentId === selectedAgentId)
    : undefined;
  const selectedAgentName = selectedAgent ? displayAgentName(selectedAgent) : undefined;
  const attributedAgentCount = allAgents.filter(
    (agent) => agent.attribution === "agent"
  ).length;
  const selectedModel = selectedModelKey
    ? allModels.find((model) => model.key === selectedModelKey)
    : undefined;

  useEffect(() => {
    if (selectedAgentId && !allAgents.some((agent) => agent.agentId === selectedAgentId)) {
      setSelectedAgentId(undefined);
    }
  }, [allAgents, selectedAgentId]);

  useEffect(() => {
    if (selectedModelKey && !allModels.some((model) => model.key === selectedModelKey)) {
      setSelectedModelKey(undefined);
    }
  }, [allModels, selectedModelKey]);

  if (loading) {
    return (
      <div className="usage-page" aria-busy="true" aria-label={t("usage.loading")}>
        <div className="usage-page-header usage-skeleton-header" />
        <div className="usage-metric-grid">
          {[0, 1, 2, 3].map((item) => (
            <div className="usage-metric-card usage-skeleton-block" key={item} />
          ))}
        </div>
        <div className="usage-skeleton-panel usage-skeleton-block" />
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="usage-page usage-page-centered">
        <div className="usage-empty-state" role="alert">
          <span className="usage-state-icon error" aria-hidden="true">
            <CircleAlert />
          </span>
          <h2>{t("usage.loadFailed")}</h2>
          <p>{error ?? t("usage.loadFailedHint")}</p>
          <button type="button" className="usage-primary-button" onClick={() => void load(period)}>
            {t("usage.retry")}
          </button>
        </div>
      </div>
    );
  }

  const coveragePanel = (
    <section className="usage-panel usage-coverage-panel" aria-labelledby="usage-coverage-heading">
      <div className="usage-panel-heading">
        <div>
          <h3 id="usage-coverage-heading">{t("usage.coverage")}</h3>
          <p>{t("usage.coverageHint")}</p>
        </div>
        <span className={`usage-coverage-score${coverage < 100 ? " partial" : ""}`}>
          {t("usage.coveragePercent", { percent: coverage })}
        </span>
      </div>
      <div className="usage-coverage-grid">
        <div>
          <span>{t("usage.linkedSessions")}</span>
          <strong>{formatExact(summary.linkedSessionCount, locale)}</strong>
        </div>
        <div>
          <span>{t("usage.attributed")}</span>
          <strong>{formatExact(summary.attributedSessionCount, locale)}</strong>
        </div>
        <div>
          <span>{t("usage.ambiguous")}</span>
          <strong>{formatExact(summary.ambiguousSessionCount, locale)}</strong>
        </div>
      </div>
      {(summary.coverageGaps.length > 0 || summary.ambiguousSessionCount > 0) && (
        <div className="usage-coverage-gaps">
          <div className="usage-gap-heading">
            <TriangleAlert aria-hidden="true" />
            <span>{t("usage.unattributedDetails")}</span>
          </div>
          <ul>
            {summary.coverageGaps.map((gap) => (
              <li key={`${gap.adapter}:${gap.reason}`}>
                <strong>{gap.adapter}</strong>
                <span>
                  {t(`usage.coverageReasons.${gap.reason}`, {
                    count: gap.sessionCount
                  })}
                </span>
              </li>
            ))}
            {summary.ambiguousSessionCount > 0 && (
              <li>
                <strong>{t("usage.ambiguousLabel")}</strong>
                <span>
                  {t("usage.ambiguousHint", { count: summary.ambiguousSessionCount })}
                </span>
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );

  return (
    <div className="usage-page">
      <div className="usage-page-header">
        <div>
          <h2>{t("usage.title")}</h2>
          <p>{t("usage.description")}</p>
        </div>
        <div className="usage-refresh-area">
          <span className={`usage-scan-status ${summary.scan?.status ?? "idle"}`}>
            {scanRunning ? (
              <RefreshCw className="spin" aria-hidden="true" />
            ) : summary.scan?.status === "error" ? (
              <CircleAlert aria-hidden="true" />
            ) : (
              <CheckCircle2 aria-hidden="true" />
            )}
            <span>
              {scanRunning
                ? t("usage.scanning")
                : summary.scan?.status === "error"
                  ? t("usage.scanFailed")
                  : t("usage.updatedAt", {
                      time: formatTime(summary.scan?.completedAt, locale)
                    })}
            </span>
          </span>
          <button
            type="button"
            className="usage-refresh-button"
            disabled={scanRunning}
            onClick={() => void refresh()}
          >
            <RefreshCw className={scanRunning ? "spin" : ""} aria-hidden="true" />
            {t("usage.refresh")}
          </button>
        </div>
      </div>

      <div className="usage-period-picker" role="group" aria-label={t("usage.period.label")}>
        {USAGE_PERIODS.map((value) => (
          <button
            type="button"
            className={period === value ? "active" : ""}
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
            key={value}
          >
            {t(`usage.period.${value}`)}
          </button>
        ))}
      </div>

      {(error || summary.scan?.status === "error") && (
        <div className="usage-alert error" role="alert">
          <CircleAlert aria-hidden="true" />
          <div>
            <strong>{t("usage.refreshFailed")}</strong>
            <span>{error ?? summary.scan?.error ?? t("usage.refreshFailedHint")}</span>
          </div>
        </div>
      )}

      <div className="usage-metric-grid">
        <article className="usage-metric-card primary">
          <span className="usage-metric-label">{t("usage.totalTokens")}</span>
          <strong title={formatExact(totals.total, locale)}>
            {formatTokens(totals.total, locale)}
          </strong>
          <small>{t("usage.totalTokensHint")}</small>
        </article>
        <article className="usage-metric-card">
          <span className="usage-metric-label">{t("usage.inputTokens")}</span>
          <strong title={formatExact(totals.input, locale)}>
            {formatTokens(totals.input, locale)}
          </strong>
          <small>{t("usage.messages", { count: formatExact(totals.messages, locale) })}</small>
        </article>
        <article className="usage-metric-card">
          <span className="usage-metric-label">{t("usage.outputTokens")}</span>
          <strong title={formatExact(totals.output, locale)}>
            {formatTokens(totals.output, locale)}
          </strong>
          <small>{t("usage.reasoningTokens", { count: formatTokens(totals.reasoning, locale) })}</small>
        </article>
        <article className="usage-metric-card">
          <span className="usage-metric-label">{t("usage.attributedSessions")}</span>
          <strong>{formatExact(summary.usageSessionCount, locale)}</strong>
          <small>
            {t("usage.agentModelCount", {
              agents: attributedAgentCount,
              models: allModels.length
            })}
          </small>
        </article>
      </div>

      <UsageTrend
        points={usageTrend.points}
        granularity={usageTrend.granularity}
        locale={locale}
      />

      {!hasUsage ? (
        <section className="usage-empty-state usage-empty-inline">
          <span className="usage-state-icon" aria-hidden="true">
            <Database />
          </span>
          <h3>{t("usage.emptyTitle")}</h3>
          <p>
            {summary.linkedSessionCount > 0
              ? t("usage.emptyLinkedHint")
              : t("usage.emptyHint")}
          </p>
          <button
            type="button"
            className="usage-primary-button"
            disabled={scanRunning}
            onClick={() => void refresh()}
          >
            <RefreshCw className={scanRunning ? "spin" : ""} aria-hidden="true" />
            {scanRunning ? t("usage.scanning") : t("usage.scanNow")}
          </button>
        </section>
      ) : (
        <>
          <div
            className="usage-analysis-tabs"
            role="tablist"
            aria-label={t("usage.analysisViewLabel")}
          >
            {([
              { key: "agent", count: allAgents.length },
              { key: "model", count: allModels.length },
              { key: "detail", count: allRows.length }
            ] as const).map((view) => (
              <button
                type="button"
                role="tab"
                id={`usage-${view.key}-tab`}
                aria-controls={`usage-${view.key}-panel`}
                aria-selected={analysisView === view.key}
                className={analysisView === view.key ? "active" : ""}
                onClick={() => setAnalysisView(view.key)}
                key={view.key}
              >
                <span>{t(`usage.analysisViews.${view.key}`)}</span>
                <b>{formatExact(view.count, locale)}</b>
              </button>
            ))}
          </div>

          {(selectedAgent || selectedModel) && (
            <div className="usage-analysis-filters" aria-label={t("usage.activeFilters")}>
              <span className="usage-analysis-filter-label">{t("usage.activeFilters")}</span>
              {selectedAgent && (
                <button
                  type="button"
                  className="usage-filter-chip usage-filter-chip-model"
                  aria-label={t("usage.clearAgentFilter", {
                    agent: displayAgentName(selectedAgent)
                  })}
                  onClick={() => setSelectedAgentId(undefined)}
                >
                  <AgentAvatar
                    agentId={selectedAgent.agentId}
                    adapter={usageAgentAdapter(selectedAgent.agentId)}
                    className="usage-filter-chip-avatar"
                    fallback={<Bot aria-hidden="true" />}
                  />
                  <span>{displayAgentName(selectedAgent)}</span>
                  <X aria-hidden="true" />
                </button>
              )}
              {selectedModel && (
                <button
                  type="button"
                  className="usage-filter-chip"
                  aria-label={t("usage.clearModelFilter", {
                    model: selectedModel.modelId
                  })}
                  onClick={() => setSelectedModelKey(undefined)}
                >
                  <span>{selectedModel.modelId}</span>
                  <X aria-hidden="true" />
                </button>
              )}
              {selectedAgent && selectedModel && (
                <button
                  type="button"
                  className="usage-clear-filter"
                  onClick={() => {
                    setSelectedAgentId(undefined);
                    setSelectedModelKey(undefined);
                  }}
                >
                  {t("usage.clearAllFilters")}
                </button>
              )}
            </div>
          )}

          {analysisView === "agent" && (
            <div
              id="usage-agent-panel"
              role="tabpanel"
              aria-labelledby="usage-agent-tab"
              className="usage-overview-grid"
            >
              <section className="usage-panel" aria-labelledby="usage-agent-heading">
                <div className="usage-panel-heading">
                  <div>
                    <h3 id="usage-agent-heading">{t("usage.byAgent")}</h3>
                    <p>
                      {selectedModel
                        ? t("usage.byAgentFilteredHint", { model: selectedModel.modelId })
                        : t("usage.byAgentHint")}
                    </p>
                  </div>
                </div>
                <div className="usage-agent-list">
                  {visibleAgents.map((agent) => (
                    <button
                      type="button"
                      className={`usage-agent-row${selectedAgentId === agent.agentId ? " selected" : ""}`}
                      aria-pressed={selectedAgentId === agent.agentId}
                      onClick={() =>
                        setSelectedAgentId((current) =>
                          current === agent.agentId ? undefined : agent.agentId
                        )
                      }
                      key={agent.agentId}
                    >
                      <AgentAvatar
                        agentId={agent.agentId}
                        adapter={usageAgentAdapter(agent.agentId)}
                        className="usage-agent-icon"
                        fallback={<Bot aria-hidden="true" />}
                      />
                      <span className="usage-agent-copy">
                        <span className="usage-agent-line">
                          <strong>{displayAgentName(agent)}</strong>
                          <b title={formatExact(agent.totalTokens, locale)}>
                            {formatTokens(agent.totalTokens, locale)} / {agentViewTotals.total
                              ? Math.round((agent.totalTokens / agentViewTotals.total) * 100)
                              : 0}%
                          </b>
                        </span>
                        <span className="usage-agent-meta">
                          {agent.attribution === "unattributed"
                            ? t("usage.cursorUnattributedMeta")
                            : t("usage.agentMeta", {
                                models: agent.modelCount,
                                sessions: agent.sessionCount,
                                messages: agent.messageCount
                              })}
                        </span>
                        <progress
                          max={Math.max(agentViewTotals.total, 1)}
                          value={agent.totalTokens}
                          aria-label={t("usage.agentShare", {
                            agent: displayAgentName(agent)
                          })}
                        />
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <div className="usage-overview-side">
                <section className="usage-panel" aria-labelledby="usage-composition-heading">
                  <div className="usage-panel-heading">
                    <div>
                      <h3 id="usage-composition-heading">{t("usage.tokenComposition")}</h3>
                      <p>{t("usage.tokenCompositionHint")}</p>
                    </div>
                  </div>
                  <div className="usage-composition-list">
                    {[
                      { key: "input", label: t("usage.inputTokens"), value: agentViewTotals.input },
                      { key: "output", label: t("usage.outputTokens"), value: agentViewTotals.output },
                      { key: "cache", label: t("usage.cacheTokens"), value: agentViewTotals.cache }
                    ].map((item) => {
                      const percent = agentViewTotals.total
                        ? Math.round((item.value / agentViewTotals.total) * 100)
                        : 0;
                      return (
                        <div className={`usage-composition-row ${item.key}`} key={item.key}>
                          <div>
                            <span>{item.label}</span>
                            <strong title={formatExact(item.value, locale)}>
                              {formatTokens(item.value, locale)}
                            </strong>
                          </div>
                          <progress
                            max={Math.max(agentViewTotals.total, 1)}
                            value={item.value}
                            aria-label={`${item.label} ${percent}%`}
                          />
                          <small>{percent}%</small>
                        </div>
                      );
                    })}
                  </div>
                </section>
                {coveragePanel}
              </div>
            </div>
          )}

          {analysisView === "model" && (
            <section
              id="usage-model-panel"
              role="tabpanel"
              aria-labelledby="usage-model-tab"
              className="usage-panel usage-model-rollup-panel"
            >
              <div className="usage-panel-heading">
                <div>
                  <h3 id="usage-model-rollup-heading">{t("usage.byModel")}</h3>
                  <p>
                    {selectedAgentName
                      ? t("usage.byModelFilteredHint", { agent: selectedAgentName })
                      : t("usage.byModelHint")}
                  </p>
                </div>
                <span className="usage-row-count">
                  {t("usage.rowCount", { count: visibleModels.length })}
                </span>
              </div>
              <div className="usage-model-rollup-list">
                {visibleModels.map((model) => (
                  <button
                    type="button"
                    className={`usage-model-rollup-row${selectedModelKey === model.key ? " selected" : ""}`}
                    aria-pressed={selectedModelKey === model.key}
                    onClick={() => setSelectedModelKey((current) => (
                      current === model.key ? undefined : model.key
                    ))}
                    key={model.key}
                  >
                    <span className="usage-model-rollup-line">
                      <strong title={model.modelId}>{model.modelId}</strong>
                      <b title={formatExact(model.totalTokens, locale)}>
                        {formatTokens(model.totalTokens, locale)} / {modelViewTotal
                          ? Math.round((model.totalTokens / modelViewTotal) * 100)
                          : 0}%
                      </b>
                    </span>
                    <progress
                      max={Math.max(modelViewTotal, 1)}
                      value={model.totalTokens}
                      aria-label={t("usage.modelShare", { model: model.modelId })}
                    />
                  </button>
                ))}
              </div>
            </section>
          )}

          {analysisView === "detail" && (
            <section
              id="usage-detail-panel"
              role="tabpanel"
              aria-labelledby="usage-detail-tab"
              className="usage-panel usage-model-panel"
            >
              <div className="usage-panel-heading">
                <div>
                  <h3 id="usage-detail-heading">{t("usage.crossDetail")}</h3>
                  <p>
                    {selectedAgent && selectedModel
                      ? t("usage.filteredByAgentAndModel", {
                          agent: displayAgentName(selectedAgent),
                          model: selectedModel.modelId
                        })
                      : selectedAgentName
                        ? t("usage.filteredByAgent", { agent: selectedAgentName })
                        : selectedModel
                          ? t("usage.filteredByModel", { model: selectedModel.modelId })
                          : t("usage.crossDetailHint")}
                  </p>
                </div>
                <span className="usage-row-count">
                  {t("usage.rowCount", { count: filteredRows.length })}
                </span>
              </div>
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t("usage.agent")}</th>
                      <th>{t("usage.model")}</th>
                      <th>{t("usage.provider")}</th>
                      <th className="numeric">{t("usage.sessions")}</th>
                      <th className="numeric">{t("usage.input")}</th>
                      <th className="numeric">{t("usage.output")}</th>
                      <th className="numeric">{t("usage.cache")}</th>
                      <th className="numeric">{t("usage.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row) => (
                      <tr key={`${row.agentId}:${row.providerId}:${row.modelId}`}>
                        <td>
                          <span className="usage-table-agent">
                            <AgentAvatar
                              agentId={row.agentId}
                              adapter={usageAgentAdapter(row.agentId)}
                              className="usage-table-agent-avatar"
                              fallback={<Bot aria-hidden="true" />}
                            />
                            {row.attribution === "unattributed"
                              ? t("usage.cursorUnattributed")
                              : row.agentName}
                          </span>
                        </td>
                        <td>
                          <span className="usage-table-model">
                            {row.modelId}
                          </span>
                        </td>
                        <td><span className="usage-provider-pill">{row.providerId}</span></td>
                        <td className="numeric">{formatExact(row.sessionCount, locale)}</td>
                        <td className="numeric" title={formatExact(row.inputTokens, locale)}>
                          {formatTokens(row.inputTokens, locale)}
                        </td>
                        <td className="numeric" title={formatExact(row.outputTokens, locale)}>
                          {formatTokens(row.outputTokens, locale)}
                        </td>
                        <td className="numeric" title={formatExact(row.cacheReadTokens + row.cacheWriteTokens, locale)}>
                          {formatTokens(row.cacheReadTokens + row.cacheWriteTokens, locale)}
                        </td>
                        <td className="numeric total" title={formatExact(rowTotal(row), locale)}>
                          {formatTokens(rowTotal(row), locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {!hasUsage && coveragePanel}

      <p className="usage-method-note">
        <Database aria-hidden="true" />
        {t("usage.methodNote")}
      </p>
      <section className="usage-cursor-connect" aria-labelledby="usage-cursor-connect-heading">
        <div className="usage-cursor-connect-header">
          <AgentAvatar
            adapter="cursor-agent-acp"
            className="usage-cursor-connect-avatar"
            fallback={<Bot aria-hidden="true" />}
          />
          <div>
            <h3 id="usage-cursor-connect-heading">{t("usage.cursorUsageTitle")}</h3>
            <p>
              {cursorStatus?.connected
                ? t("usage.cursorConnectedHint", {
                    accounts: cursorStatus.accounts.length
                  })
                : hasCursorGap
                  ? t("usage.cursorDetectedHint")
                  : hasCursorUsage
                    ? t("usage.cursorCachedHint")
                    : t("usage.cursorDisconnectedHint")}
            </p>
          </div>
          <span className={`usage-cursor-status${cursorStatus?.connected ? " connected" : ""}`}>
            {cursorStatus?.connected
              ? t("usage.cursorConnected")
              : t("usage.cursorDisconnected")}
          </span>
        </div>

        {cursorError && (
          <div className="usage-cursor-error" role="alert">
            <CircleAlert aria-hidden="true" />
            {cursorError}
          </div>
        )}

        {!cursorSetupOpen && (
          <div className="usage-cursor-actions">
            {cursorStatus?.connected ? (
              <>
                <button
                  type="button"
                  className="usage-cursor-button primary"
                  disabled={scanRunning || Boolean(cursorAction)}
                  onClick={() => void refresh()}
                >
                  <RefreshCw className={scanRunning ? "spin" : ""} aria-hidden="true" />
                  {scanRunning ? t("usage.scanning") : t("usage.cursorSyncNow")}
                </button>
                <button
                  type="button"
                  className="usage-cursor-button danger"
                  disabled={Boolean(cursorAction)}
                  onClick={() => void disconnectCursor()}
                >
                  {cursorAction === "disconnect"
                    ? t("usage.cursorDisconnecting")
                    : t("usage.cursorDisconnect")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="usage-cursor-button primary"
                onClick={() => {
                  setCursorError(undefined);
                  setCursorSetupOpen(true);
                }}
              >
                {t("usage.cursorConnect")}
              </button>
            )}
          </div>
        )}

        {cursorSetupOpen && (
          <div className="usage-cursor-form">
            <div className="usage-cursor-instructions">
              <strong>{t("usage.cursorSetupTitle")}</strong>
              <ol>
                <li>{t("usage.cursorSetupStepOpen")}</li>
                <li>{t("usage.cursorSetupStepCopy")}</li>
                <li>{t("usage.cursorSetupStepPaste")}</li>
              </ol>
              <button
                type="button"
                className="usage-cursor-link"
                onClick={() => void cliClient.openCursorUsageSettings()}
              >
                {t("usage.cursorOpenSettings")}
              </button>
            </div>
            <label>
              <span>{t("usage.cursorAccountName")}</span>
              <input
                value={cursorAccountName}
                maxLength={64}
                placeholder={t("usage.cursorAccountNamePlaceholder")}
                disabled={cursorAction === "connect"}
                onChange={(event) => setCursorAccountName(event.target.value)}
              />
            </label>
            <div className="usage-cursor-field">
              <div className="usage-cursor-label-row">
                <label htmlFor="usage-cursor-session-token">
                  {t("usage.cursorSessionToken")}
                </label>
                <button
                  type="button"
                  className="usage-cursor-help-button"
                  aria-label={t("usage.cursorTokenHelpLabel")}
                  aria-expanded={cursorTokenHelpOpen}
                  aria-controls="usage-cursor-token-help"
                  onClick={() => setCursorTokenHelpOpen((open) => !open)}
                >
                  <CircleHelp aria-hidden="true" />
                </button>
              </div>
              {cursorTokenHelpOpen && (
                <div
                  id="usage-cursor-token-help"
                  className="usage-cursor-token-help"
                  role="note"
                >
                  <strong>{t("usage.cursorTokenHelpTitle")}</strong>
                  <ol>
                    <li>{t("usage.cursorTokenHelpOpenDevtools")}</li>
                    <li>{t("usage.cursorTokenHelpCookies")}</li>
                    <li>{t("usage.cursorTokenHelpSearch")}</li>
                    <li>{t("usage.cursorTokenHelpCopy")}</li>
                  </ol>
                </div>
              )}
              <input
                id="usage-cursor-session-token"
                type="password"
                value={cursorToken}
                maxLength={8192}
                autoComplete="off"
                spellCheck={false}
                placeholder={t("usage.cursorSessionTokenPlaceholder")}
                disabled={cursorAction === "connect"}
                onChange={(event) => setCursorToken(event.target.value)}
              />
              <small>{t("usage.cursorTokenSecurityHint")}</small>
            </div>
            <div className="usage-cursor-actions">
              <button
                type="button"
                className="usage-cursor-button primary"
                disabled={cursorAction === "connect"}
                onClick={() => void connectCursor()}
              >
                {cursorAction === "connect"
                  ? t("usage.cursorConnecting")
                  : t("usage.cursorConnectAndSync")}
              </button>
              <button
                type="button"
                className="usage-cursor-button"
                disabled={cursorAction === "connect"}
                onClick={() => {
                  setCursorToken("");
                  setCursorTokenHelpOpen(false);
                  setCursorError(undefined);
                  setCursorSetupOpen(false);
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

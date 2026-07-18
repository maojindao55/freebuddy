import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Database,
  RefreshCw,
  TriangleAlert
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { cliClient } from "@/services/cli/client";
import type {
  AgentModelUsage,
  AgentUsagePeriod,
  AgentUsageSummary
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
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
}

function rowTotal(row: AgentModelUsage): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
}

function aggregateAgents(rows: AgentModelUsage[]): AgentRollup[] {
  const agents = new Map<string, AgentRollup>();
  for (const row of rows) {
    const current = agents.get(row.agentId) ?? {
      agentId: row.agentId,
      agentName: row.agentName,
      modelCount: 0,
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0
    };
    current.agentName = row.agentName;
    current.modelCount += 1;
    current.messageCount += row.messageCount;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheTokens += row.cacheReadTokens + row.cacheWriteTokens;
    current.totalTokens += rowTotal(row);
    agents.set(row.agentId, current);
  }
  return [...agents.values()].sort((a, b) => b.totalTokens - a.totalTokens);
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

export function AgentUsagePage() {
  const { t, i18n } = useTranslation();
  const [summary, setSummary] = useState<AgentUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [period, setPeriod] = useState<AgentUsagePeriod>("today");
  const requestSequence = useRef(0);
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";

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

  const agents = useMemo(
    () => aggregateAgents(summary?.byAgentModel ?? []),
    [summary?.byAgentModel]
  );
  const filteredRows = useMemo(() => {
    const rows = summary?.byAgentModel ?? [];
    return rows
      .filter((row) => !selectedAgentId || row.agentId === selectedAgentId)
      .sort((a, b) => rowTotal(b) - rowTotal(a));
  }, [selectedAgentId, summary?.byAgentModel]);
  const totals = useMemo(() => {
    const rows = summary?.byAgentModel ?? [];
    return rows.reduce(
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
  }, [summary?.byAgentModel]);
  const maxAgentTokens = agents[0]?.totalTokens ?? 0;
  const coverage = summary?.linkedSessionCount
    ? Math.round((summary.attributedSessionCount / summary.linkedSessionCount) * 100)
    : 0;
  const hasUsage = Boolean(summary?.byAgentModel.length);
  const scanRunning = refreshing || summary?.scan?.status === "running";
  const selectedAgentName = selectedAgentId
    ? agents.find((agent) => agent.agentId === selectedAgentId)?.agentName
    : undefined;

  useEffect(() => {
    if (selectedAgentId && !agents.some((agent) => agent.agentId === selectedAgentId)) {
      setSelectedAgentId(undefined);
    }
  }, [agents, selectedAgentId]);

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
              agents: agents.length,
              models: new Set(summary.byAgentModel.map((row) => row.modelId)).size
            })}
          </small>
        </article>
      </div>

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
          <div className="usage-overview-grid">
            <section className="usage-panel" aria-labelledby="usage-agent-heading">
              <div className="usage-panel-heading">
                <div>
                  <h3 id="usage-agent-heading">{t("usage.byAgent")}</h3>
                  <p>{t("usage.byAgentHint")}</p>
                </div>
                {selectedAgentId && (
                  <button
                    type="button"
                    className="usage-clear-filter"
                    onClick={() => setSelectedAgentId(undefined)}
                  >
                    {t("usage.showAll")}
                  </button>
                )}
              </div>
              <div className="usage-agent-list">
                {agents.map((agent) => (
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
                    <span className="usage-agent-icon" aria-hidden="true">
                      <Bot />
                    </span>
                    <span className="usage-agent-copy">
                      <span className="usage-agent-line">
                        <strong>{agent.agentName}</strong>
                        <b title={formatExact(agent.totalTokens, locale)}>
                          {formatTokens(agent.totalTokens, locale)}
                        </b>
                      </span>
                      <span className="usage-agent-meta">
                        {t("usage.agentMeta", {
                          models: agent.modelCount,
                          messages: agent.messageCount
                        })}
                      </span>
                      <progress
                        max={Math.max(maxAgentTokens, 1)}
                        value={agent.totalTokens}
                        aria-label={t("usage.agentShare", { agent: agent.agentName })}
                      />
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="usage-panel" aria-labelledby="usage-composition-heading">
              <div className="usage-panel-heading">
                <div>
                  <h3 id="usage-composition-heading">{t("usage.tokenComposition")}</h3>
                  <p>{t("usage.tokenCompositionHint")}</p>
                </div>
              </div>
              <div className="usage-composition-list">
                {[
                  { key: "input", label: t("usage.inputTokens"), value: totals.input },
                  { key: "output", label: t("usage.outputTokens"), value: totals.output },
                  { key: "cache", label: t("usage.cacheTokens"), value: totals.cache }
                ].map((item) => {
                  const percent = totals.total ? Math.round((item.value / totals.total) * 100) : 0;
                  return (
                    <div className={`usage-composition-row ${item.key}`} key={item.key}>
                      <div>
                        <span>{item.label}</span>
                        <strong title={formatExact(item.value, locale)}>
                          {formatTokens(item.value, locale)}
                        </strong>
                      </div>
                      <progress
                        max={Math.max(totals.total, 1)}
                        value={item.value}
                        aria-label={`${item.label} ${percent}%`}
                      />
                      <small>{percent}%</small>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="usage-panel usage-model-panel" aria-labelledby="usage-model-heading">
            <div className="usage-panel-heading">
              <div>
                <h3 id="usage-model-heading">{t("usage.byModel")}</h3>
                <p>
                  {selectedAgentName
                    ? t("usage.filteredByAgent", { agent: selectedAgentName })
                    : t("usage.byModelHint")}
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
                          <Bot aria-hidden="true" />
                          {row.agentName}
                        </span>
                      </td>
                      <td>
                        <span className="usage-table-model">
                          <Cpu aria-hidden="true" />
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
        </>
      )}

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

      <p className="usage-method-note">
        <Database aria-hidden="true" />
        {t("usage.methodNote")}
      </p>
    </div>
  );
}

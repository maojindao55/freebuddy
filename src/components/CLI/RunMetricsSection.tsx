import { useId, useState } from "react";
import { Check, ChevronDown, Circle, Info, LoaderCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "@/utils/duration";
import { validMetric, type selectRunCardMetrics } from "./runCardMetrics";

type RunCard = ReturnType<typeof selectRunCardMetrics>;

function DurationValue({ ms }: { ms: number }) {
  return ms < 60_000
    ? <>{(ms / 1000).toFixed(1)}<span className="run-metrics-unit"> s</span></>
    : <>{formatDuration(ms).split(/([hms])/).map((part, index) =>
      /^[hms]$/.test(part) ? <span key={index} className="run-metrics-unit">{part}</span> : part
    )}</>;
}

export function RunMetricsSection({ metrics, elapsedMs, team = false, teamRunning = false, status }: {
  metrics: RunCard;
  elapsedMs?: number;
  team?: boolean;
  teamRunning?: boolean;
  status?: string;
}) {
  const { t, i18n } = useTranslation();
  const [showSpeedHelp, setShowSpeedHelp] = useState(false);
  const titleId = useId();
  const helpId = useId();
  const key = "workspace.runMetrics";
  const running = team ? teamRunning : metrics.running;
  const exists = team || metrics.exists;
  const runStatus = status ?? (exists ? metrics.status : "idle");
  const StatusIcon = runStatus === "done" ? Check :
    runStatus === "failed" || runStatus === "timed-out" ? X :
    runStatus === "running" || runStatus === "preparing" ? LoaderCircle : Circle;
  const tokenCount = (value: number | undefined) => value === undefined ? "—" :
    new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const firstTextMs = team ? undefined : metrics.firstTextMs;
  const firstText = team || !exists ? "—" : firstTextMs !== undefined ? <DurationValue ms={firstTextMs} /> :
    metrics.summary?.firstTextUnavailable || metrics.status === "unknown" ? t(`${key}.unavailable`) :
    running ? t(`${key}.${metrics.summary?.promptSubmitted ? "waitingText" : "preparing"}`) :
    metrics.summary ? t(`${key}.noText`) : t(`${key}.unavailable`);
  const missing = exists ? t(`${key}.${running ? "pending" : "notReported"}`) : "—";
  const speedMissing = metrics.automaticSpeed && exists ? t(`${key}.${running ? "measuring" : "unavailable"}`) : missing;
  const speedHint = t(`${key}.${team ? "teamHint" : metrics.speedSource === "measured" ? "measuredSpeedHint" :
    metrics.speedSource === "call-average" ? "callAverageSpeedHint" :
    metrics.speedSource === "observed" ? "observedSpeedHint" :
    metrics.tokensPerSecond === undefined && metrics.automaticSpeed ? "automaticSpeedHint" : "speedHint"}`);
  const speedBasis = t(`${key}.${metrics.speedSource === "measured" ? "measuredSpeed" :
    metrics.speedSource === "call-average" ? "callAverageBasis" :
    metrics.speedSource === "observed" ? "observedSpeed" : "reportedSpeed"}`);
  const usage = team ? undefined : metrics.usage;
  const cachedReadTokens = validMetric(usage?.cachedReadTokens);
  const usageInput = validMetric(usage?.inputTokens);
  const cacheHitRate = validMetric(usage?.metrics?.cacheHitRate) ??
    (cachedReadTokens !== undefined && usageInput !== undefined && usageInput > 0 ? cachedReadTokens / usageInput : undefined);
  const thoughtTokens = validMetric(usage?.thoughtTokens ?? usage?.metrics?.thoughtTokens);
  const llmDurationMs = validMetric(usage?.metrics?.llmDurationMs);
  const cost = validMetric(usage?.costAmount);

  return (
    <section className="side-card run-overview-card" aria-labelledby={titleId}>
      <header className="workspace-overview-heading">
        <h2 id={titleId}>{t(`${key}.${!exists ? "noRun" : team ? "teamRun" : running ? "currentRun" : "lastRun"}`)}</h2>
        <span className={`run-metrics-status is-${runStatus}`}>
          <StatusIcon size={13} aria-hidden="true" />
          {t(`${key}.status.${runStatus}`, { defaultValue: t(`${key}.status.unknown`) })}
        </span>
      </header>
      <dl className="run-metrics-timings">
        <div title={t(`${key}.${team ? "teamDurationHint" : "durationHint"}`)}>
          <dt>{t(`${key}.duration`)}</dt>
          <dd>{elapsedMs === undefined ? "—" : <DurationValue ms={elapsedMs} />}</dd>
        </div>
        <div title={t(`${key}.${team ? "teamHint" : "firstTextHint"}`)}>
          <dt>{t(`${key}.firstText`)}</dt>
          <dd className={firstTextMs === undefined ? "is-unavailable" : undefined}>{firstText}</dd>
        </div>
      </dl>
      <div className="run-metrics-throughput">
        <div className="run-metrics-label">
          {t(`${key}.${metrics.speedSource === "call-average" && !team ? "throughput" : "speed"}`)}
          <button type="button" className="run-metrics-info" title={speedHint} aria-label={t(`${key}.speedDetails`)} aria-expanded={showSpeedHelp} aria-controls={helpId} onClick={() => setShowSpeedHelp(!showSpeedHelp)}>
            <Info size={13} aria-hidden="true" />
          </button>
        </div>
        <div className="run-metrics-speed-value">
          {team ? "—" : metrics.tokensPerSecond !== undefined ? <>
            {metrics.tokensPerSecond.toFixed(1)}<span className="run-metrics-unit"> tok/s</span>
            <small className="run-metrics-basis" title={speedHint}>{speedBasis}</small>
          </> : <span className="run-metrics-pending">{speedMissing}</span>}
        </div>
      </div>
      <p className="run-metrics-help" id={helpId} hidden={!showSpeedHelp}>{speedHint}</p>
      <dl className="run-metrics-tokens" aria-label={t(`${key}.tokens`)} title={t(`${key}.${team ? "teamHint" : "tokensHint"}`)}>
        <div><dt>{t(`${key}.input`)} <span>Token</span></dt><dd>{team ? "—" : tokenCount(metrics.inputTokens)}</dd></div>
        <div><dt>{t(`${key}.output`)} <span>Token</span></dt><dd>{team ? "—" : tokenCount(metrics.outputTokens)}</dd></div>
      </dl>
      {team ? <p className="run-metrics-note">{t(`${key}.teamHint`)}</p> : exists && metrics.inputTokens === undefined && metrics.outputTokens === undefined && <p className="run-metrics-note">{missing}</p>}
      <details className="workspace-overview-disclosure">
        <summary><span>{t(`${key}.details`)}</span><span className="workspace-overview-disclosure-hint">{t(`${key}.detailsHint`)}</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="workspace-overview-details">
          <dl className="workspace-overview-detail-list">
            <div><dt>{t("workspace.cacheHitRate")}</dt><dd>{cacheHitRate === undefined ? "—" : `${Math.round(cacheHitRate * 100)}%`}{cachedReadTokens !== undefined && cachedReadTokens > 0 && <span className="run-metrics-cached"> ({tokenCount(cachedReadTokens)})</span>}</dd></div>
            <div><dt>{t("workspace.thoughtTokens")}</dt><dd>{tokenCount(thoughtTokens)}</dd></div>
            {!team && metrics.reportedTtftMs !== undefined && <div title={t(`${key}.reportedTtftHint`)}><dt>{t(`${key}.reportedTtft`)}</dt><dd><DurationValue ms={metrics.reportedTtftMs} /></dd></div>}
            {llmDurationMs !== undefined && <div><dt>{t("workspace.llmDuration")}</dt><dd><DurationValue ms={llmDurationMs} /></dd></div>}
            {cost !== undefined && <div><dt>{t("workspace.cost")}</dt><dd>{new Intl.NumberFormat(i18n.language, { maximumFractionDigits: cost < 0.01 ? 4 : 2, minimumFractionDigits: 2 }).format(cost)}{usage?.costCurrency && ` ${usage.costCurrency}`}</dd></div>}
          </dl>
          <p className="workspace-overview-detail-note">{t(`${key}.${team ? "teamDurationHint" : "firstTextHint"}`)}</p>
          {!team && <p className="workspace-overview-detail-note">{t(`${key}.durationHint`)} {t(`${key}.tokensHint`)}</p>}
        </div>
      </details>
    </section>
  );
}

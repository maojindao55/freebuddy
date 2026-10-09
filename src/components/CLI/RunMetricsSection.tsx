import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, Circle, Info, LoaderCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "@/utils/duration";
import { formatTokenCount } from "@/utils/tokenCount";
import { validMetric, type selectRunCardMetrics } from "./runCardMetrics";

type RunCard = ReturnType<typeof selectRunCardMetrics>;

function DurationValue({ ms }: { ms: number }) {
  return ms < 60_000
    ? <>{(ms / 1000).toFixed(1)}<span className="run-metrics-unit"> s</span></>
    : <>{formatDuration(ms).split(/([hms])/).map((part, index) =>
      /^[hms]$/.test(part) ? <span key={index} className="run-metrics-unit">{part}</span> : part
    )}</>;
}

export function RunMetricsSection({ metrics, elapsedMs, team = false, teamRunning = false, status, identity }: {
  metrics: RunCard;
  elapsedMs?: number;
  team?: boolean;
  teamRunning?: boolean;
  status?: string;
  identity?: ReactNode;
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
  const exactCount = (value: number | undefined) => value === undefined ? "—" : new Intl.NumberFormat(i18n.language).format(value);
  const outputTracked = team || metrics.firstOutputTracked;
  const firstWaitMs = team ? undefined : outputTracked ? metrics.firstOutputMs : metrics.firstTextMs;
  const firstWaitUnavailable = outputTracked ? metrics.summary?.firstOutputUnavailable : metrics.summary?.firstTextUnavailable;
  const firstWaitHint = team ? "teamHint" : outputTracked ? "firstOutputHint" : "firstTextHint";
  const waitingKey = metrics.summary?.promptSubmitted ? outputTracked ? "waitingOutput" : "waitingText" : "preparing";
  const noOutputKey = metrics.summary ? outputTracked ? "noOutput" : "noText" : "unavailable";
  const firstWait = team || !exists ? "—" : firstWaitMs !== undefined ? <DurationValue ms={firstWaitMs} /> :
    firstWaitUnavailable || metrics.status === "unknown" ? t(`${key}.unavailable`) :
    t(`${key}.${running ? waitingKey : noOutputKey}`);
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

  const hasSpeed = !team && metrics.tokensPerSecond !== undefined;
  const hasTokens = !team && (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined);

  return (
    <section className="side-card run-overview-card" aria-labelledby={titleId}>
      {identity && <div className="run-overview-identity">{identity}</div>}
      <header className="workspace-overview-heading">
        <h2 id={titleId}>{t(`${key}.${!exists ? "noRun" : team ? "teamRun" : running ? "currentRun" : "lastRun"}`)}</h2>
        <span className={`run-metrics-status is-${runStatus}`}>
          <StatusIcon size={13} aria-hidden="true" />
          {t(`${key}.status.${runStatus}`, { defaultValue: t(`${key}.status.unknown`) })}
        </span>
      </header>
      <dl className="run-metrics-grid">
        <div title={t(`${key}.${team ? "teamDurationHint" : "durationHint"}`)}>
          <dt><span>{t(`${key}.duration`)}</span></dt>
          <dd className={`run-metrics-value${elapsedMs === undefined ? " is-unavailable" : ""}`}>{elapsedMs === undefined ? "—" : <DurationValue ms={elapsedMs} />}</dd>
        </div>
        <div title={t(`${key}.${firstWaitHint}`)}>
          <dt><span>{t(`${key}.${outputTracked ? "firstOutput" : "firstText"}`)}</span></dt>
          <dd className={`run-metrics-value${firstWaitMs === undefined ? " is-unavailable" : ""}`}>{firstWait}</dd>
          {!team && outputTracked && firstWaitMs !== undefined && metrics.firstOutputKind &&
            <dd className="run-metrics-caption">{t(`${key}.firstOutputKind.${metrics.firstOutputKind}`)}</dd>}
        </div>
        <div>
          <dt>
            <span>{t(`${key}.${metrics.speedSource === "call-average" && !team ? "throughput" : "speed"}`)}</span>
            <button type="button" className="run-metrics-info" title={speedHint} aria-label={t(`${key}.speedDetails`)} aria-expanded={showSpeedHelp} aria-controls={helpId} onClick={() => setShowSpeedHelp(!showSpeedHelp)}>
              <Info size={13} aria-hidden="true" />
            </button>
          </dt>
          <dd className={`run-metrics-value${hasSpeed ? "" : " is-unavailable"}`}>{hasSpeed ? <>{metrics.tokensPerSecond!.toFixed(1)}<span className="run-metrics-unit"> tok/s</span></> : team ? "—" : speedMissing}</dd>
          {hasSpeed && <dd className="run-metrics-caption" title={speedHint}>{speedBasis}</dd>}
        </div>
        <div title={t(`${key}.${team ? "teamHint" : "tokensHint"}`)}>
          <dt><span>{t("workspace.tokens")}</span></dt>
          <dd className={`run-metrics-value${hasTokens ? " run-metrics-pair" : " is-unavailable"}`} title={hasTokens ? t("workspace.tokenBreakdown", { input: exactCount(metrics.inputTokens), output: exactCount(metrics.outputTokens) }) : undefined}>{hasTokens ? `${formatTokenCount(metrics.inputTokens)} / ${formatTokenCount(metrics.outputTokens)}` : team ? "—" : missing}</dd>
          {hasTokens && <dd className="run-metrics-caption">{t(`${key}.input`)} / {t(`${key}.output`)}</dd>}
        </div>
      </dl>
      <p className="run-metrics-help" id={helpId} hidden={!showSpeedHelp}>{speedHint}</p>
      {team && <p className="run-metrics-note">{t(`${key}.teamHint`)}</p>}
      <details className="workspace-overview-disclosure">
        <summary><span>{t(`${key}.details`)}</span><span className="workspace-overview-disclosure-hint">{t(`${key}.detailsHint`)}</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="workspace-overview-details">
          <dl className="workspace-overview-detail-list">
            <div><dt>{t("workspace.cacheHitRate")}</dt><dd>{cacheHitRate === undefined ? "—" : `${Math.round(cacheHitRate * 100)}%`}{cachedReadTokens !== undefined && cachedReadTokens > 0 && <span className="run-metrics-cached"> ({formatTokenCount(cachedReadTokens)})</span>}</dd></div>
            <div><dt>{t("workspace.thoughtTokens")}</dt><dd>{formatTokenCount(thoughtTokens)}</dd></div>
            {!team && metrics.reportedTtftMs !== undefined && <div title={t(`${key}.reportedTtftHint`)}><dt>{t(`${key}.reportedTtft`)}</dt><dd><DurationValue ms={metrics.reportedTtftMs} /></dd></div>}
            {llmDurationMs !== undefined && <div><dt>{t("workspace.llmDuration")}</dt><dd><DurationValue ms={llmDurationMs} /></dd></div>}
            {cost !== undefined && <div><dt>{t("workspace.cost")}</dt><dd>{new Intl.NumberFormat(i18n.language, { maximumFractionDigits: cost < 0.01 ? 4 : 2, minimumFractionDigits: 2 }).format(cost)}{usage?.costCurrency && ` ${usage.costCurrency}`}</dd></div>}
          </dl>
          <p className="workspace-overview-detail-note">{t(`${key}.${team ? "teamDurationHint" : firstWaitHint}`)}</p>
          {!team && <p className="workspace-overview-detail-note">{t(`${key}.durationHint`)} {t(`${key}.tokensHint`)}</p>}
        </div>
      </details>
    </section>
  );
}

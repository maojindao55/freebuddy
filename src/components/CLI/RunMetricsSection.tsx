import { useTranslation } from "react-i18next";
import { formatDuration } from "@/utils/duration";
import type { selectRunCardMetrics } from "./runCardMetrics";

type RunCard = ReturnType<typeof selectRunCardMetrics>;

function seconds(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(2)} s` : formatDuration(ms);
}

export function RunMetricsSection({ metrics, elapsedMs, team = false, teamRunning = false }: {
  metrics: RunCard;
  elapsedMs?: number;
  team?: boolean;
  teamRunning?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const key = "workspace.runMetrics";
  const running = team ? teamRunning : metrics.running;
  const exists = team || metrics.exists;
  const tokenCount = (value: number | undefined) => value === undefined ? "—" :
    new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const firstText = team || !exists ? "—" : metrics.firstTextMs !== undefined ? seconds(metrics.firstTextMs) :
    metrics.summary?.firstTextUnavailable || metrics.status === "unknown" ? t(`${key}.unavailable`) :
    running ? t(`${key}.${metrics.summary?.promptSubmitted ? "waitingText" : "preparing"}`) :
    metrics.summary ? t(`${key}.noText`) : t(`${key}.unavailable`);
  const missing = exists ? t(`${key}.${running ? "pending" : "notReported"}`) : "—";
  const speedMissing = metrics.automaticSpeed && exists ? t(`${key}.${running ? "measuring" : "unavailable"}`) : missing;

  return (
    <div className="run-metrics">
      <p className="run-metrics-caption">
        {t(`${key}.${!exists ? "noRun" : team ? "teamRun" : running ? "currentRun" : "lastRun"}`)}
      </p>
      <dl className="run-metrics-grid">
        <div title={t(`${key}.${team ? "teamHint" : "firstTextHint"}`)}>
          <dt>{t(`${key}.firstText`)}</dt>
          <dd>{firstText}</dd>
          {!team && metrics.reportedTtftMs !== undefined && (
            <small title={t(`${key}.reportedTtftHint`)}>{t(`${key}.reportedTtft`)} {seconds(metrics.reportedTtftMs)}</small>
          )}
        </div>
        <div title={t(`${key}.${team ? "teamHint" : metrics.speedSource === "measured" ? "measuredSpeedHint" :
          metrics.speedSource === "call-average" ? "callAverageSpeedHint" :
          metrics.speedSource === "observed" ? "observedSpeedHint" :
          metrics.tokensPerSecond === undefined && metrics.automaticSpeed ? "automaticSpeedHint" : "speedHint"}`)}>
          <dt>{t(`${key}.speed`)}</dt>
          <dd>{team ? "—" : metrics.tokensPerSecond !== undefined ?
            <>{metrics.tokensPerSecond.toFixed(1)} <span>tok/s</span></> : speedMissing}</dd>
          {!team && metrics.tokensPerSecond !== undefined && <small>{t(`${key}.${metrics.speedSource === "measured" ? "measuredSpeed" : metrics.speedSource === "call-average" ? "callAverageSpeed" : metrics.speedSource === "observed" ? "observedSpeed" : "reportedSpeed"}`)}</small>}
        </div>
        <div title={t(`${key}.${team ? "teamHint" : "tokensHint"}`)}>
          <dt>{t(`${key}.tokens`)}</dt>
          <dd>{team ? "— / —" : `${tokenCount(metrics.inputTokens)} / ${tokenCount(metrics.outputTokens)}`}</dd>
          {!team && exists && metrics.inputTokens === undefined && metrics.outputTokens === undefined && <small>{missing}</small>}
        </div>
        <div title={t(`${key}.${team ? "teamDurationHint" : "durationHint"}`)}>
          <dt>{t(`${key}.duration`)}</dt>
          <dd>{elapsedMs === undefined ? "—" : seconds(elapsedMs)}</dd>
        </div>
      </dl>
    </div>
  );
}

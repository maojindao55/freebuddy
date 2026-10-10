import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "@/utils/duration";
import { formatTokenCount } from "@/utils/tokenCount";
import { runCardElapsedMs, validMetric, type RunMetrics } from "./runCardMetrics";
import {
  DurationValue,
  firstWaitInfo,
  runStatusIcon,
  speedBasisKey,
  speedHintKey,
  speedLabelKey
} from "./runMetricsView";

const KEY = "workspace.runMetrics";

function inlineElapsed(m: RunMetrics): number | undefined {
  return runCardElapsedMs(m.summary, false, undefined, 0);
}

export function hasMessageRunMetrics(m: RunMetrics): boolean {
  if (!m.summary) return false;
  return (
    inlineElapsed(m) !== undefined ||
    firstWaitInfo(m).ms !== undefined ||
    m.tokensPerSecond !== undefined ||
    m.inputTokens !== undefined ||
    m.outputTokens !== undefined
  );
}

export function RunMetricsDetails({ metrics }: { metrics: RunMetrics }) {
  const { t, i18n } = useTranslation();
  const m = metrics;
  const exactCount = (value: number | undefined) =>
    value === undefined ? "—" : new Intl.NumberFormat(i18n.language).format(value);
  const StatusIcon = runStatusIcon(m.status);
  const firstWait = firstWaitInfo(m);
  const elapsed = inlineElapsed(m);
  const hasSpeed = m.tokensPerSecond !== undefined;
  const hasTokens = m.inputTokens !== undefined || m.outputTokens !== undefined;
  const usage = m.usage;
  const cachedReadTokens = validMetric(usage?.cachedReadTokens);
  const usageInput = validMetric(usage?.inputTokens);
  const cacheHitRate = validMetric(usage?.metrics?.cacheHitRate) ??
    (cachedReadTokens !== undefined && usageInput !== undefined && usageInput > 0 ? cachedReadTokens / usageInput : undefined);
  const thoughtTokens = validMetric(usage?.thoughtTokens ?? usage?.metrics?.thoughtTokens);
  const llmDurationMs = validMetric(usage?.metrics?.llmDurationMs);
  const cost = validMetric(usage?.costAmount);
  const firstWaitValue = firstWait.ms !== undefined ? (
    <>
      <DurationValue ms={firstWait.ms} />
      {firstWait.tracked && m.firstOutputKind && ` · ${t(`${KEY}.firstOutputKind.${m.firstOutputKind}`)}`}
    </>
  ) : firstWait.unavailable || m.status === "unknown" ? t(`${KEY}.unavailable`) : t(`${KEY}.${firstWait.missingKey}`);

  return (
    <>
      <header className="msg-run-metrics-head">
        <span className="msg-run-metrics-title">{t("message.runMetrics.title")}</span>
        <span className={`run-metrics-status is-${m.status}`}>
          <StatusIcon size={13} aria-hidden="true" />
          {t(`${KEY}.status.${m.status}`, { defaultValue: t(`${KEY}.status.unknown`) })}
        </span>
      </header>
      <dl className="msg-run-metrics-list">
        <div title={t(`${KEY}.durationHint`)}>
          <dt>{t(`${KEY}.duration`)}</dt>
          <dd>{elapsed === undefined ? "—" : <DurationValue ms={elapsed} />}</dd>
        </div>
        <div title={t(`${KEY}.${firstWait.hintKey}`)}>
          <dt>{t(`${KEY}.${firstWait.labelKey}`)}</dt>
          <dd>{firstWaitValue}</dd>
        </div>
        <div title={t(`${KEY}.${speedHintKey(m)}`)}>
          <dt>{t(`${KEY}.${speedLabelKey(m)}`)}</dt>
          <dd>{hasSpeed
            ? <>{m.tokensPerSecond!.toFixed(1)}<span className="run-metrics-unit"> tok/s</span>{` · ${t(`${KEY}.${speedBasisKey(m)}`)}`}</>
            : t(`${KEY}.${m.automaticSpeed ? "unavailable" : "notReported"}`)}</dd>
        </div>
        <div title={t(`${KEY}.tokensHint`)}>
          <dt>{t(`${KEY}.tokens`)}</dt>
          <dd title={hasTokens ? t("workspace.tokenBreakdown", { input: exactCount(m.inputTokens), output: exactCount(m.outputTokens) }) : undefined}>{hasTokens ? `${formatTokenCount(m.inputTokens)} / ${formatTokenCount(m.outputTokens)}` : t(`${KEY}.notReported`)}</dd>
        </div>
        <div>
          <dt>{t("workspace.cacheHitRate")}</dt>
          <dd>{cacheHitRate === undefined ? "—" : `${Math.round(cacheHitRate * 100)}%`}{cachedReadTokens !== undefined && cachedReadTokens > 0 && <span className="run-metrics-cached"> ({formatTokenCount(cachedReadTokens)})</span>}</dd>
        </div>
        <div>
          <dt>{t("workspace.thoughtTokens")}</dt>
          <dd>{formatTokenCount(thoughtTokens)}</dd>
        </div>
        {m.reportedTtftMs !== undefined && <div title={t(`${KEY}.reportedTtftHint`)}>
          <dt>{t(`${KEY}.reportedTtft`)}</dt>
          <dd><DurationValue ms={m.reportedTtftMs} /></dd>
        </div>}
        {llmDurationMs !== undefined && <div>
          <dt>{t("workspace.llmDuration")}</dt>
          <dd><DurationValue ms={llmDurationMs} /></dd>
        </div>}
        {cost !== undefined && <div>
          <dt>{t("workspace.cost")}</dt>
          <dd>{new Intl.NumberFormat(i18n.language, { maximumFractionDigits: cost < 0.01 ? 4 : 2, minimumFractionDigits: 2 }).format(cost)}{usage?.costCurrency && ` ${usage.costCurrency}`}</dd>
        </div>}
      </dl>
      <details className="msg-run-metrics-basis">
        <summary>{t("message.runMetrics.basis")}</summary>
        <p>{t(`${KEY}.${speedHintKey(m)}`)}</p>
        <p>{t(`${KEY}.${firstWait.hintKey}`)}</p>
        <p>{t(`${KEY}.durationHint`)} {t(`${KEY}.tokensHint`)}</p>
      </details>
    </>
  );
}

export function MessageRunMetrics({ metrics }: { metrics: RunMetrics }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const exactCount = (value: number | undefined) =>
    value === undefined ? "—" : new Intl.NumberFormat(i18n.language).format(value);
  const firstWait = firstWaitInfo(metrics);
  const elapsed = inlineElapsed(metrics);
  const hasTokens = metrics.inputTokens !== undefined || metrics.outputTokens !== undefined;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setOpenUp(rect.top > window.innerHeight - rect.bottom);
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        type="button"
        className="msg-run-metrics"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title={t("message.runMetrics.open")}
        onClick={toggle}
      >
        {elapsed !== undefined && (
          <span className="msg-run-metric is-duration" title={t(`${KEY}.duration`)}>
            <DurationValue ms={elapsed} />
          </span>
        )}
        {firstWait.ms !== undefined && (
          <span className="msg-run-metric is-first-output" title={t(`${KEY}.${firstWait.labelKey}`)}>
            {t(`${KEY}.${firstWait.labelKey}`)} <DurationValue ms={firstWait.ms} />
          </span>
        )}
        {metrics.tokensPerSecond !== undefined && (
          <span className="msg-run-metric is-speed" title={t(`${KEY}.${speedLabelKey(metrics)}`)}>
            {metrics.tokensPerSecond.toFixed(1)}<span className="run-metrics-unit"> tok/s</span>
          </span>
        )}
        {hasTokens && (
          <span
            className="msg-run-metric is-tokens"
            title={t("workspace.tokenBreakdown", { input: exactCount(metrics.inputTokens), output: exactCount(metrics.outputTokens) })}
          >
            {formatTokenCount(metrics.inputTokens)} / {formatTokenCount(metrics.outputTokens)} {t("workspace.tokens")}
          </span>
        )}
        <Info className="msg-run-metrics-info-icon" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={panelId}
          className="msg-run-metrics-panel"
          role="dialog"
          aria-label={t("message.runMetrics.title")}
          ref={panelRef}
          style={openUp ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }}
        >
          <RunMetricsDetails metrics={metrics} />
        </div>
      )}
    </>
  );
}

export function LiveRunElapsed({ summary, receivedAt }: {
  summary: RunMetrics["summary"];
  receivedAt: number;
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = runCardElapsedMs(summary, true, receivedAt, now);
  if (elapsed === undefined) return null;
  return <span className="status-pill-elapsed"> · {formatDuration(elapsed)}</span>;
}

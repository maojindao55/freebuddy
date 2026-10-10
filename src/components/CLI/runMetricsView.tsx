import { Check, Circle, LoaderCircle, X, type LucideIcon } from "lucide-react";
import { formatDuration } from "@/utils/duration";
import type { RunMetrics } from "./runCardMetrics";

export function DurationValue({ ms }: { ms: number }) {
  return ms < 60_000
    ? <>{(ms / 1000).toFixed(1)}<span className="run-metrics-unit"> s</span></>
    : <>{formatDuration(ms).split(/([hms])/).map((part, index) =>
      /^[hms]$/.test(part) ? <span key={index} className="run-metrics-unit">{part}</span> : part
    )}</>;
}

export function runStatusIcon(status: string): LucideIcon {
  return status === "done" ? Check :
    status === "failed" || status === "timed-out" ? X :
    status === "running" || status === "preparing" ? LoaderCircle : Circle;
}

export function speedHintKey(m: RunMetrics) {
  return m.speedSource === "measured" ? "measuredSpeedHint" :
    m.speedSource === "call-average" ? "callAverageSpeedHint" :
    m.speedSource === "observed" ? "observedSpeedHint" :
    m.tokensPerSecond === undefined && m.automaticSpeed ? "automaticSpeedHint" : "speedHint";
}

export function speedBasisKey(m: RunMetrics) {
  return m.speedSource === "measured" ? "measuredSpeed" :
    m.speedSource === "call-average" ? "callAverageBasis" :
    m.speedSource === "observed" ? "observedSpeed" : "reportedSpeed";
}

export function speedLabelKey(m: RunMetrics) {
  return m.speedSource === "call-average" ? "throughput" : "speed";
}

export function firstWaitInfo(m: RunMetrics) {
  const tracked = m.firstOutputTracked;
  return {
    tracked,
    ms: tracked ? m.firstOutputMs : m.firstTextMs,
    unavailable: Boolean(tracked ? m.summary?.firstOutputUnavailable : m.summary?.firstTextUnavailable),
    labelKey: tracked ? "firstOutput" : "firstText",
    hintKey: tracked ? "firstOutputHint" : "firstTextHint",
    waitingKey: m.summary?.promptSubmitted ? (tracked ? "waitingOutput" : "waitingText") : "preparing",
    missingKey: m.summary ? (tracked ? "noOutput" : "noText") : "unavailable"
  };
}

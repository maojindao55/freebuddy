import type { AgentRunMetrics, CliStreamItem } from "@freebuddy/protocol/cli";
import { StreamGenerationTracker, type GenerationStreamItem } from "./streamGenerationTracker.js";

export type RunMetricsStatus = AgentRunMetrics["status"];
type Usage = Extract<CliStreamItem, { kind: "usage" }>;
type MetricInput = GenerationStreamItem & {
  terminal?: boolean;
} & Partial<Pick<Usage, "usageScope" | "inputTokens" | "outputTokens" | "thoughtTokens" | "metrics" | "runMetrics" | "generationMeasurement">>;

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value : undefined;
}

/** No content is retained. All timing is taken before renderer batching. */
export class RunMetricsCollector {
  private readonly started: number;
  private promptSent?: number;
  private terminal?: AgentRunMetrics;
  private requestedOutcome?: RunMetricsStatus;
  private failed = false;
  private values: Partial<AgentRunMetrics> = {};
  private reportedSpeed?: number;
  private streamGeneration?: StreamGenerationTracker;
  private observeStream = false;
  private streamOutputTokens?: number;
  private streamThoughtTokens?: number;
  private modelCallDurationMs?: number;

  constructor(
    private readonly runId: string,
    private readonly publish: (metrics: AgentRunMetrics) => void,
    private readonly clock: () => number = () => Number(process.hrtime.bigint()) / 1e6
  ) {
    this.started = this.clock();
  }

  now(): number { return this.clock(); }

  snapshot(): AgentRunMetrics {
    if (this.terminal) return { ...this.terminal };
    return {
      ...this.values,
      runId: this.runId,
      status: this.promptSent === undefined ? "preparing" : "running",
      elapsedMs: Math.max(0, this.clock() - this.started),
      promptSubmitted: this.promptSent !== undefined
    };
  }

  emit(): void {
    try { this.publish(this.snapshot()); } catch { /* Metrics cannot stop execution. */ }
  }

  promptSubmitted(at = this.clock()): void {
    if (this.terminal || this.promptSent !== undefined) return;
    this.promptSent = at;
    this.emit();
  }

  unavailableFirstText(): void {
    this.values.firstTextUnavailable = true;
  }

  enableAutomaticSpeed(mode: "native" | "stream" = "native"): void {
    if (this.terminal) return;
    this.observeStream = mode === "stream";
    if (this.values.automaticSpeed) return;
    this.values.automaticSpeed = true;
    this.emit();
  }

  beginGeneration(): void {
    if (this.terminal || !this.observeStream) return;
    this.streamGeneration = new StreamGenerationTracker();
    this.streamOutputTokens = undefined;
    this.streamThoughtTokens = undefined;
    this.modelCallDurationMs = undefined;
    if (this.values.speedSource === "observed" || this.values.speedSource === "call-average") {
      delete this.values.tokensPerSecond;
      delete this.values.speedSource;
      delete this.values.generationDurationMs;
      delete this.values.modelCallDurationMs;
      this.emit();
    }
  }

  completeGeneration(at = this.clock()): void { this.streamGeneration?.end(at); }
  pauseGeneration(at = this.clock()): void { this.streamGeneration?.pause(at); }
  resumeGeneration(): void { this.streamGeneration?.resume(); }

  requestOutcome(status: "cancelled" | "timed-out" | "yielded"): void {
    if (!this.requestedOutcome) this.requestedOutcome = status;
  }

  error(): void { this.failed = true; }

  /** Call only after replay suppression and protocol normalization. */
  observe(items: readonly MetricInput[], at = this.clock()): void {
    if (this.terminal) return;
    let changed = false;
    for (const item of items) {
      if (this.promptSent !== undefined && !this.values.firstTextUnavailable) this.streamGeneration?.observe(item, at);
      if (item.kind === "error" && item.terminal) this.failed = true;
      if (this.promptSent !== undefined && !this.values.firstTextUnavailable &&
          this.values.firstTextLatencyMs === undefined && item.kind === "text" &&
          item.role === "assistant" && item.content?.trim()) {
        this.values.firstTextLatencyMs = Math.max(0, at - this.promptSent);
        changed = true;
      }
      if (item.kind !== "usage" || item.runMetrics) continue;
      const updates: Partial<AgentRunMetrics> = {
        reportedTtftMs: nonNegative(item.metrics?.avgTtftMs)
      };
      this.reportedSpeed = nonNegative(item.metrics?.tokensPerSecond) ?? this.reportedSpeed;
      if (item.usageScope === "turn") {
        this.streamOutputTokens = nonNegative(item.outputTokens) ?? this.streamOutputTokens;
        this.streamThoughtTokens = nonNegative(item.thoughtTokens ?? item.metrics?.thoughtTokens) ?? this.streamThoughtTokens;
        this.modelCallDurationMs = nonNegative(item.metrics?.modelCallDurationMs) ?? this.modelCallDurationMs;
      }
      const nativeMeasurement = item.usageScope === "turn" ? item.generationMeasurement : undefined;
      const observedMeasurement = item.usageScope === "turn" && this.values.speedSource !== "measured"
        ? this.streamGeneration?.measurement(this.streamOutputTokens, this.streamThoughtTokens) : undefined;
      if (!nativeMeasurement && !observedMeasurement && this.values.speedSource === "observed" &&
          this.streamThoughtTokens !== undefined && this.streamThoughtTokens > 0) {
        // Reasoning usage may arrive after the output counter. Revoke a rate
        // already calculated from a text-only stream and keep the real counts.
        delete this.values.tokensPerSecond;
        delete this.values.speedSource;
        delete this.values.generationDurationMs;
        changed = true;
      }
      const callDuration = this.modelCallDurationMs;
      const callOutput = this.streamOutputTokens;
      const callAverage = item.usageScope === "turn" && callDuration !== undefined && callDuration >= 1 &&
          callDuration <= Number.MAX_SAFE_INTEGER && callOutput !== undefined && Number.isSafeInteger(callOutput)
        ? nonNegative(callOutput * 1000 / callDuration) : undefined;
      // Explicit native call time covers hidden reasoning too. Keep its
      // first-packet-inclusive basis distinct from a streaming measurement.
      const measurement = nativeMeasurement ?? (callAverage === undefined ? observedMeasurement : undefined);
      if (measurement) {
        const duration = nonNegative(measurement.durationMs);
        const output = nonNegative(measurement.outputTokens);
        const speed = duration !== undefined && duration >= 1 && output !== undefined && Number.isSafeInteger(output)
          ? nonNegative(output * 1000 / duration) : undefined;
        if (measurement.complete === true && speed !== undefined) {
          updates.tokensPerSecond = speed;
          updates.speedSource = nativeMeasurement ? "measured" : "observed";
          updates.generationDurationMs = duration;
          if (this.values.modelCallDurationMs !== undefined) {
            delete this.values.modelCallDurationMs;
            changed = true;
          }
        } else if (this.values.speedSource === "measured") {
          delete this.values.tokensPerSecond;
          delete this.values.speedSource;
          delete this.values.generationDurationMs;
          changed = true;
        }
      } else if (callAverage !== undefined && this.values.speedSource !== "measured") {
        updates.tokensPerSecond = callAverage;
        updates.speedSource = "call-average";
        updates.modelCallDurationMs = callDuration;
        if (this.values.generationDurationMs !== undefined) {
          delete this.values.generationDurationMs;
          changed = true;
        }
      }
      if (!updates.speedSource && this.values.speedSource !== "measured" && this.values.speedSource !== "observed" &&
          this.values.speedSource !== "call-average" && this.reportedSpeed !== undefined) {
        updates.tokensPerSecond = this.reportedSpeed;
        updates.speedSource = "reported";
      }
      if (item.usageScope === "turn") {
        updates.inputTokens = nonNegative(item.inputTokens);
        updates.outputTokens = nonNegative(item.outputTokens);
      }
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || this.values[key as keyof AgentRunMetrics] === value) continue;
        Object.assign(this.values, { [key]: value });
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  finish(status: "done" | "failed" = "done"): void {
    if (this.terminal) return;
    this.terminal = {
      ...this.snapshot(),
      status: this.requestedOutcome ?? (this.failed ? "failed" : status)
    };
    this.emit();
  }
}

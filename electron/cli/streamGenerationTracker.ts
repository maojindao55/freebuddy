import type { GenerationMeasurement } from "@freebuddy/protocol/cli";

export type GenerationStreamItem = {
  kind: string;
  role?: string;
  content?: string;
  append?: boolean;
  id?: string;
  status?: string;
};

/** Protocol-level observation only. Never retains output or estimates token counts. */
export class StreamGenerationTracker {
  private active?: { first: number; last: number; deltas: number };
  private durationMs = 0;
  private segments = 0;
  private invalid = false;
  private complete = false;
  private paused = false;
  private betweenCalls = false;
  private sawThinkingDelta = false;
  private readonly tools = new Set<string>();
  private readonly seenTools = new Set<string>();

  observe(item: GenerationStreamItem, at: number): void {
    if (this.complete || !Number.isFinite(at)) return;
    if (item.kind === "generation-delta" ||
        (item.kind === "text" && item.role === "assistant" || item.kind === "thinking") && item.content?.trim()) {
      if (item.kind !== "generation-delta" && !item.append) {
        // A full snapshot cannot establish a streaming interval. If deltas
        // preceded it, this snapshot is an explicit end of that response.
        if (this.active) this.close(at);
        else if (!this.betweenCalls) this.invalid = true;
        return;
      }
      if (this.paused || this.tools.size) this.invalid = true;
      if (item.kind === "thinking") this.sawThinkingDelta = true;
      this.betweenCalls = false;
      if (!this.active) this.active = { first: at, last: at, deltas: 1 };
      else { this.active.last = at; this.active.deltas++; }
    } else if (item.kind === "tool-call") {
      if (!item.id) { this.invalid = true; this.close(at); return; }
      const terminal = item.status === "completed" || item.status === "failed";
      if (!this.seenTools.has(item.id)) {
        // A tool-only model call has no observable first output boundary.
        if (terminal || !this.active && !this.betweenCalls) this.invalid = true;
        this.close(at);
        this.seenTools.add(item.id);
      }
      if (terminal) this.tools.delete(item.id);
      else this.tools.add(item.id);
      if (terminal && !this.tools.size) this.betweenCalls = false;
    } else if (item.kind === "tool-result") {
      if (!item.id || !this.seenTools.has(item.id)) this.invalid = true;
      if (item.id) this.tools.delete(item.id);
      if (!this.tools.size) this.betweenCalls = false;
    } else if (item.kind === "command" || item.kind === "raw") {
      // Unstructured output / execution cannot be matched to model generation.
      this.invalid = true;
    }
  }

  private close(at: number): void {
    if (!this.active) return;
    const elapsed = at - this.active.first;
    if (this.active.deltas < 2 || this.active.last <= this.active.first || elapsed < 1) this.invalid = true;
    else { this.durationMs += elapsed; this.segments++; }
    this.active = undefined;
    this.betweenCalls = true;
  }

  pause(at: number): void { this.close(at); this.paused = true; }
  resume(): void { this.paused = false; }

  end(at: number): void {
    if (this.complete) return;
    this.close(at);
    this.complete = true;
  }

  measurement(outputTokens: number | undefined, thoughtTokens?: number): GenerationMeasurement | undefined {
    if (!this.complete || this.invalid || this.tools.size || this.paused || !this.segments ||
        // Some adapters include hidden reasoning in outputTokens but stream
        // only the final text. Its arrival interval cannot time those tokens.
        thoughtTokens !== undefined && thoughtTokens > 0 && !this.sawThinkingDelta ||
        outputTokens === undefined || !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
        !Number.isFinite(this.durationMs) || this.durationMs < 1) return undefined;
    return { outputTokens, durationMs: this.durationMs, complete: true };
  }
}

import fs from "node:fs";
import path from "node:path";

export const PI_GENERATION_METRICS_TYPE = "freebuddy-generation-metrics";

/** Installed in the managed Pi runtime; persists numbers only, outside LLM context. */
export const PI_RUN_METRICS_EXTENSION_SOURCE = `export default function (pi) {
  const now = () => Number(process.hrtime.bigint()) / 1e6;
  let active;
  pi.on("agent_start", () => { active = undefined; });
  pi.on("agent_end", () => { active = undefined; });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") active = { deltas: 0, pausedMs: 0 };
  });
  pi.on("message_update", (event) => {
    if (!active || event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;
    if (!["text_delta", "thinking_delta", "toolcall_delta"].includes(update?.type) ||
        typeof update.delta !== "string" || !update.delta.length) return;
    active.firstDelta ??= now();
    active.deltas++;
  });
  pi.on("ui_prompt_start", () => {
    if (active?.firstDelta !== undefined) active.pauseStart ??= now();
  });
  pi.on("ui_prompt_end", () => {
    if (active?.pauseStart === undefined) return;
    active.pausedMs += Math.max(0, now() - active.pauseStart);
    active.pauseStart = undefined;
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || !active) return;
    const ended = now();
    const sample = active;
    active = undefined;
    const output = event.message.usage?.output;
    const duration = sample.firstDelta === undefined ? undefined : ended - sample.firstDelta -
      sample.pausedMs - (sample.pauseStart === undefined ? 0 : Math.max(0, ended - sample.pauseStart));
    const data = { version: 1 };
    if (Number.isSafeInteger(output) && output >= 0) data.outputTokens = output;
    // Buffered / single-delta responses have no reliable streaming interval.
    if (sample.deltas >= 2 && Number.isFinite(duration) && duration >= 1) data.durationMs = duration;
    try { pi.appendEntry("${PI_GENERATION_METRICS_TYPE}", data); } catch { /* Measurement is optional. */ }
  });
}
`;

export function ensurePiRunMetricsExtension(dataDir: string): string {
  const dir = path.join(dataDir, "pi-agent", "extensions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "freebuddy-run-metrics.js");
  let existing: string | undefined;
  try { existing = fs.readFileSync(file, "utf8"); } catch { /* First installation. */ }
  if (existing !== PI_RUN_METRICS_EXTENSION_SOURCE) fs.writeFileSync(file, PI_RUN_METRICS_EXTENSION_SOURCE, "utf8");
  return file;
}

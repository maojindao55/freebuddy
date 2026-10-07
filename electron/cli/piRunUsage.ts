import fs from "node:fs";
import path from "node:path";
import type { CliStreamItem } from "@freebuddy/protocol/cli";
import { PI_GENERATION_METRICS_TYPE } from "./piRunMetricsExtension.js";

type UsageItem = Extract<CliStreamItem, { kind: "usage" }>;
type TokenField = "inputTokens" | "outputTokens" | "cachedReadTokens" | "cachedWriteTokens" | "thoughtTokens";
type Cursor = { sessionId: string; file?: string; offset: number; identity?: string };
const MAX_DELTA_BYTES = 8 * 1024 * 1024;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Recover provider usage omitted by older pi-acp bridges, never session totals. */
export class PiRunUsageReader {
  private readonly sessionsDir: string;
  private readonly cursors = new Map<string, Cursor>();
  private readonly totals: Partial<Record<TokenField, number>> = {};
  private readonly unknown = new Set<TokenField>();
  private failed = false;
  private assistantCalls = 0;
  private measuredCalls = 0;
  private measuredOutput = 0;
  private generationMs = 0;
  private invalidMeasurement = false;

  constructor(dataDir: string) {
    this.sessionsDir = path.join(dataDir, "pi-agent", "sessions");
  }

  private findFile(sessionId: string): string | undefined {
    if (!/^[\w-]{1,128}$/.test(sessionId)) return undefined;
    const matches: string[] = [];
    try {
      for (const dir of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const cwdDir = path.join(this.sessionsDir, dir.name);
        for (const file of fs.readdirSync(cwdDir, { withFileTypes: true })) {
          if (file.isFile() && file.name.endsWith(`_${sessionId}.jsonl`)) matches.push(path.join(cwdDir, file.name));
        }
      }
    } catch { /* The file may not exist until Pi saves its first message. */ }
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Called before writing the first prompt for each native session in this run. */
  begin(sessionId: string): void {
    if (this.cursors.has(sessionId)) return;
    const file = this.findFile(sessionId);
    const cursor: Cursor = { sessionId, file, offset: 0 };
    if (file) {
      const stat = fs.statSync(file);
      cursor.offset = stat.size;
      cursor.identity = `${stat.dev}:${stat.ino}`;
    }
    this.cursors.set(sessionId, cursor);
  }

  private add(field: TokenField, value: number | undefined): void {
    const total = value === undefined ? undefined : count((this.totals[field] ?? 0) + value);
    if (total === undefined) this.unknown.add(field);
    else this.totals[field] = total;
  }

  read(): UsageItem | undefined {
    if (this.failed) return undefined;
    let changed = false;
    try {
      for (const cursor of this.cursors.values()) {
        cursor.file ??= this.findFile(cursor.sessionId);
        if (!cursor.file) continue;
        const fd = fs.openSync(cursor.file, "r");
        try {
          const stat = fs.fstatSync(fd);
          const identity = `${stat.dev}:${stat.ino}`;
          if ((cursor.identity && cursor.identity !== identity) || stat.size < cursor.offset || stat.size - cursor.offset > MAX_DELTA_BYTES) {
            this.failed = true;
            return undefined;
          }
          cursor.identity = identity;
          const buffer = Buffer.alloc(stat.size - cursor.offset);
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
          const end = buffer.subarray(0, bytes).lastIndexOf(10);
          if (end < 0) continue;
          for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
            if (!line.trim()) continue;
            const entry = JSON.parse(line);
            if (entry.type === "custom" && entry.customType === PI_GENERATION_METRICS_TYPE) {
              this.measuredCalls++;
              const output = count(entry.data?.outputTokens);
              const duration = entry.data?.durationMs;
              if (entry.data?.version !== 1 || output === undefined ||
                  typeof duration !== "number" || !Number.isFinite(duration) || duration < 1) {
                this.invalidMeasurement = true;
              } else {
                this.measuredOutput += output;
                this.generationMs += duration;
              }
              changed = true;
              continue;
            }
            const message = entry.message;
            if (entry.type !== "message" || message?.role !== "assistant") continue;
            this.assistantCalls++;
            const usage = message.usage;
            const input = count(usage?.input);
            const cacheRead = count(usage?.cacheRead);
            const cacheWrite = count(usage?.cacheWrite);
            // Pi's input excludes cache tokens; normalize to total prompt input.
            this.add("inputTokens", input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
              ? input + cacheRead + cacheWrite : undefined);
            this.add("outputTokens", count(usage?.output));
            this.add("cachedReadTokens", cacheRead);
            this.add("cachedWriteTokens", cacheWrite);
            // Pi reasoning is already included in output, so never add it twice.
            this.add("thoughtTokens", count(usage?.reasoning));
            changed = true;
          }
          cursor.offset += end + 1;
        } finally { fs.closeSync(fd); }
      }
    } catch {
      this.failed = true;
      return undefined;
    }
    if (!changed) return undefined;
    const usage: UsageItem = { kind: "usage", usageScope: "turn" };
    for (const field of Object.keys(this.totals) as TokenField[]) {
      if (!this.unknown.has(field)) usage[field] = this.totals[field];
    }
    usage.generationMeasurement = {
      outputTokens: this.measuredOutput,
      durationMs: this.generationMs,
      complete: !this.invalidMeasurement && this.assistantCalls > 0 &&
        this.measuredCalls === this.assistantCalls && count(this.measuredOutput) !== undefined &&
        Number.isFinite(this.generationMs) && this.generationMs > 0 &&
        this.measuredOutput === usage.outputTokens
    };
    return usage;
  }
}

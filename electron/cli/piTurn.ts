import type { AcpStreamItem } from "./acp.js";

type PiStatus = { kind: "retry-start" | "retry-end" | "compaction" | "queue"; message: string };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Read the bridge's versioned progress contract without interpreting answer text. */
export function piLifecycleStatus(update: unknown, chinese: boolean): PiStatus | undefined {
  if (!record(update) || update.sessionUpdate !== "session_info_update" || !record(update._meta)) return undefined;
  const piAcp = update._meta.piAcp;
  if (!record(piAcp) || !record(piAcp.status) || piAcp.status.version !== 1) return undefined;
  const status = piAcp.status;
  const count = (key: string) => typeof status[key] === "number" && Number.isSafeInteger(status[key]) && status[key] >= 0
    ? status[key] as number : undefined;
  if (status.type === "retry") {
    if (status.phase === "started") {
      const attempt = count("attempt"), maximum = count("maxAttempts"), delay = count("delayMs");
      const progress = attempt !== undefined && maximum !== undefined ? ` (${attempt}/${maximum})` : "";
      return { kind: "retry-start", message: chinese
        ? `上游请求失败，${delay !== undefined ? `${Math.ceil(delay / 1000)} 秒后` : "正在"}重试${progress}。`
        : `Upstream request failed; ${delay !== undefined ? `retrying in ${Math.ceil(delay / 1000)}s` : "retrying"}${progress}.` };
    }
    if (status.phase === "succeeded" || status.phase === "failed") return {
      kind: "retry-end", message: status.phase === "succeeded"
        ? (chinese ? "重试已恢复，正在继续生成。" : "Retry recovered; generation is continuing.")
        : (chinese ? "重试失败，本轮未完成。" : "Retries failed; the turn did not complete.")
    };
  }
  if (status.type === "compaction") {
    const messages: Record<string, [string, string]> = {
      started: ["正在压缩上下文。", "Compacting context."],
      succeeded: ["上下文压缩完成。", "Context compaction completed."],
      failed: ["上下文压缩失败。", "Context compaction failed."],
      cancelled: ["上下文压缩已取消。", "Context compaction cancelled."]
    };
    const message = typeof status.phase === "string" && Object.hasOwn(messages, status.phase) ? messages[status.phase] : undefined;
    if (message) return { kind: "compaction", message: message[chinese ? 0 : 1] };
  }
  if (status.type === "queue") {
    const messages: Record<string, [string, string]> = {
      queued: ["请求已排队。", "Request queued."],
      started: ["正在处理排队请求。", "Processing the queued request."],
      cancelled: ["排队请求已取消。", "Queued requests cancelled."]
    };
    const message = typeof status.phase === "string" && Object.hasOwn(messages, status.phase) ? messages[status.phase] : undefined;
    if (message) return { kind: "queue", message: message[chinese ? 0 : 1] };
  }
  return undefined;
}

export interface PiAssistantOutcome {
  stopReason?: string;
  errorMessage?: string;
  hasText: boolean;
  hasThinking: boolean;
  hasToolCalls: boolean;
  malformed: boolean;
}

/** Recognize the leaked protocol footer, while leaving quoted examples alone. */
function malformedPiText(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, "");
  return /^\s*<thinking>/.test(prose) &&
    /<\/[｜|]{2}DSML[｜|]{2}\s+parameter>\s*<\/[｜|]{2}DSML[｜|]{2}\s+invoke>\s*<\/[｜|]{2}DSML[｜|]{2}\s+calls>\s*$/.test(prose);
}

/** Keep only completion metadata, never native reasoning or answer bodies. */
export function summarizePiAssistantMessage(message: any): PiAssistantOutcome | undefined {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content.filter((part: any) => part?.type === "text")
    .map((part: any) => typeof part.text === "string" ? part.text : "").join("");
  return {
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    hasText: Boolean(text.trim()),
    hasThinking: message.content.some((part: any) => part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()),
    hasToolCalls: message.content.some((part: any) => part?.type === "toolCall"),
    malformed: malformedPiText(text)
  };
}

/** pi-acp <= 0.0.34-fb.2 sends these lifecycle events as assistant text. */
export function piBridgeStatus(update: any, chinese: boolean): { kind: "retry-start" | "retry-end" | "compaction"; message: string } | undefined {
  if (update?.sessionUpdate !== "agent_message_chunk" || update.messageId ||
      update.content?.type !== "text" || typeof update.content.text !== "string") return undefined;
  const text = update.content.text;
  const retry = /^Retrying \(attempt (\d+)\/(\d+), waiting (\d+)s\)\.\.\.$/.exec(text);
  if (retry) return { kind: "retry-start", message: chinese
    ? `上游请求失败，${retry[3]} 秒后重试（${retry[1]}/${retry[2]}）。`
    : `Upstream request failed; retrying in ${retry[3]}s (${retry[1]}/${retry[2]}).` };
  switch (text) {
    case "Retry finished, resuming.":
      // This event does not establish success: Pi also emits it after exhaustion.
      return { kind: "retry-end", message: chinese ? "重试阶段结束，正在检查结果。" : "Retry phase ended; checking the result." };
    case "Context nearing limit, running automatic compaction...":
      return { kind: "compaction", message: chinese ? "上下文接近上限，正在自动压缩。" : text };
    case "Automatic compaction finished; context was summarized to continue the session.":
      return { kind: "compaction", message: chinese ? "上下文压缩阶段结束。" : text };
    default:
      return undefined;
  }
}

/** Fallback for older/missing native session files; observe live updates only. */
export class PiTurnTracker {
  private last: PiAssistantOutcome | undefined;
  private text = "";
  private readonly tools = new Set<string>();

  reset(): void {
    this.last = undefined;
    this.text = "";
    this.tools.clear();
  }

  retrying(): void {
    this.last = { hasText: false, hasThinking: false, hasToolCalls: false, malformed: false };
    this.text = "";
  }

  observe(items: readonly AcpStreamItem[], newToolCall?: string): void {
    if (newToolCall && !this.tools.has(newToolCall)) {
      this.tools.add(newToolCall);
      this.last = undefined;
      this.text = "";
    }
    for (const item of items) {
      if (item.kind !== "thinking" && !(item.kind === "text" && item.role === "assistant")) continue;
      if (!item.content.trim()) continue;
      this.last ??= { hasText: false, hasThinking: false, hasToolCalls: false, malformed: false };
      if (item.kind === "thinking") this.last.hasThinking = true;
      else {
        this.last.hasText = true;
        // Bound fallback storage. Native session metadata remains authoritative.
        this.text = (this.text + item.content).slice(0, 32_768);
        this.last.malformed = malformedPiText(this.text);
      }
    }
  }

  completionError(native: PiAssistantOutcome | undefined, chinese: boolean): string | undefined {
    const outcome = native ?? this.last ?? (this.tools.size ? undefined : {
      hasText: false, hasThinking: false, hasToolCalls: false, malformed: false
    });
    if (!outcome) return undefined; // Tool-only completions can be legitimate.
    if (outcome.stopReason === "error" || outcome.errorMessage) return chinese
      ? `Pi 上游请求失败，本轮未完成${outcome.errorMessage ? `：${outcome.errorMessage}` : "。"}`
      : `The Pi upstream request failed; the turn did not complete${outcome.errorMessage ? `: ${outcome.errorMessage}` : "."}`;
    if (outcome.stopReason === "length") return chinese
      ? "Pi 输出达到长度上限，本轮未完成。请继续会话或调整模型输出限制。"
      : "Pi reached the output limit; the turn did not complete. Continue the conversation or adjust the model output limit.";
    if (outcome.stopReason === "aborted") return chinese
      ? "Pi 上游生成被中断，本轮未完成。请重试。"
      : "Pi generation was aborted upstream; the turn did not complete. Retry the request.";
    if (outcome.malformed) return chinese
      ? "Pi 返回了混入正文的思考和工具协议标记，本轮未完成。请重试或切换模型。"
      : "Pi returned reasoning and tool protocol markers as answer text; the turn did not complete. Retry or switch models.";
    if (!outcome.hasText && outcome.hasThinking && !outcome.hasToolCalls) return chinese
      ? "Pi 只返回了思考内容，没有给出回答，本轮未完成。请继续会话或切换模型。"
      : "Pi returned thinking without an answer; the turn did not complete. Continue the conversation or switch models.";
    if (!outcome.hasText && !outcome.hasThinking && !outcome.hasToolCalls) return chinese
      ? "Pi 未返回回答，本轮未完成。请检查模型状态后重试。"
      : "Pi returned no answer; the turn did not complete. Check the model and retry.";
    return undefined;
  }
}

import { createHash } from "node:crypto";

export interface ToolActivityTiming {
  startedAt: number;
  lastProgressAt: number;
}

/** Protocol liveness and tool progress are different signals. Retain no raw tool output. */
export class AcpToolActivityTracker {
  private readonly tools = new Map<string, ToolActivityTiming & { outputHash?: string }>();
  private readonly terminalOwners = new Map<string, string>();

  observe(update: any, now = Date.now()): ToolActivityTiming | undefined {
    if (!/^tool_call(?:_update)?$/.test(String(update?.sessionUpdate)) || update?.toolCallId == null) return;
    const id = String(update.toolCallId);
    if (!id) return;
    const tool = this.tools.get(id) ?? { startedAt: now, lastProgressAt: now };
    this.tools.set(id, tool);
    for (const content of Array.isArray(update.content) ? update.content : []) {
      if (content?.type === "terminal" && typeof content.terminalId === "string") {
        this.terminalOwners.set(content.terminalId, id);
      }
    }
    const meta = update._meta;
    if (typeof meta?.terminal_info?.terminal_id === "string") {
      this.terminalOwners.set(meta.terminal_info.terminal_id, id);
    }
    const output = JSON.stringify([update.rawOutput, update.content]);
    if (update.rawOutput != null || update.content?.length) {
      const hash = createHash("sha256").update(output).digest("hex");
      if (hash !== tool.outputHash) tool.lastProgressAt = now;
      tool.outputHash = hash;
    }
    if (typeof meta?.terminal_output?.data === "string" && meta.terminal_output.data) {
      tool.lastProgressAt = now;
    }
    return { startedAt: tool.startedAt, lastProgressAt: tool.lastProgressAt };
  }

  terminalProgress(terminalId: string, now = Date.now()) {
    const id = this.terminalOwners.get(terminalId);
    const tool = id ? this.tools.get(id) : undefined;
    if (!id || !tool) return;
    tool.lastProgressAt = now;
    return { id, startedAt: tool.startedAt, lastProgressAt: tool.lastProgressAt };
  }

  clear() {
    this.tools.clear();
    this.terminalOwners.clear();
  }
}

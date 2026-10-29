import { MAX_TERMINAL_OUTPUT_BYTES } from "./acpTerminal.js";

interface EmbeddedTerminalSnapshot {
  terminalId: string;
  output: string;
  truncated: boolean;
  exitCode?: number | null;
  exited: boolean;
  running: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Display-only terminal metadata emitted by adapters such as pi-acp. */
export class AcpEmbeddedTerminalTracker {
  private readonly terminals = new Map<string, { toolCallId: string; snapshot: EmbeddedTerminalSnapshot }>();

  consume(update: unknown): EmbeddedTerminalSnapshot[] {
    if (!record(update) || !["tool_call", "tool_call_update"].includes(String(update.sessionUpdate)) ||
        typeof update.toolCallId !== "string") return [];
    const meta = record(update._meta) ? update._meta : {};
    const changed = new Set<string>();
    const info = record(meta.terminal_info) ? meta.terminal_info : undefined;
    const ids = Array.isArray(update.content)
      ? update.content.filter(record).filter(entry => entry.type === "terminal").map(entry => entry.terminalId)
      : [];
    if (info) ids.push(info.terminal_id);
    for (const id of ids) {
      if (typeof id !== "string" || !id) continue;
      if (!this.terminals.has(id)) {
        this.terminals.set(id, { toolCallId: update.toolCallId, snapshot: {
          terminalId: id, output: "", truncated: false, exited: false, running: true
        } });
        changed.add(id);
      }
    }
    const output = record(meta.terminal_output) ? meta.terminal_output : undefined;
    if (output && typeof output.terminal_id === "string" && typeof output.data === "string") {
      const terminal = this.terminals.get(output.terminal_id);
      if (terminal?.toolCallId === update.toolCallId) {
        const combined = terminal.snapshot.output + output.data;
        const bytes = Buffer.from(combined, "utf8");
        let start = Math.max(0, bytes.length - MAX_TERMINAL_OUTPUT_BYTES);
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
        terminal.snapshot.output = bytes.subarray(start).toString("utf8");
        terminal.snapshot.truncated ||= start > 0;
        changed.add(output.terminal_id);
      }
    }
    const exit = record(meta.terminal_exit) ? meta.terminal_exit : undefined;
    if (exit && typeof exit.terminal_id === "string") {
      const terminal = this.terminals.get(exit.terminal_id);
      if (terminal?.toolCallId === update.toolCallId) {
        terminal.snapshot.exitCode = typeof exit.exit_code === "number" && Number.isSafeInteger(exit.exit_code)
          ? exit.exit_code : null;
        terminal.snapshot.exited = true;
        terminal.snapshot.running = false;
        changed.add(exit.terminal_id);
      }
    }
    if (update.status === "completed" || update.status === "failed") {
      for (const [id, terminal] of this.terminals) {
        if (terminal.toolCallId !== update.toolCallId || terminal.snapshot.exited) continue;
        terminal.snapshot.exited = true;
        terminal.snapshot.running = false;
        terminal.snapshot.exitCode = null;
        changed.add(id);
      }
    }
    return [...changed].map(id => ({ ...this.terminals.get(id)!.snapshot }));
  }
}

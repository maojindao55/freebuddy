import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

export interface TerminalSnapshot {
  output: string;
  truncated: boolean;
  exitCode?: number | null;
  exited: boolean;
}

export interface AcpTerminalManager {
  create(params: {
    sessionId: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: { name: string; value: string }[];
    outputByteLimit?: number;
  }): { terminalId: string };
  output(terminalId: string): TerminalSnapshot;
  waitForExit(
    terminalId: string
  ): Promise<{ exitCode?: number | null; signal?: string | null }>;
  kill(terminalId: string): void;
  release(terminalId: string): void;
  dispose(): void;
}

type TerminalRecord = {
  id: string;
  sessionId: string;
  child: ChildProcess;
  outputBytes: number;
  chunks: string[];
  byteLimit: number;
  truncated: boolean;
  exited: boolean;
  exitCode?: number | null;
  signal?: string | null;
  exitWaiters: Array<{
    resolve: (value: { exitCode?: number | null; signal?: string | null }) => void;
  }>;
};

function snapshot(record: TerminalRecord): TerminalSnapshot {
  return {
    output: record.chunks.join(""),
    truncated: record.truncated,
    exitCode: record.exitCode,
    exited: record.exited
  };
}

export function createAcpTerminalManager(options: {
  defaultCwd?: string;
  onOutput?: (terminalId: string, snap: TerminalSnapshot) => void;
}): AcpTerminalManager {
  const terminals = new Map<string, TerminalRecord>();

  function appendOutput(record: TerminalRecord, data: Buffer) {
    if (record.truncated) return;
    const text = data.toString("utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    if (record.outputBytes + bytes > record.byteLimit) {
      const remaining = record.byteLimit - record.outputBytes;
      if (remaining > 0) {
        let used = 0;
        let sliceEnd = 0;
        for (const char of text) {
          const charBytes = Buffer.byteLength(char, "utf8");
          if (used + charBytes > remaining) break;
          used += charBytes;
          sliceEnd += char.length;
        }
        if (sliceEnd > 0) {
          record.chunks.push(text.slice(0, sliceEnd));
          record.outputBytes += used;
        }
      }
      record.truncated = true;
    } else {
      record.chunks.push(text);
      record.outputBytes += bytes;
    }
    options.onOutput?.(record.id, snapshot(record));
  }

  function markExited(
    record: TerminalRecord,
    exitCode: number | null,
    signal: string | null
  ) {
    if (record.exited) return;
    record.exited = true;
    record.exitCode = exitCode;
    record.signal = signal;
    const result = { exitCode, signal };
    for (const waiter of record.exitWaiters) {
      waiter.resolve(result);
    }
    record.exitWaiters = [];
    options.onOutput?.(record.id, snapshot(record));
  }

  return {
    create(params) {
      const terminalId = `term_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const byteLimit = params.outputByteLimit ?? 1024 * 1024;
      const env = { ...process.env } as Record<string, string>;
      for (const entry of params.env ?? []) {
        env[entry.name] = entry.value;
      }

      const child = spawn(params.command, params.args ?? [], {
        cwd: params.cwd || options.defaultCwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const record: TerminalRecord = {
        id: terminalId,
        sessionId: params.sessionId,
        child,
        outputBytes: 0,
        chunks: [],
        byteLimit,
        truncated: false,
        exited: false,
        exitWaiters: []
      };
      terminals.set(terminalId, record);

      child.stdout?.on("data", (chunk) => appendOutput(record, chunk));
      child.stderr?.on("data", (chunk) => appendOutput(record, chunk));
      child.on("close", (code, signal) => {
        markExited(record, code, signal);
      });
      child.on("error", () => {
        markExited(record, 1, null);
      });

      return { terminalId };
    },

    output(terminalId) {
      const record = terminals.get(terminalId);
      if (!record) {
        throw new Error(`Unknown terminal ${terminalId}`);
      }
      return snapshot(record);
    },

    waitForExit(terminalId) {
      const record = terminals.get(terminalId);
      if (!record) {
        return Promise.reject(new Error(`Unknown terminal ${terminalId}`));
      }
      if (record.exited) {
        return Promise.resolve({
          exitCode: record.exitCode,
          signal: record.signal
        });
      }
      return new Promise((resolve) => {
        record.exitWaiters.push({ resolve });
      });
    },

    kill(terminalId) {
      const record = terminals.get(terminalId);
      if (!record || record.exited) return;
      try {
        record.child.kill("SIGTERM");
      } catch {
        /* noop */
      }
    },

    release(terminalId) {
      const record = terminals.get(terminalId);
      if (!record) return;
      if (!record.exited) {
        try {
          record.child.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }
      terminals.delete(terminalId);
    },

    dispose() {
      for (const terminalId of [...terminals.keys()]) {
        this.release(terminalId);
      }
    }
  };
}

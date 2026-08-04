import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

/** Keep repeated terminal results from exhausting an agent's context window. */
export const MAX_TERMINAL_OUTPUT_BYTES = 128 * 1024;

export interface TerminalSnapshot {
  output: string;
  truncated: boolean;
  exitCode?: number | null;
  signal?: string | null;
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
  }): Promise<{ terminalId: string }>;
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
    signal: record.signal,
    exited: record.exited
  };
}

export function createAcpTerminalManager(options: {
  defaultCwd?: string;
  commandIsShellLine?: boolean;
  onOutput?: (terminalId: string, snap: TerminalSnapshot) => void;
  prepareSpawn?: (input: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }) => Promise<{
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
  }>;
  onPreparedSpawnExit?: () => void;
}): AcpTerminalManager {
  const terminals = new Map<string, TerminalRecord>();

  function appendOutput(record: TerminalRecord, data: Buffer) {
    const text = data.toString("utf8");
    const combined = record.chunks.join("") + text;
    const combinedBytes = Buffer.byteLength(combined, "utf8");
    if (combinedBytes > record.byteLimit) {
      let used = 0;
      const chars = Array.from(combined);
      let start = chars.length;
      while (start > 0) {
        const charBytes = Buffer.byteLength(chars[start - 1], "utf8");
        if (used + charBytes > record.byteLimit) break;
        used += charBytes;
        start -= 1;
      }
      record.chunks = [chars.slice(start).join("")];
      record.outputBytes = used;
      record.truncated = true;
    } else {
      record.chunks = [combined];
      record.outputBytes = combinedBytes;
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
    async create(params) {
      const terminalId = `term_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const requestedByteLimit =
        typeof params.outputByteLimit === "number" &&
        Number.isFinite(params.outputByteLimit)
          ? Math.max(1, Math.floor(params.outputByteLimit))
          : MAX_TERMINAL_OUTPUT_BYTES;
      const byteLimit = Math.min(
        requestedByteLimit,
        MAX_TERMINAL_OUTPUT_BYTES
      );
      const env = { ...process.env } as Record<string, string>;
      for (const entry of params.env ?? []) {
        env[entry.name] = entry.value;
      }

      const cwd = params.cwd || options.defaultCwd || process.cwd();
      const rawArgs = params.args ?? [];
      const shouldRunShellLine =
        options.commandIsShellLine && rawArgs.length === 0;
      const command = shouldRunShellLine
        ? process.platform === "win32"
          ? process.env.ComSpec || "cmd.exe"
          : "/bin/sh"
        : params.command;
      const commandArgs = shouldRunShellLine
        ? process.platform === "win32"
          ? ["/d", "/s", "/c", params.command]
          : ["-c", params.command]
        : rawArgs;
      const prepared = options.prepareSpawn
        ? await options.prepareSpawn({
            command,
            args: commandArgs,
            cwd,
            env
          })
        : { command, args: commandArgs, env };
      const child = spawn(prepared.command, prepared.args, {
        cwd,
        env: prepared.env,
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
        if (options.prepareSpawn) options.onPreparedSpawnExit?.();
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

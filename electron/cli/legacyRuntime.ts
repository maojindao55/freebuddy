import readline from "node:readline";
import fs from "node:fs";
import { type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { BuiltCommand } from "./adapters.js";
import { updateRuntimeRun } from "./check.js";
import { saveToolSession } from "./store.js";
import {
  appendLog,
  maybeCaptureSessionId,
  setTaskToolSessionId,
  updateTaskStatus,
  type CliEvent,
  type CliRunArgs,
  type Running
} from "./runtimeShared.js";
import { killProcessTree } from "./process-kill.js";

export interface LegacyRuntimeInput {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  args: CliRunArgs;
  built: BuiltCommand;
  pid: number;
  logStream: fs.WriteStream | null;
  toolSessionScope?: string;
  running: Map<string, Running>;
  capturedSessions: Map<string, string>;
  emit: (e: CliEvent) => void;
}

export function runLegacyCliAgent({
  child,
  args,
  built,
  pid,
  logStream,
  toolSessionScope,
  running,
  capturedSessions,
  emit
}: LegacyRuntimeInput): void {
  running.set(args.sessionId, { child, pid });

  if (built.promptViaStdin) {
    child.stdin.write(args.prompt);
  }
  child.stdin.end();

  const rlOut = readline.createInterface({ input: child.stdout });
  rlOut.on("line", (line) => {
    appendLog(logStream, "stdout", line);
    emit({ type: "stdout", content: line });
    maybeCaptureSessionId(capturedSessions, args, line);
  });

  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on("line", (line) => {
    appendLog(logStream, "stderr", line);
    if (args.showStderr !== false) emit({ type: "stderr", content: line });
  });

  let timer: NodeJS.Timeout | undefined;
  if (args.timeoutMs && args.timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        killProcessTree(child, "force");
      } catch {
        /* noop */
      }
    }, args.timeoutMs);
  }

  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    const exitCode = code ?? -1;
    running.delete(args.sessionId);
    appendLog(logStream, "system", `exit code=${exitCode}`);
    emit({ type: "done", exitCode });
    const status = exitCode === 0 ? "done" : "failed";
    updateTaskStatus(args.sessionId, status, exitCode);
    updateRuntimeRun(
      args.adapter,
      status === "failed" ? `exit ${exitCode}` : undefined
    );

    const captured = capturedSessions.get(args.sessionId);
    if (captured && toolSessionScope) {
      saveToolSession(args.agentId, toolSessionScope, args.adapter, captured);
      setTaskToolSessionId(args.sessionId, captured);
    }
    capturedSessions.delete(args.sessionId);
    logStream?.end();
  });
}

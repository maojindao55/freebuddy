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
import { clearSessionOwner } from "./sessionOwners.js";
import { getParser, tryJson } from "@freebuddy/cli-stream";
import { getAdapterDefinition } from "./adapters.js";
import type { ParseContext } from "@freebuddy/protocol/cli";
import type { RunMetricsCollector } from "./runMetricsCollector.js";

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
  metrics?: RunMetricsCollector;
  resumed?: boolean;
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
  emit,
  metrics,
  resumed
}: LegacyRuntimeInput): void {
  running.set(args.sessionId, { child, pid, cancel: () => metrics?.requestOutcome("cancelled") });
  const mode = getAdapterDefinition(args.adapter)?.streamMode ?? "raw";
  const parser = getParser(mode);
  const parseContext: ParseContext = {};
  if (mode === "raw" || resumed) metrics?.unavailableFirstText();
  metrics?.enableAutomaticSpeed("stream");
  metrics?.promptSubmitted();
  metrics?.beginGeneration();

  if (built.promptViaStdin) {
    child.stdin.write(args.prompt);
  }
  child.stdin.end();

  const rlOut = readline.createInterface({ input: child.stdout });
  rlOut.on("line", (line) => {
    const arrivedAt = metrics?.now();
    try {
      const items = parser.parseStdoutLine(line, parseContext);
      if (mode === "claude-json") {
        const event = tryJson(line)?.event;
        if (event?.type === "content_block_delta" && event.delta?.type === "input_json_delta" &&
            typeof event.delta.partial_json === "string" && event.delta.partial_json.length) {
          // Tool argument deltas are generated tokens, but are not chat text.
          metrics?.observe([{ kind: "generation-delta" }], arrivedAt);
        }
      }
      if (items.some(item => item.kind === "usage" && item.usageScope === "turn" && !item.runMetrics)) metrics?.completeGeneration(arrivedAt);
      metrics?.observe(items, arrivedAt);
    }
    catch { /* A metrics parser must not interfere with stdout delivery. */ }
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
      metrics?.requestOutcome("timed-out");
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
    // The WebUI broadcaster needs the owner mapping while delivering done.
    clearSessionOwner(args.sessionId);
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

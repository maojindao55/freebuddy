import readline from "node:readline";
import fs from "node:fs";
import { type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  acpUpdateToItems,
  buildInitializeRequest,
  buildSessionCancelNotification,
  buildSessionCloseRequest,
  buildSessionNewRequest,
  buildSessionPromptRequest,
  buildSessionResumeRequest,
  parseAcpLine,
  shouldEmitAcpUpdate,
  type AcpMessage
} from "./acp.js";
import { updateRuntimeRun } from "./check.js";
import { saveToolSession } from "./store.js";
import {
  appendLog,
  setTaskToolSessionId,
  updateTaskStatus,
  type CliEvent,
  type CliRunArgs,
  type Running
} from "./runtimeShared.js";

function writeAcp(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  msg: AcpMessage
) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

export interface AcpRuntimeInput {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  args: CliRunArgs;
  pid: number;
  logStream: fs.WriteStream | null;
  toolSessionId?: string;
  toolSessionScope?: string;
  running: Map<string, Running>;
  capturedSessions: Map<string, string>;
  emit: (e: CliEvent) => void;
}

export async function runAcpAgent({
  child,
  args,
  pid,
  logStream,
  toolSessionId,
  toolSessionScope,
  running,
  capturedSessions,
  emit
}: AcpRuntimeInput): Promise<void> {
  let requestId = 0;
  let activeAcpSessionId: string | undefined;
  let finished = false;
  let promptStarted = false;
  const pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (reason: Error) => void;
    }
  >();

  const nextId = () => ++requestId;
  const request = (msg: AcpMessage) =>
    new Promise<any>((resolve, reject) => {
      if (msg.id == null) {
        reject(new Error("ACP requests require an id"));
        return;
      }
      pending.set(String(msg.id), { resolve, reject });
      appendLog(logStream, "stdin", JSON.stringify(msg));
      writeAcp(child, msg);
    });
  const notify = (msg: AcpMessage) => {
    appendLog(logStream, "stdin", JSON.stringify(msg));
    writeAcp(child, msg);
  };
  const finish = (
    status: "done" | "failed" | "killed",
    exitCode: number,
    errorMessage?: string
  ) => {
    if (finished) return;
    finished = true;
    running.delete(args.sessionId);
    if (errorMessage) emit({ type: "error", message: errorMessage });
    emit({ type: "done", exitCode });
    updateTaskStatus(args.sessionId, status, exitCode, errorMessage);
    updateRuntimeRun(args.adapter, status === "failed" ? errorMessage : undefined);
    if (activeAcpSessionId && toolSessionScope) {
      saveToolSession(args.agentId, toolSessionScope, args.adapter, activeAcpSessionId);
      setTaskToolSessionId(args.sessionId, activeAcpSessionId);
    }
    capturedSessions.delete(args.sessionId);
    logStream?.end();
  };

  running.set(args.sessionId, {
    child,
    pid,
    cancel: () => {
      if (activeAcpSessionId) {
        notify(buildSessionCancelNotification(activeAcpSessionId));
      }
      setTimeout(() => {
        const still = running.get(args.sessionId);
        if (still) {
          try {
            still.child.kill("SIGTERM");
          } catch {
            /* noop */
          }
        }
      }, 500);
    }
  });

  const rlOut = readline.createInterface({ input: child.stdout });
  rlOut.on("line", (line) => {
    appendLog(logStream, "stdout", line);
    const msg = parseAcpLine(line);
    if (!msg) {
      emit({ type: "stderr", content: line });
      return;
    }

    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const waiter = pending.get(String(msg.id));
      if (waiter) {
        pending.delete(String(msg.id));
        if (msg.error) {
          waiter.reject(new Error(msg.error.message));
        } else {
          waiter.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method === "session/update") {
      const sessionId = msg.params?.sessionId;
      if (typeof sessionId === "string") {
        activeAcpSessionId = sessionId;
        capturedSessions.set(args.sessionId, sessionId);
      }
      if (
        !shouldEmitAcpUpdate(msg.params?.update, {
          promptStarted
        })
      ) {
        return;
      }
      const items = acpUpdateToItems(msg.params?.update, sessionId);
      if (items.length) emit({ type: "items", items });
      return;
    }

    if (msg.method && msg.id != null) {
      if (msg.method === "session/request_permission") {
        writeAcp(child, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "cancelled" } }
        });
      } else {
        writeAcp(child, {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32601,
            message: `FreeBuddy does not implement ACP method ${msg.method}`
          }
        });
      }
    }
  });

  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on("line", (line) => {
    appendLog(logStream, "stderr", line);
    if (args.showStderr !== false) emit({ type: "stderr", content: line });
  });

  child.on("close", (code) => {
    const exitCode = code ?? -1;
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`ACP agent exited with code ${exitCode}`));
    }
    pending.clear();
    if (!finished) {
      appendLog(logStream, "system", `exit code=${exitCode}`);
      finish(exitCode === 0 ? "done" : "failed", exitCode);
    }
  });

  try {
    const init = await request(buildInitializeRequest(nextId()));
    const caps = init?.agentCapabilities ?? {};
    if (toolSessionId && caps?.sessionCapabilities?.resume) {
      await request(buildSessionResumeRequest(nextId(), toolSessionId, args.cwd));
      activeAcpSessionId = toolSessionId;
    } else {
      const created = await request(buildSessionNewRequest(nextId(), args.cwd));
      activeAcpSessionId = created?.sessionId;
    }

    if (!activeAcpSessionId) {
      throw new Error("ACP agent did not return a sessionId");
    }

    emit({
      type: "items",
      items: [{ kind: "session", sessionId: activeAcpSessionId }]
    });
    promptStarted = true;
    await request(buildSessionPromptRequest(nextId(), activeAcpSessionId, args.prompt));
    if (caps?.sessionCapabilities?.close) {
      try {
        await request(buildSessionCloseRequest(nextId(), activeAcpSessionId));
      } catch {
        /* best-effort */
      }
    }
    child.stdin.end();
    finish("done", 0);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    appendLog(logStream, "system", msg);
    try {
      child.stdin.end();
    } catch {
      /* noop */
    }
    finish("failed", -1, msg);
  }
}

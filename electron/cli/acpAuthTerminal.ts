import { randomUUID } from "node:crypto";
import * as pty from "node-pty";

import type { AcpAuthMethod } from "./acp.js";
import type { CliEvent } from "./runtimeShared.js";

interface ActiveAuthTerminal {
  write(data: string): void;
  cancel(): void;
}

const activeTerminals = new Map<string, ActiveAuthTerminal>();

function authenticationFailureDetail(output: string): string | undefined {
  const clean = output
    // CSI and OSC sequences are useful to a terminal, but make task errors unreadable.
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trim();
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  const diagnostic =
    [...lines]
      .reverse()
      .find((line) =>
        /(?:error|fail|denied|invalid|expired|unable|reject|not found)/i.test(
          line
        )
      ) ?? lines.at(-1);
  return diagnostic
    ?.replace(/([?&]user_code=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(enter code:\s*)\S+/gi, "$1[redacted]")
    .slice(-800);
}

function key(sessionId: string, requestId: string) {
  return `${sessionId}:${requestId}`;
}

export function writeAuthenticationTerminal(
  sessionId: string,
  requestId: string,
  data: string
): boolean {
  const terminal = activeTerminals.get(key(sessionId, requestId));
  if (!terminal) return false;
  terminal.write(data);
  return true;
}

export function cancelAuthenticationTerminal(
  sessionId: string,
  requestId: string
): boolean {
  const terminal = activeTerminals.get(key(sessionId, requestId));
  if (!terminal) return false;
  terminal.cancel();
  return true;
}

export function clearAuthenticationTerminalsForSession(sessionId: string) {
  for (const [terminalKey, terminal] of activeTerminals) {
    if (!terminalKey.startsWith(`${sessionId}:`)) continue;
    terminal.cancel();
    activeTerminals.delete(terminalKey);
  }
}

export async function runAuthenticationTerminal(options: {
  sessionId: string;
  agentName: string;
  method: AcpAuthMethod;
  command: {
    bin: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
  };
  emit: (event: CliEvent) => void;
}): Promise<void> {
  const { sessionId, agentName, method, command, emit } = options;
  const requestId = randomUUID();
  const terminalKey = key(sessionId, requestId);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    ...command.env,
    ...(method.env ?? {})
  })) {
    if (value != null) env[name] = value;
  }

  emit({
    type: "authentication-terminal-started",
    request: {
      requestId,
      sessionId,
      agentName,
      methodName: method.name ?? method.id
    }
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let output = "";
    let terminal: pty.IPty;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      activeTerminals.delete(terminalKey);
      emit({ type: "authentication-terminal-resolved", requestId });
      if (error) reject(error);
      else resolve();
    };

    try {
      terminal = pty.spawn(
        command.bin,
        [...command.args, ...(method.args ?? [])],
        {
          name: "xterm-256color",
          cols: 100,
          rows: 30,
          cwd: command.cwd || process.cwd(),
          env
        }
      );
    } catch (error) {
      settle(
        new Error(
          `Unable to start authentication terminal: ${(error as Error)?.message || String(error)}`
        )
      );
      return;
    }

    activeTerminals.set(terminalKey, {
      write(data) {
        if (!settled) terminal.write(data);
      },
      cancel() {
        if (settled) return;
        try {
          terminal.kill();
        } catch {
          /* noop */
        }
        settle(new Error("Authentication cancelled."));
      }
    });

    terminal.onData((data) => {
      output = `${output}${data}`.slice(-64 * 1024);
      emit({
        type: "authentication-terminal-update",
        requestId,
        output,
        running: true
      });
    });
    terminal.onExit(({ exitCode, signal }) => {
      emit({
        type: "authentication-terminal-update",
        requestId,
        output,
        running: false,
        exitCode,
        signal: signal || undefined
      });
      if (exitCode === 0) settle();
      else {
        const detail = authenticationFailureDetail(output);
        settle(
          new Error(
            `Authentication terminal exited with code ${exitCode}.${
              detail ? ` ${detail}` : ""
            }`
          )
        );
      }
    });
  });
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import { applyManagedNodeEnvironment } from "./managedNodeRuntime.js";

import type { AcpAuthMethod } from "./acp.js";
import type { CliEvent } from "./runtimeShared.js";
import { setAuthenticationTerminalPending } from "./authenticationTerminalPending.js";

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

/** Keep the latest `\r` update on each line. `\r\n` stays a normal line break. */
export function collapseCarriageReturns(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("\r").at(-1) ?? "")
    .join("\n");
}

const COMATE_LOGIN_URL =
  /https:\/\/comate\.baidu(?:-int)?\.com\/[^\s"'<>]+/g;

export function comateLoginUrls(output: string): string[] {
  return [...output.matchAll(COMATE_LOGIN_URL)]
    .map((match) => match[0])
    .filter((url) => /[?&]clientId=/.test(url));
}

/**
 * comatecli opens the login page with `cmd /c start "" <url>`. cmd treats `&`
 * as a command separator, so the browser loses `clientId` and the CLI waits
 * forever. `--no-browser` prints the intact URL for us to open.
 */
export function windowsComateNoBrowserLogin(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = fs.existsSync
): { bin: string; args: string[] } {
  if (platform !== "win32" || !args.includes("--login")) return { bin, args };
  const dir = path.win32.dirname(bin);
  const sibling = ["comatecli.cmd", "comatecli.exe", "comatecli"]
    .map((name) => path.win32.join(dir, name))
    .find((candidate) => exists(candidate));
  if (!sibling) return { bin, args };
  return { bin: sibling, args: ["login", "--no-browser"] };
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    const { shell } = await import("electron");
    await shell.openExternal(url);
  } catch {
    // The full URL stays in the terminal if the shell cannot open it.
  }
}

/** npm global CLIs on Windows are `.cmd` shims. ConPTY cannot execute those directly. */
export function authenticationTerminalLaunch(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec || "cmd.exe"
): { file: string; args: string[] } {
  const ext = path.win32.extname(bin).toLowerCase();
  if (platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    const quote = (value: string) =>
      /[\s"]/u.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    return {
      file: comSpec,
      args: ["/d", "/s", "/c", [bin, ...args].map(quote).join(" ")]
    };
  }
  return { file: bin, args };
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
  for (const [name, value] of Object.entries(applyManagedNodeEnvironment({
    ...command.env,
    ...(method.env ?? {})
  }, { install: true, preserveElectronRunAsNode: command.bin === process.execPath }))) {
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
  setAuthenticationTerminalPending(sessionId, requestId, true);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let output = "";
    let terminal: pty.IPty;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      activeTerminals.delete(terminalKey);
      setAuthenticationTerminalPending(sessionId, requestId, false);
      emit({ type: "authentication-terminal-resolved", requestId });
      if (error) reject(error);
      else resolve();
    };

    const openedLoginUrls = new Set<string>();
    const publishOutput = (next: string) => {
      output = collapseCarriageReturns(next).slice(-64 * 1024);
      if (process.platform === "win32") {
        for (const url of comateLoginUrls(output)) {
          if (openedLoginUrls.has(url)) continue;
          openedLoginUrls.add(url);
          void openExternalUrl(url);
        }
      }
    };

    try {
      const rewritten = windowsComateNoBrowserLogin(command.bin, [
        ...command.args,
        ...(method.args ?? [])
      ]);
      const launch = authenticationTerminalLaunch(rewritten.bin, rewritten.args);
      terminal = pty.spawn(
        launch.file,
        launch.args,
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
      publishOutput(`${output}${data}`);
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

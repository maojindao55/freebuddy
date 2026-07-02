import spawn from "cross-spawn";
import { adapterBinary, getCliCheckProbe } from "./adapters.js";
import { getDb } from "./db.js";
import { safeSendToWebContents } from "./ipcSend.js";

export interface CliCheckResult {
  installed: boolean;
  path?: string;
  version?: string;
}

function which(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    const child = spawn(cmd, [bin], { env: process.env });
    let out = "";
    child.stdout!.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0) return resolve(undefined);
      resolve(out.split(/\r?\n/).find(Boolean));
    });
  });
}

interface CliProbeResult {
  ok: boolean;
  output?: string;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
}

function runCheckProbe(bin: string, args: string[]): Promise<CliProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false });
    }, 5000);
    child.stdout!.on("data", (d) => (stdout += d.toString()));
    child.stderr!.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false });
      resolve({ ok: true, output: firstNonEmptyLine(stdout) ?? firstNonEmptyLine(stderr) });
    });
  });
}

function upsertRuntime(
  adapter: string,
  installed: boolean,
  binaryPath?: string,
  version?: string,
  lastError?: string
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO cli_runtimes
         (adapter, installed, binary_path, version, last_check_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(adapter) DO UPDATE SET
         installed=excluded.installed,
         binary_path=excluded.binary_path,
         version=excluded.version,
         last_check_at=excluded.last_check_at,
         last_error=excluded.last_error,
         updated_at=excluded.updated_at`
    )
    .run(
      adapter,
      installed ? 1 : 0,
      binaryPath ?? null,
      version ?? null,
      now,
      lastError ?? null,
      now
    );
}

export function updateRuntimeRun(adapter: string, error?: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO cli_runtimes (adapter, installed, last_run_at, last_error, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(adapter) DO UPDATE SET
         last_run_at=excluded.last_run_at,
         last_error=excluded.last_error,
         updated_at=excluded.updated_at`
    )
    .run(adapter, now, error ?? null, now);
}

export async function cliCheck(
  adapter: string,
  binary?: string
): Promise<CliCheckResult> {
  const bin = binary?.trim() || adapterBinary(adapter) || adapter;
  const resolved = await which(bin);
  if (!resolved) {
    upsertRuntime(adapter, false, undefined, undefined, "binary not found");
    return { installed: false };
  }
  const probe = getCliCheckProbe(adapter);
  const probeResult = await runCheckProbe(resolved, probe.args);
  if (!probeResult.ok || (!probe.versionOptional && !probeResult.output)) {
    upsertRuntime(
      adapter,
      false,
      resolved,
      undefined,
      `binary found but ${probe.args.join(" ")} failed; try reinstalling`
    );
    return { installed: false };
  }
  const result: CliCheckResult = {
    installed: true,
    path: resolved,
    version: probe.versionOptional ? undefined : probeResult.output
  };
  upsertRuntime(adapter, true, resolved, result.version);
  return result;
}

export interface CliRuntime {
  adapter: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  lastCheckAt?: string;
  lastRunAt?: string;
  lastError?: string;
  updatedAt: string;
}

export function listRuntimes(): CliRuntime[] {
  const rows = getDb()
    .prepare(
      `SELECT adapter, installed, binary_path, version, last_check_at, last_run_at, last_error, updated_at
       FROM cli_runtimes ORDER BY adapter`
    )
    .all() as Array<{
    adapter: string;
    installed: number;
    binary_path: string | null;
    version: string | null;
    last_check_at: string | null;
    last_run_at: string | null;
    last_error: string | null;
    updated_at: string;
  }>;
  return rows.map((r) => ({
    adapter: r.adapter,
    installed: r.installed === 1,
    binaryPath: r.binary_path ?? undefined,
    version: r.version ?? undefined,
    lastCheckAt: r.last_check_at ?? undefined,
    lastRunAt: r.last_run_at ?? undefined,
    lastError: r.last_error ?? undefined,
    updatedAt: r.updated_at
  }));
}

export interface CliInstallResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function cliInstall(command: string): Promise<CliInstallResult> {
  return new Promise((resolve, reject) => {
    const trimmed = command.trim();
    if (!trimmed) return reject(new Error("install command required"));

    const isWindows = process.platform === "win32";
    const isPowerShellCommand =
      /^irm\s/i.test(trimmed) ||
      /\|\s*iex\b/i.test(trimmed) ||
      /Invoke-(WebRequest|Expression)/i.test(trimmed);

    let shell: string;
    let args: string[];
    if (isWindows && isPowerShellCommand) {
      shell = "powershell";
      args = [
        "-ExecutionPolicy", "Bypass",
        "-OutputFormat", "Text",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; " +
          trimmed
      ];
    } else if (isWindows) {
      shell = "cmd";
      args = ["/C", trimmed];
    } else {
      shell = process.env.SHELL || "/bin/sh";
      args = ["-lc", trimmed];
    }

    const child = spawn(shell, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.stdout!.on("data", (d) => (stdout += d.toString()));
    child.stderr!.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0,
        exitCode: code,
        stdout,
        stderr
      });
    });
  });
}

export function cliInstallStream(
  command: string,
  webContents?: Electron.WebContents | null
): Promise<CliInstallResult> {
  return new Promise((resolve, reject) => {
    const trimmed = command.trim();
    if (!trimmed) return reject(new Error("install command required"));

    const isWindows = process.platform === "win32";
    const isPowerShellCommand =
      /^irm\s/i.test(trimmed) ||
      /\|\s*iex\b/i.test(trimmed) ||
      /Invoke-(WebRequest|Expression)/i.test(trimmed);

    let shell: string;
    let args: string[];
    if (isWindows && isPowerShellCommand) {
      shell = "powershell";
      args = [
        "-ExecutionPolicy", "Bypass",
        "-OutputFormat", "Text",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; " +
          trimmed
      ];
    } else if (isWindows) {
      shell = "cmd";
      args = ["/C", trimmed];
    } else {
      shell = process.env.SHELL || "/bin/sh";
      args = ["-lc", trimmed];
    }

    const channel = "cli://install";
    const send = (payload: { type: "stdout" | "stderr"; content: string }) => {
      safeSendToWebContents(webContents, channel, payload);
    };

    const child = spawn(shell, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      send({ type: "stderr", content: "Install timed out after 10 minutes." });
      safeSendToWebContents(webContents, channel, { type: "done", exitCode: 1 });
    }, 10 * 60 * 1000);

    child.stdout!.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      send({ type: "stdout", content: chunk });
    });
    child.stderr!.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      send({ type: "stderr", content: chunk });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      send({ type: "stderr", content: String(err) });
      safeSendToWebContents(webContents, channel, { type: "done", exitCode: 1 });
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      safeSendToWebContents(webContents, channel, { type: "done", exitCode: code });
      resolve({
        success: code === 0,
        exitCode: code,
        stdout,
        stderr
      });
    });
  });
}

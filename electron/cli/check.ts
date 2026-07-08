import path from "node:path";
import fs from "node:fs";
import spawn from "cross-spawn";
import { adapterBinary, getCliCheckProbe } from "./adapters.js";
import { getDb } from "./db.js";
import { safeSendToWebContents } from "./ipcSend.js";

const CODEX_ACP_UPGRADE_REQUIRED = "codex-acp requires @agentclientprotocol/codex-acp";

export interface CliCheckResult {
  installed: boolean;
  path?: string;
  version?: string;
}

function which(
  bin: string,
  env?: Record<string, string>
): Promise<string | undefined> {
  const mergedEnv = { ...process.env, ...(env || {}) };
  const isWindows = process.platform === "win32";
  if (path.isAbsolute(bin)) {
    try {
      if (fs.existsSync(bin)) return Promise.resolve(bin);
      if (isWindows) {
        for (const ext of [".cmd", ".exe", ".bat", ".ps1"]) {
          if (fs.existsSync(bin + ext)) return Promise.resolve(bin + ext);
        }
      }
    } catch {}
  }

  return new Promise((resolve) => {
    const cmd = isWindows ? "where" : "which";
    const child = spawn(cmd, [bin], { env: mergedEnv });
    let out = "";
    child.stdout!.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code === 0) {
        const found = out.split(/\r?\n/).find(Boolean);
        if (found) return resolve(found);
      }

      // Fallback search if the desktop app inherited a narrower PATH.
      if (isWindows) {
        try {
          const appData = mergedEnv.APPDATA;
          const localAppData = mergedEnv.LOCALAPPDATA;
          const userProfile = mergedEnv.USERPROFILE || "";
          const programFiles = mergedEnv.ProgramFiles || "C:\\Program Files";
          const programFilesX86 = mergedEnv["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

          const searchDirs: string[] = [];
          if (appData) searchDirs.push(path.join(appData, "npm"));
          if (localAppData) {
            searchDirs.push(path.join(localAppData, "pnpm"));
            searchDirs.push(path.join(localAppData, "fnm_multishells"));
            searchDirs.push(path.join(localAppData, "yarn", "bin"));
          }
          if (userProfile) {
            searchDirs.push(path.join(userProfile, "scoop", "shims"));
            searchDirs.push(path.join(userProfile, ".bun", "bin"));
          }
          searchDirs.push(path.join(programFiles, "nodejs"));
          searchDirs.push(path.join(programFilesX86, "nodejs"));

          const exts = [".cmd", ".exe", ".bat", ".ps1", ""];
          for (const dir of searchDirs) {
            for (const ext of exts) {
              const fullPath = path.join(dir, bin + ext);
              if (fs.existsSync(fullPath)) {
                return resolve(fullPath);
              }
            }
          }
        } catch {}
      } else {
        try {
          const home = mergedEnv.HOME || "";
          const searchDirs = [
            ...(mergedEnv.PATH || "").split(path.delimiter),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            ...(home ? [path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin")] : [])
          ].filter(Boolean);

          for (const dir of searchDirs) {
            const fullPath = path.join(dir, bin);
            if (fs.existsSync(fullPath)) {
              return resolve(fullPath);
            }
          }
        } catch {}
      }

      resolve(undefined);
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

function runCheckProbe(
  bin: string,
  args: string[],
  env?: Record<string, string>
): Promise<CliProbeResult> {
  return new Promise((resolve) => {
    const mergedEnv = { ...process.env, ...(env || {}) };
    const child = spawn(bin, args, { env: mergedEnv });
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
  binary?: string,
  env?: Record<string, string>,
  runtimeAdapter?: string
): Promise<CliCheckResult> {
  const runtimeKey = runtimeAdapter?.trim() || adapter;
  const bin = binary?.trim() || adapterBinary(adapter) || adapter;
  const resolved = await which(bin, env);
  if (!resolved) {
    upsertRuntime(runtimeKey, false, undefined, undefined, "binary not found");
    return { installed: false };
  }
  const probe = getCliCheckProbe(adapter);
  const probeResult = await runCheckProbe(resolved, probe.args, env);
  if (!probeResult.ok || (!probe.versionOptional && !probeResult.output)) {
    const error =
      adapter === "codex-acp"
        ? CODEX_ACP_UPGRADE_REQUIRED
        : `binary found but ${probe.args.join(" ")} failed; try reinstalling`;
    upsertRuntime(
      runtimeKey,
      false,
      resolved,
      undefined,
      error
    );
    return { installed: false };
  }
  const result: CliCheckResult = {
    installed: true,
    path: resolved,
    version: probe.versionOptional ? undefined : probeResult.output
  };
  upsertRuntime(runtimeKey, true, resolved, result.version);
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

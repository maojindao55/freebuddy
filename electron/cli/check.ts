import { spawn } from "node:child_process";
import { adapterBinary } from "./adapters.js";
import { getDb } from "./db.js";

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
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0) return resolve(undefined);
      resolve(out.split(/\r?\n/).find(Boolean));
    });
  });
}

function runVersion(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { env: process.env });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 5000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
      resolve(first?.trim());
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
  const version = await runVersion(resolved);
  const result: CliCheckResult = {
    installed: true,
    path: resolved,
    version
  };
  upsertRuntime(adapter, true, resolved, version);
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
    const shell =
      process.platform === "win32"
        ? "cmd"
        : process.env.SHELL || "/bin/sh";
    const args = process.platform === "win32" ? ["/C", trimmed] : ["-lc", trimmed];
    const child = spawn(shell, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
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

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";

import {
  buildTokscaleDailyUsageArgs,
  buildTokscaleHourlyUsageArgs,
  buildTokscaleUsageArgs,
  parseTokscaleDailyUsageReport,
  parseTokscaleHourlyUsageReport,
  parseTokscaleUsageReport,
  type AgentUsagePeriod,
  type TokscaleDailyUsageReport,
  type TokscaleHourlyUsageReport,
  type TokscaleClient,
  type TokscaleUsageReport
} from "./usageCore.js";
import {
  backfillAgentUsageSessions,
  clearCursorUsageSnapshots,
  listUsageScanClients,
  setUsageScanState,
  storeTokscaleDailyUsageReport,
  storeTokscaleHourlyUsageReport,
  storeTokscaleUsagePeriodReport,
  storeTokscaleUsageReport,
  type StoredUsageScanResult
} from "./usageStore.js";

const require = createRequire(import.meta.url);
const SCAN_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 2_000;
const CURSOR_SYNC_TIMEOUT_MS = 30_000;
const CURSOR_COMMAND_OUTPUT_LIMIT = 1024 * 1024;

function platformPackageName(): string | undefined {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "@tokscale/cli-darwin-arm64";
    if (process.arch === "x64") return "@tokscale/cli-darwin-x64";
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "@tokscale/cli-win32-arm64-msvc";
    if (process.arch === "x64") return "@tokscale/cli-win32-x64-msvc";
  }
  if (process.platform === "linux") {
    const libc = process.env.TOKSCALE_LIBC?.toLowerCase() === "musl" ? "musl" : "gnu";
    if (process.arch === "arm64") return `@tokscale/cli-linux-arm64-${libc}`;
    if (process.arch === "x64") return `@tokscale/cli-linux-x64-${libc}`;
  }
  return undefined;
}

function asarUnpackedPath(file: string): string {
  return file.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
}

export function resolveTokscaleBinary(): string {
  const packageName = platformPackageName();
  if (!packageName) {
    throw new Error(`tokscale does not support ${process.platform}/${process.arch}`);
  }
  const binaryName = process.platform === "win32" ? "tokscale.exe" : "tokscale";
  if (typeof process.resourcesPath === "string") {
    const packagedBinary = path.join(process.resourcesPath, "tokscale", binaryName);
    if (fs.existsSync(packagedBinary)) return packagedBinary;
  }
  let resolved: string;
  try {
    resolved = require.resolve(`${packageName}/bin/${binaryName}`);
  } catch {
    throw new Error(`Bundled tokscale binary is missing (${packageName})`);
  }
  const executable = asarUnpackedPath(resolved);
  if (!fs.existsSync(executable)) {
    throw new Error(`Bundled tokscale binary was not found at ${executable}`);
  }
  return executable;
}

export interface TokscaleRunnerOptions {
  binary?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  period?: AgentUsagePeriod;
  now?: Date;
}

interface CursorCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CursorUsageStatus {
  connected: boolean;
  accounts: Array<{ name: string; active: boolean }>;
}

function cursorConfigRoot(): string {
  return process.env.TOKSCALE_CONFIG_DIR?.trim()
    || path.join(os.homedir(), ".config", "tokscale");
}

function runCursorCommand(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<CursorCommandResult> {
  const binary = resolveTokscaleBinary();
  return new Promise((resolve) => {
    const child = spawn(binary, ["cursor", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    };
    const keep = (target: Buffer[], chunk: Buffer) => {
      if (outputBytes >= CURSOR_COMMAND_OUTPUT_LIMIT) return;
      const kept = chunk.subarray(0, CURSOR_COMMAND_OUTPUT_LIMIT - outputBytes);
      target.push(kept);
      outputBytes += kept.length;
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, options.timeoutMs ?? CURSOR_SYNC_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on("data", (chunk: Buffer) => keep(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => keep(stderr, chunk));
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
    child.stdin.end();
  });
}

function runCursorLoginCommand(args: string[], token: string): Promise<CursorCommandResult> {
  const binary = resolveTokscaleBinary();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value != null) env[name] = value;
  }

  return new Promise((resolve) => {
    let terminal: pty.IPty;
    let output = "";
    let tokenSent = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout: output, stderr: "" });
    };
    const timeout = setTimeout(() => {
      try {
        terminal.kill();
      } catch {
        // The terminal may already have exited.
      }
      finish(null);
    }, CURSOR_SYNC_TIMEOUT_MS);
    timeout.unref?.();

    try {
      terminal = pty.spawn(binary, ["cursor", ...args], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env
      });
    } catch {
      finish(null);
      return;
    }

    terminal.onData((data) => {
      output = `${output}${data}`.slice(-CURSOR_COMMAND_OUTPUT_LIMIT);
      if (!tokenSent && /WorkosCursorSessionToken value:/i.test(output)) {
        tokenSent = true;
        terminal.write(`${token}\r`);
      }
    });
    terminal.onExit(({ exitCode }) => finish(exitCode));
  });
}

export async function getCursorUsageStatus(): Promise<CursorUsageStatus> {
  const result = await runCursorCommand(["accounts", "--json"]);
  if (result.exitCode !== 0) return { connected: false, accounts: [] };
  try {
    const payload = JSON.parse(result.stdout) as { accounts?: unknown[] };
    const accounts = Array.isArray(payload.accounts)
      ? payload.accounts.map((raw, index) => {
          const account = raw && typeof raw === "object"
            ? raw as Record<string, unknown>
            : {};
          const name = String(
            account.name ?? account.label ?? account.email ?? account.id ?? `Cursor ${index + 1}`
          );
          return {
            name,
            active: Boolean(account.active ?? account.isActive ?? account.current)
          };
        })
      : [];
    return { connected: accounts.length > 0, accounts };
  } catch {
    return { connected: false, accounts: [] };
  }
}

export async function connectCursorUsage(input: {
  token: string;
  accountName?: string;
}): Promise<CursorUsageStatus> {
  const token = input.token?.trim();
  const accountName = input.accountName?.trim();
  if (!token || token.length > 8_192 || /[\r\n]/.test(token)) {
    throw new Error("cursor_usage_invalid_token");
  }
  if (accountName && (accountName.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(accountName))) {
    throw new Error("cursor_usage_invalid_account_name");
  }
  const args = ["login", ...(accountName ? ["--name", accountName] : [])];
  const result = await runCursorLoginCommand(args, token);
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    throw new Error(/invalid|expired/i.test(output)
      ? "cursor_usage_invalid_token"
      : "cursor_usage_login_failed");
  }
  const status = await getCursorUsageStatus();
  return status.connected
    ? status
    : {
        connected: true,
        accounts: [{ name: accountName || "Cursor", active: true }]
      };
}

export async function disconnectCursorUsage(): Promise<CursorUsageStatus> {
  const result = await runCursorCommand(["logout", "--all", "--purge-cache"]);
  if (result.exitCode !== 0) throw new Error("cursor_usage_logout_failed");
  clearCursorUsageSnapshots();
  return { connected: false, accounts: [] };
}

async function syncCursorUsageCache(binary: string): Promise<void> {
  const configRoot = cursorConfigRoot();
  if (!fs.existsSync(path.join(configRoot, "cursor-credentials.json"))) return;

  await new Promise<void>((resolve) => {
    const child = spawn(binary, ["cursor", "sync", "--json"], {
      stdio: "ignore",
      windowsHide: true,
      env: process.env
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, CURSOR_SYNC_TIMEOUT_MS);
    timeout.unref?.();
    child.once("error", finish);
    child.once("close", finish);
  });
}

function runTokscaleJsonReport<T>(
  args: string[],
  parse: (stdout: string) => T,
  label: string,
  options: TokscaleRunnerOptions
): Promise<T> {
  const binary = options.binary ?? resolveTokscaleBinary();
  return new Promise<T>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...options.env,
        TOKSCALE_PRICING_CACHE_ONLY: "1"
      }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error?: Error, report?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(report as T);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`tokscale ${label} scan timed out`));
    }, options.timeoutMs ?? SCAN_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill();
        finish(new Error(`tokscale ${label} report exceeded 64 MB`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 16_384) return;
      const kept = chunk.subarray(0, 16_384 - stderrBytes);
      stderr.push(kept);
      stderrBytes += kept.length;
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(-2_000);
        finish(
          new Error(
            detail
              ? `tokscale ${label} exited with code ${code}: ${detail}`
              : `tokscale ${label} exited with code ${code}`
          )
        );
        return;
      }
      try {
        finish(undefined, parse(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function runTokscaleUsageReport(
  clients: readonly TokscaleClient[],
  options: TokscaleRunnerOptions = {}
): Promise<TokscaleUsageReport> {
  return runTokscaleJsonReport(
    buildTokscaleUsageArgs(clients, options.period ?? "all", options.now),
    parseTokscaleUsageReport,
    "usage",
    options
  );
}

export async function runTokscaleDailyUsageReport(
  clients: readonly TokscaleClient[],
  options: TokscaleRunnerOptions = {}
): Promise<TokscaleDailyUsageReport> {
  return runTokscaleJsonReport(
    buildTokscaleDailyUsageArgs(clients, options.period ?? "all", options.now),
    parseTokscaleDailyUsageReport,
    "graph",
    options
  );
}

export async function runTokscaleHourlyUsageReport(
  clients: readonly TokscaleClient[],
  options: TokscaleRunnerOptions = {}
): Promise<TokscaleHourlyUsageReport> {
  return runTokscaleJsonReport(
    buildTokscaleHourlyUsageArgs(clients),
    parseTokscaleHourlyUsageReport,
    "hourly usage",
    options
  );
}

let activeScan: {
  period: AgentUsagePeriod;
  promise: Promise<StoredUsageScanResult>;
} | null = null;
let scheduledScan: NodeJS.Timeout | null = null;
let rescanRequested = false;

export function reconcileAgentUsage(
  period: AgentUsagePeriod = "all"
): Promise<StoredUsageScanResult> {
  if (activeScan) {
    if (activeScan.period === period) return activeScan.promise;
    return activeScan.promise
      .catch(() => undefined)
      .then(() => reconcileAgentUsage(period));
  }
  let promise!: Promise<StoredUsageScanResult>;
  promise = (async () => {
    const clients = listUsageScanClients();
    const startedAt = new Date().toISOString();
    setUsageScanState(period, "running", { startedAt });
    try {
      if (!clients.length) {
        const empty = { reportEntries: 0, attributedEntries: 0, attributedSessions: 0 };
        storeTokscaleDailyUsageReport(period, { entries: [] });
        if (period === "today") storeTokscaleHourlyUsageReport({ entries: [] });
        if (period !== "all") {
          storeTokscaleUsagePeriodReport(period, { entries: [] });
        }
        setUsageScanState(period, "ok", {
          startedAt,
          completedAt: new Date().toISOString()
        });
        return empty;
      }
      const binary = resolveTokscaleBinary();
      if (clients.includes("cursor")) await syncCursorUsageCache(binary);
      const [report, dailyReport, hourlyReport] = await Promise.all([
        runTokscaleUsageReport(clients, { period, binary }),
        runTokscaleDailyUsageReport(clients, { period, binary }),
        period === "today"
          ? runTokscaleHourlyUsageReport(clients, { period, binary })
          : Promise.resolve(undefined)
      ]);
      const result = period === "all"
        ? storeTokscaleUsageReport(report)
        : storeTokscaleUsagePeriodReport(period, report);
      storeTokscaleDailyUsageReport(period, dailyReport);
      if (hourlyReport) storeTokscaleHourlyUsageReport(hourlyReport);
      setUsageScanState(period, "ok", {
        startedAt,
        completedAt: new Date().toISOString()
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUsageScanState(period, "error", {
        startedAt,
        completedAt: new Date().toISOString(),
        error: message.slice(0, 2_000)
      });
      throw error;
    }
  })().finally(() => {
    if (activeScan?.promise === promise) activeScan = null;
    if (rescanRequested) {
      rescanRequested = false;
      scheduleAgentUsageReconciliation(0);
    }
  });
  activeScan = { period, promise };
  return promise;
}

export function scheduleAgentUsageReconciliation(
  delayMs = DEFAULT_DEBOUNCE_MS
): void {
  if (scheduledScan) clearTimeout(scheduledScan);
  scheduledScan = setTimeout(() => {
    scheduledScan = null;
    if (activeScan) {
      rescanRequested = true;
      return;
    }
    void reconcileAgentUsage("all").catch((error) => {
      console.warn("[usage] tokscale reconciliation failed:", error);
    });
  }, delayMs);
  scheduledScan.unref?.();
}

export function initializeAgentUsageReconciler(): void {
  backfillAgentUsageSessions();
  scheduleAgentUsageReconciliation(5_000);
}

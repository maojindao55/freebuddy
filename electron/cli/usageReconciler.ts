import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  buildTokscaleUsageArgs,
  parseTokscaleUsageReport,
  type AgentUsagePeriod,
  type TokscaleClient,
  type TokscaleUsageReport
} from "./usageCore.js";
import {
  backfillAgentUsageSessions,
  listLinkedTokscaleClients,
  setUsageScanState,
  storeTokscaleUsagePeriodReport,
  storeTokscaleUsageReport,
  type StoredUsageScanResult
} from "./usageStore.js";

const require = createRequire(import.meta.url);
const SCAN_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 2_000;

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

export async function runTokscaleUsageReport(
  clients: readonly TokscaleClient[],
  options: TokscaleRunnerOptions = {}
): Promise<TokscaleUsageReport> {
  const binary = options.binary ?? resolveTokscaleBinary();
  const args = buildTokscaleUsageArgs(
    clients,
    options.period ?? "all",
    options.now
  );

  return new Promise<TokscaleUsageReport>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...options.env,
        // Usage collection should remain local and deterministic. A missing
        // pricing cache yields zero cost without blocking token collection.
        TOKSCALE_PRICING_CACHE_ONLY: "1"
      }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error?: Error, report?: TokscaleUsageReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(report as TokscaleUsageReport);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("tokscale usage scan timed out"));
    }, options.timeoutMs ?? SCAN_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill();
        finish(new Error("tokscale usage report exceeded 64 MB"));
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
              ? `tokscale exited with code ${code}: ${detail}`
              : `tokscale exited with code ${code}`
          )
        );
        return;
      }
      try {
        finish(
          undefined,
          parseTokscaleUsageReport(Buffer.concat(stdout).toString("utf8"))
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
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
    const clients = listLinkedTokscaleClients();
    const startedAt = new Date().toISOString();
    setUsageScanState(period, "running", { startedAt });
    try {
      if (!clients.length) {
        const empty = { reportEntries: 0, attributedEntries: 0, attributedSessions: 0 };
        if (period !== "all") {
          storeTokscaleUsagePeriodReport(period, { entries: [] });
        }
        setUsageScanState(period, "ok", {
          startedAt,
          completedAt: new Date().toISOString()
        });
        return empty;
      }
      const report = await runTokscaleUsageReport(clients, { period });
      const result = period === "all"
        ? storeTokscaleUsageReport(report)
        : storeTokscaleUsagePeriodReport(period, report);
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

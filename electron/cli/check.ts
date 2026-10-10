import path from "node:path";
import fs from "node:fs";
import spawn from "cross-spawn";
import { BrowserWindow } from "electron";
import {
  adapterBinary,
  applyDshAcpNpmInstallEnv,
  bundledDshAcpConfigPath,
  cleanDshAcpManagedNodeModules,
  dshAcpCompositionReady,
  dshAcpInstallCommand,
  dshAcpManagedDemoBin,
  dshAcpManagedRoot,
  dshAcpWindowsResiduePath,
  DSH_ACP_PLUGIN_TREE_MISSING,
  getCliCheckProbe,
  getAdapterDefinition,
  cliAdapterDefinitions,
  quoteForShell,
  isDefaultDshAcpBinary,
  patchDshAcpManagedRuntime,
  syncDshAcpManagedConfig,
  windowsExtendedPath
} from "./adapters.js";
import { resolvePiAcpRuntime } from "./piRuntime.js";
import { ensurePackagedPiRuntime } from "./piRuntimePackage.js";
import { getDataDir, getDb } from "./db.js";
import { safeSendToWebContents } from "./ipcSend.js";
import { compareSemver, extractSemver } from "./version.js";
import { trackTelemetryEvent } from "../telemetry.js";
import {
  categorizeTelemetryError,
  normalizeTelemetryAdapter
} from "../telemetryPrivacy.js";
import {
  getFreshWindowsEnvironment,
  parseWindowsWhereOutput,
  resolveWindowsShellCommand,
  windowsInstallInvocation
} from "./windowsEnv.js";
import { findMacAppCliBinary } from "./macAppCli.js";
import { hasLocalAgentApp } from "./localAgentApps.js";
import { logMain } from "../debugLog.js";
import { getRuntimePackagePolicy, readRuntimePackage } from "./runtimePackages.js";
import { checkRuntimeUpdate, upgradeVerificationError, versionFromProbe, type CliRuntimeUpdateRequest, type CliUpgradePlan, type RuntimeUpdateStatus } from "../shared/cliRuntimeUpdate.js";

const CODEX_ACP_UPGRADE_REQUIRED = "codex-acp requires @agentclientprotocol/codex-acp";
const CODEX_ACP_ADAPTER = "codex-acp";
const CODEX_CLI_ADAPTER = "codex";
const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp";
const CODEX_CLI_PACKAGE = "@openai/codex";
const CODEX_CLI_FOUND_ACP_MISSING = "codex cli found; acp adapter missing";
const CLAUDE_CLI_FOUND_ACP_MISSING = "claude cli found; acp adapter missing";
const DSH_ACP_ADAPTER = "dsh-acp";
const DSH_ACP_PACKAGE = "deepseek-harness-acp";
// Shared throttle for every toolchain auto-update check (codex, dsh-acp, ...).
const TOOLCHAIN_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLI_RUNTIME_CHANNEL = "cli://runtime";

interface CodexUpdateTarget {
  adapter: string;
  packageName: string;
}

const CODEX_UPDATE_TARGETS: CodexUpdateTarget[] = [
  { adapter: CODEX_CLI_ADAPTER, packageName: CODEX_CLI_PACKAGE },
  { adapter: CODEX_ACP_ADAPTER, packageName: CODEX_ACP_PACKAGE }
];

export type CliRuntimeUpdateStatus = RuntimeUpdateStatus;

export interface CliCheckResult {
  installed: boolean;
  path?: string;
  version?: string;
}

function trackAgentSetup(
  adapter: string,
  setupAction: "check" | "install",
  result: "detected" | "missing" | "probe_failed" | "installed" | "failed" | "timeout",
  error?: unknown
): void {
  trackTelemetryEvent("agent_setup_completed", {
    adapter: normalizeTelemetryAdapter(adapter),
    setup_action: setupAction,
    result,
    ...(error === undefined ? {} : { error_category: categorizeTelemetryError(error) })
  });
}

function which(
  bin: string,
  env?: Record<string, string>
): Promise<string | undefined> {
  const mergedEnv = { ...process.env, ...(env || {}) };
  const isWindows = process.platform === "win32";
  const isFile = (candidate: string): boolean => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (path.isAbsolute(bin)) {
    try {
      if (isWindows) {
        for (const ext of [".cmd", ".exe", ".com", ".bat", ".ps1"]) {
          if (isFile(bin + ext)) return Promise.resolve(bin + ext);
        }
      }
      if (isFile(bin)) return Promise.resolve(bin);
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
        const found = isWindows
          ? parseWindowsWhereOutput(out, isFile)
          : out.split(/\r?\n/).find(Boolean);
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
            searchDirs.push(path.join(userProfile, ".local", "bin"));
          }
          searchDirs.push(path.join(programFiles, "nodejs"));
          searchDirs.push(path.join(programFilesX86, "nodejs"));

          const exts = [".cmd", ".exe", ".bat", ".ps1", ""];
          for (const dir of searchDirs) {
            for (const ext of exts) {
              const fullPath = path.join(dir, bin + ext);
              if (isFile(fullPath)) {
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
            ...(home
              ? [
                  path.join(home, ".volta", "bin"),
                  path.join(home, ".local", "bin"),
                  path.join(home, ".npm-global", "bin"),
                  path.join(home, ".bun", "bin")
                ]
              : [])
          ].filter(Boolean);

          for (const dir of searchDirs) {
            const fullPath = path.join(dir, bin);
            if (isFile(fullPath)) {
              return resolve(fullPath);
            }
          }

          const macAppBinary = findMacAppCliBinary(bin, {
            platform: process.platform,
            home,
            isFile
          });
          if (macAppBinary) return resolve(macAppBinary);
        } catch {}
      }

      if (isWindows) {
        void resolveWindowsShellCommand(bin, mergedEnv).then((candidate) => {
          resolve(candidate && isFile(candidate) ? candidate : undefined);
        });
        return;
      }
      resolve(undefined);
    });
  });
}

interface CliProbeResult {
  ok: boolean;
  output?: string;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  timedOut?: boolean;
  spawnError?: string;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
}

function runCheckProbe(
  bin: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs = 15_000
): Promise<CliProbeResult> {
  return new Promise((resolve) => {
    const mergedEnv = { ...process.env, ...(env || {}) };
    const child = spawn(bin, args, { env: mergedEnv });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CliProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout!.on("data", (d) => {
      stdout = (stdout + d.toString()).slice(-64 * 1024);
    });
    child.stderr!.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-64 * 1024);
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        stdout,
        stderr,
        spawnError: error instanceof Error ? error.message : String(error)
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, stdout, stderr, exitCode: code });
        return;
      }
      const stderrOutput = stderr
        .split(/\r?\n/)
        .find((line) => {
          const value = line.trim();
          return (
            value &&
            !/^warn:\s/i.test(value) &&
            !/^https?:\/\//i.test(value) &&
            !/baseline build/i.test(value)
          );
        })
        ?.trim();
      finish({
        ok: true,
        output: firstNonEmptyLine(stdout) ?? stderrOutput,
        stdout,
        stderr,
        exitCode: code
      });
    });
  });
}

function probeFailureMessage(
  adapter: string,
  args: string[],
  result: CliProbeResult
): string {
  const details = `${result.stderr}\n${result.stdout}\n${result.spawnError ?? ""}`;
  if (/CPU lacks AVX support/i.test(details)) {
    return "claude runtime architecture mismatch";
  }
  if (/Claude native binary not found/i.test(details)) {
    return "claude native binary not found";
  }
  if (result.timedOut) return "version probe timed out";
  return adapter === "codex-acp"
    ? CODEX_ACP_UPGRADE_REQUIRED
    : `binary found but ${args.join(" ")} failed; try reinstalling`;
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
         version=COALESCE(excluded.version, CASE WHEN cli_runtimes.binary_path=excluded.binary_path THEN cli_runtimes.version END),
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
  logRuntimeRow({ adapter, installed, version, binaryPath, lastError });
}

function logRuntimeRow(rt: {
  adapter: string;
  installed: boolean;
  version?: string;
  binaryPath?: string;
  lastError?: string;
}): void {
  logMain().info("runtime", "cli runtime", {
    adapter: rt.adapter,
    installed: rt.installed,
    ...(rt.version ? { version: rt.version } : {}),
    ...(rt.binaryPath ? { binaryPath: rt.binaryPath } : {}),
    ...(rt.lastError ? { lastError: rt.lastError } : {})
  });
}

export function logAllCliRuntimes(): void {
  for (const rt of listRuntimes()) logRuntimeRow(rt);
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
  await waitForRuntimeInstall(adapter);
  const runtimeKey = runtimeAdapter?.trim() || adapter;
  const bin = binary?.trim() || adapterBinary(adapter) || adapter;
  const effectiveEnv = await getFreshWindowsEnvironment({
    ...process.env,
    ...(env || {})
  });
  let resolved = await which(bin, effectiveEnv as Record<string, string>);
  // New Qoder CLI releases use `qoder`; do not confuse the IDE launcher
  // with the ACP CLI. Respect explicit custom binaries.
  if (adapter === "qoder-acp" && !resolved && bin === "qodercli") {
    const candidate = await which("qoder", effectiveEnv as Record<string, string>);
    if (candidate) {
      const help = await runCheckProbe(candidate, ["--help"], effectiveEnv as Record<string, string>);
      if (help.ok && /--acp\b/.test(`${help.stdout}\n${help.stderr}`)) resolved = candidate;
    }
  }
  if (adapter === "dsh-acp" && !resolved && (!binary?.trim() || isDefaultDshAcpBinary(binary))) {
    for (const alt of ["deepseek-harness-acp", "dsh-acp", "dsh-acp-demo"]) {
      if (alt === bin) continue;
      const found = await which(alt, effectiveEnv as Record<string, string>);
      if (found) {
        resolved = found;
        break;
      }
    }
  }
  if (adapter === "dsh-acp") {
    const cfgPath = bundledDshAcpConfigPath();
    const managedBin = dshAcpManagedDemoBin(getDataDir());
    if ((!binary?.trim() || isDefaultDshAcpBinary(binary)) && fs.existsSync(managedBin) && dshAcpCompositionReady(managedBin, cfgPath)) {
      const version = readRuntimePackage(managedBin, DSH_ACP_PACKAGE)?.version;
      const result: CliCheckResult = { installed: true, path: managedBin, version };
      upsertRuntime(runtimeKey, true, managedBin, version);
      trackAgentSetup(adapter, "check", "detected");
      return result;
    }
    if (!resolved) {
      const managedBinExists = fs.existsSync(managedBin);
      const err = managedBinExists ? DSH_ACP_PLUGIN_TREE_MISSING : "binary not found";
      upsertRuntime(
        runtimeKey,
        false,
        managedBinExists ? managedBin : undefined,
        undefined,
        err
      );
      trackAgentSetup(adapter, "check", managedBinExists ? "probe_failed" : "missing", err);
      return { installed: false };
    }
    if (!dshAcpCompositionReady(resolved, cfgPath)) {
      upsertRuntime(
        runtimeKey,
        false,
        resolved,
        undefined,
        DSH_ACP_PLUGIN_TREE_MISSING
      );
      trackAgentSetup(adapter, "check", "probe_failed", DSH_ACP_PLUGIN_TREE_MISSING);
      return { installed: false };
    }
    const version = readRuntimePackage(resolved, DSH_ACP_PACKAGE)?.version;
    const result: CliCheckResult = { installed: true, path: resolved, version };
    upsertRuntime(runtimeKey, true, resolved, version);
    trackAgentSetup(adapter, "check", "detected");
    return result;
  }
  if (adapter === "pi-acp") {
    await ensurePackagedPiRuntime(getDataDir());
    // Bundled runtime (pi + pi-acp bridge) shipped as an extraResource takes
    // precedence over a PATH-installed pi-acp; see electron/cli/piRuntime.ts.
    const status = resolvePiAcpRuntime();
    if (status.ready && status.piAcpEntry) {
      const version = status.piAcpVersion ?? status.piVersion;
      upsertRuntime(runtimeKey, true, status.piAcpEntry, version);
      trackAgentSetup(adapter, "check", "detected");
      return {
        installed: true,
        path: status.piAcpEntry,
        ...(version ? { version } : {})
      };
    }
    // Fall through: a user-installed global pi-acp still works via PATH.
  }
  if (!resolved) {
    const nativeCli =
      adapter === "codex-acp"
        ? "codex"
        : adapter === "claude-agent-acp"
          ? "claude"
          : undefined;
    const nativeCliPath = nativeCli
      ? await which(nativeCli, effectiveEnv as Record<string, string>)
      : undefined;
    const error = nativeCliPath
      ? adapter === "codex-acp"
        ? CODEX_CLI_FOUND_ACP_MISSING
        : CLAUDE_CLI_FOUND_ACP_MISSING
      : adapter === "codex-acp" && hasLocalAgentApp("Codex")
        ? "codex app found; acp adapter missing"
        : adapter === "qoder-acp" && hasLocalAgentApp("Qoder")
          ? "qoder app found; cli missing"
          : "binary not found";
    upsertRuntime(runtimeKey, false, undefined, undefined, error);
    trackAgentSetup(adapter, "check", "missing", error);
    return { installed: false };
  }
  const probe = getCliCheckProbe(adapter);
  if (probe.skipSpawn) {
    const result: CliCheckResult = { installed: true, path: resolved };
    upsertRuntime(runtimeKey, true, resolved);
    trackAgentSetup(adapter, "check", "detected");
    return result;
  }
  const probeResult = await runCheckProbe(
    resolved,
    probe.args,
    effectiveEnv as Record<string, string>
  );
  if (!probeResult.ok || (!probe.versionOptional && !probeResult.output)) {
    const error = probeFailureMessage(adapter, probe.args, probeResult);
    upsertRuntime(
      runtimeKey,
      false,
      resolved,
      undefined,
      error
    );
    trackAgentSetup(adapter, "check", "probe_failed", error);
    return { installed: false };
  }
  const policy = getRuntimePackagePolicy(adapter);
  const packageVersion = policy ? readRuntimePackage(resolved, policy.packageName)?.version : undefined;
  const result: CliCheckResult = {
    installed: true,
    path: resolved,
    version: packageVersion ?? (policy?.packageVersionOnly ? undefined : versionFromProbe(probeResult.output, probe.versionOptional))
  };
  upsertRuntime(runtimeKey, true, resolved, result.version);
  if (policy?.packageVersionOnly && !packageVersion) {
    getDb().prepare("UPDATE cli_runtimes SET version = NULL WHERE adapter = ?").run(runtimeKey);
  }
  trackAgentSetup(adapter, "check", "detected");
  return result;
}

export interface CliRuntime {
  adapter: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  latestVersion?: string;
  minimumVersion?: string;
  updateCheckSupported?: boolean;
  updateStatus?: CliRuntimeUpdateStatus;
  lastUpdateCheckAt?: string;
  lastUpdateError?: string;
  lastCheckAt?: string;
  lastRunAt?: string;
  lastError?: string;
  updatedAt: string;
}

export function listRuntimes(): CliRuntime[] {
  const aliases = new Map((getDb().prepare("SELECT id, base_adapter FROM cli_executor_overrides").all() as Array<{ id: string; base_adapter: string | null }>).map(row => [row.id, row.base_adapter]));
  const rows = getDb()
    .prepare(
      `SELECT adapter, installed, binary_path, version, latest_version, update_status,
              last_update_check_at, last_update_error, last_check_at, last_run_at,
              last_error, updated_at
       FROM cli_runtimes ORDER BY adapter`
    )
    .all() as Array<{
    adapter: string;
    installed: number;
    binary_path: string | null;
    version: string | null;
    latest_version: string | null;
    update_status: string | null;
    last_update_check_at: string | null;
    last_update_error: string | null;
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
    latestVersion: r.latest_version ?? undefined,
    minimumVersion: getRuntimePackagePolicy(aliases.get(r.adapter) ?? r.adapter)?.minimumVersion,
    updateCheckSupported: !!getRuntimePackagePolicy(aliases.get(r.adapter) ?? r.adapter),
    updateStatus: (r.update_status as CliRuntimeUpdateStatus | null) ?? undefined,
    lastUpdateCheckAt: r.last_update_check_at ?? undefined,
    lastUpdateError: r.last_update_error ?? undefined,
    lastCheckAt: r.last_check_at ?? undefined,
    lastRunAt: r.last_run_at ?? undefined,
    lastError: r.last_error ?? undefined,
    updatedAt: r.updated_at
  }));
}

function runtimeFor(adapter: string): CliRuntime | undefined {
  return listRuntimes().find((runtime) => runtime.adapter === adapter);
}

function broadcastRuntime(adapter: string): void {
  const runtime = runtimeFor(adapter);
  if (!runtime) return;
  for (const window of BrowserWindow.getAllWindows()) {
    safeSendToWebContents(window.webContents, CLI_RUNTIME_CHANNEL, runtime);
  }
}

function setRuntimeUpdateState(
  adapter: string,
  status: CliRuntimeUpdateStatus,
  options: {
    latestVersion?: string;
    checkedAt?: string;
    error?: string;
  } = {}
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO cli_runtimes
         (adapter, installed, latest_version, update_status, last_update_check_at,
          last_update_error, updated_at)
       VALUES (?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT(adapter) DO UPDATE SET
         latest_version=COALESCE(excluded.latest_version, cli_runtimes.latest_version),
         update_status=excluded.update_status,
         last_update_check_at=COALESCE(excluded.last_update_check_at, cli_runtimes.last_update_check_at),
         last_update_error=excluded.last_update_error,
         updated_at=excluded.updated_at`
    )
    .run(
      adapter,
      options.latestVersion ?? null,
      status,
      options.checkedAt ?? null,
      options.error ?? null,
      now
    );
  broadcastRuntime(adapter);
}

/** Persist initialize metadata for agents whose version probe cannot report it. */
export function recordRuntimeAgentVersion(adapter: string, version: string | undefined, binary?: string): void {
  const parsed = extractSemver(version);
  const runtime = runtimeFor(adapter);
  if (!parsed || !runtime || runtime.updateStatus === "updating" || getRuntimePackagePolicy(adapter)?.packageVersionOnly) return;
  if (binary && path.isAbsolute(binary) && runtime.binaryPath !== binary) return;
  // Package/probe versions identify the detected executable. Do not replace
  // them with a protocol implementation's unrelated SDK or engine version.
  if (extractSemver(runtime.version)) return;
  getDb().prepare("UPDATE cli_runtimes SET version = ?, updated_at = ? WHERE adapter = ?")
    .run(parsed.raw, new Date().toISOString(), adapter);
  broadcastRuntime(adapter);
}

const pendingUpdateChecks = new Map<string, Promise<CliRuntime | undefined>>();

export function cliCheckUpdates(args: CliRuntimeUpdateRequest): Promise<CliRuntime | undefined> {
  const key = args.runtimeAdapter?.trim() || args.adapter;
  const pending = pendingUpdateChecks.get(key);
  if (pending) return args.force ? pending.then(() => cliCheckUpdates(args)) : pending;
  const promise = (async () => {
    const previous = runtimeFor(key);
    if (previous?.updateStatus === "updating" || runtimeInstallationPromises.has(runtimeInstallKey(args.adapter))) return previous;
    const installed = await cliCheck(args.adapter, args.binary, args.env, key);
    const policy = getRuntimePackagePolicy(args.adapter);
    if (!installed.installed || !policy) return runtimeFor(key);
    const snapshot = { ...previous, version: runtimeFor(key)?.version };
    setRuntimeUpdateState(key, "checking");
    const state = await checkRuntimeUpdate(snapshot, () => latestPackageVersion(policy.packageName, args.env), {
      force: args.force || previous?.binaryPath !== installed.path
    });
    if (runtimeInstallationPromises.has(runtimeInstallKey(args.adapter))) return runtimeFor(key);
    const actual = extractSemver(runtimeFor(key)?.version), latest = extractSemver(state.latestVersion);
    if (latest && state.updateStatus !== "error") state.updateStatus = actual && compareSemver(actual, latest) >= 0 ? "current" : "available";
    setRuntimeUpdateState(key, state.updateStatus ?? "idle", {
      latestVersion: state.latestVersion, checkedAt: state.lastUpdateCheckAt, error: state.lastUpdateError
    });
    return runtimeFor(key);
  })().finally(() => pendingUpdateChecks.delete(key));
  pendingUpdateChecks.set(key, promise);
  return promise;
}

/** Passive checks complement existing Codex/DeepSeek update policies. */
export async function startRuntimeUpdateChecks(): Promise<void> {
  await Promise.allSettled([codexToolchainAutoUpdatePromise, dshAcpAutoUpdatePromise]);
  for (const runtime of listRuntimes()) {
    if (!runtime.installed || !getRuntimePackagePolicy(runtime.adapter)) continue;
    try { await cliCheckUpdates({ adapter: runtime.adapter, binary: runtime.binaryPath }); }
    catch (error) { logMain().warn("runtime", "agent update check failed", { adapter: runtime.adapter, error: String(error) }); }
  }
}

function assertRuntimeIdle(adapter: string): void {
  const group = getAdapterDefinition(adapter)?.commandGroup;
  const related = [...new Set([adapter, ...cliAdapterDefinitions.filter(definition => group && definition.commandGroup === group).map(definition => definition.id), ...(group ? [group] : [])])];
  const active = getDb().prepare(`SELECT 1 FROM cli_tasks WHERE status = 'running' AND adapter IN (${related.map(() => "?").join(",")}) LIMIT 1`).get(...related);
  if (active) throw new Error("runtime_in_use");
}

const runtimeInstallationPromises = new Map<string, Promise<void>>();

function runtimeInstallKey(adapter: string): string {
  return getRuntimePackagePolicy(adapter)?.packageName ?? getAdapterDefinition(adapter)?.commandGroup ?? adapter;
}

export async function waitForRuntimeInstall(adapter: string): Promise<void> {
  await runtimeInstallationPromises.get(runtimeInstallKey(adapter));
}

function acquireRuntimeInstall(adapter: string): () => void {
  assertRuntimeIdle(adapter);
  const key = runtimeInstallKey(adapter);
  if (runtimeInstallationPromises.has(key)) throw new Error("runtime_install_in_progress");
  let finish = () => {};
  runtimeInstallationPromises.set(key, new Promise(resolve => { finish = resolve; }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runtimeInstallationPromises.delete(key);
    finish();
  };
}

export async function prepareCliUpgrade(args: CliRuntimeUpdateRequest): Promise<CliUpgradePlan> {
  assertRuntimeIdle(args.adapter);
  const definition = getAdapterDefinition(args.adapter);
  if (!definition?.installHint || args.adapter === "pi-acp") throw new Error("runtime_update_managed_by_app");
  const policy = getRuntimePackagePolicy(args.adapter);
  const runtime = await cliCheckUpdates({ ...args, force: true });
  const plan: CliUpgradePlan = { command: definition.installHint,
    previousVersion: runtime?.installed ? runtime.version : undefined,
    expectedBinaryPath: runtime?.installed ? runtime.binaryPath : undefined };
  if (!policy) return plan;
  if (runtime?.installed && (runtime.updateStatus === "error" || !runtime.latestVersion)) throw new Error("runtime_update_check_failed");
  plan.targetVersion = runtime?.installed ? runtime.latestVersion : await latestPackageVersion(policy.packageName, args.env);
  const current = extractSemver(runtime?.version), target = extractSemver(plan.targetVersion)!;
  if (current && compareSemver(current, target) >= 0) return { ...plan, alreadyCurrent: true };
  if (policy.managed) {
    // The DeepSeek installer also migrates legacy/global installs into the
    // application-managed standalone runtime. Verify that destination.
    plan.expectedBinaryPath = path.join(dshAcpManagedRoot(getDataDir()), "node_modules", policy.packageName, "lib", "bin.js");
    plan.command = dshAcpInstallCommand({ prefix: dshAcpManagedRoot(getDataDir()), version: plan.targetVersion });
  } else {
    const pkg = readRuntimePackage(runtime?.binaryPath, policy.packageName);
    if (runtime?.installed && !pkg?.prefix) throw new Error("runtime_install_source_unknown");
    plan.command = definition.installHint.replace(policy.packageName, `${policy.packageName}@${plan.targetVersion}`)
      + (pkg?.prefix ? ` --prefix ${quoteForShell(pkg.prefix)}` : "") + " --no-audit --no-fund";
  }
  return plan;
}

export async function verifyCliUpgrade(args: CliRuntimeUpdateRequest, plan: CliUpgradePlan): Promise<CliCheckResult> {
  await waitForRuntimeInstall(args.adapter);
  const key = args.runtimeAdapter?.trim() || args.adapter;
  const actual = await cliCheck(args.adapter, plan.expectedBinaryPath ?? args.binary, args.env, key);
  const error = upgradeVerificationError(actual, plan, process.platform);
  if (error) {
    setRuntimeUpdateState(key, "error", { error });
    throw new Error(error);
  }
  if (getAdapterDefinition(args.adapter)?.protocol === "acp") {
    const { probeAcpAuthentication } = await import("./acpAuth.js");
    try {
      await probeAcpAuthentication({ agentId: key, adapter: args.adapter, binary: actual.path,
        extraArgs: args.extraArgs, cwd: args.cwd,
        env: await getFreshWindowsEnvironment({ ...process.env, ...args.env }) as Record<string, string> });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      upsertRuntime(key, false, actual.path, actual.version, message);
      setRuntimeUpdateState(key, "error", { error: message });
      throw failure;
    }
  }
  setRuntimeUpdateState(key, plan.alreadyCurrent ? "current" : "updated", { latestVersion: plan.targetVersion, checkedAt: new Date().toISOString() });
  return actual;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  bin: string,
  args: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv, NPM_CONFIG_OFFLINE: "false" };
    const child = spawn(bin, args, { env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr: `${stderr}\ncommand timed out`.trim() });
    }, timeoutMs);
    child.stdout?.on("data", (data) => {
      stdout = (stdout + data.toString()).slice(-64 * 1024);
    });
    child.stderr?.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-64 * 1024);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });
  });
}

function recentSuccessfulUpdateCheck(runtime: CliRuntime | undefined): boolean {
  if (
    !runtime?.lastUpdateCheckAt ||
    (runtime.updateStatus !== "current" && runtime.updateStatus !== "updated")
  ) {
    return false;
  }
  const checkedAt = Date.parse(runtime.lastUpdateCheckAt);
  return (
    Number.isFinite(checkedAt) &&
    Date.now() - checkedAt < TOOLCHAIN_UPDATE_INTERVAL_MS
  );
}

function isNpmManagedBinary(
  binaryPath: string | undefined,
  packageName: string
): boolean {
  return !!readRuntimePackage(binaryPath, packageName)?.prefix;
}

async function latestPackageVersion(packageName: string, extraEnv?: Record<string, string>): Promise<string> {
  const env = await getFreshWindowsEnvironment({ ...process.env, ...extraEnv });
  const npm = await which("npm", env as Record<string, string>);
  if (!npm) throw new Error("Required install tool not found: npm");
  const result = await runProcess(
    npm,
    ["view", packageName, "version", "--json", "--offline=false"],
    30_000,
    env as Record<string, string>
  );
  if (result.code !== 0) {
    throw new Error(firstNonEmptyLine(result.stderr) ?? "npm version check failed");
  }
  const version = extractSemver(result.stdout);
  if (!version) throw new Error(`npm returned an invalid ${packageName} version`);
  return version.raw;
}

async function installPackageVersion(
  packageName: string,
  version: string,
  binaryPath?: string
): Promise<void> {
  const pkg = readRuntimePackage(binaryPath, packageName);
  if (!pkg?.prefix) throw new Error("runtime_install_source_unknown");
  const env = await getFreshWindowsEnvironment(process.env);
  const npm = await which("npm", env as Record<string, string>);
  if (!npm) throw new Error("Required install tool not found: npm");
  const adapter = CODEX_UPDATE_TARGETS.find(target => target.packageName === packageName)?.adapter ?? packageName;
  const release = acquireRuntimeInstall(adapter);
  try {
    const result = await runProcess(
      npm,
      ["install", "-g", "--force", `${packageName}@${version}`, "--prefix", pkg.prefix,
        "--offline=false", "--no-audit", "--no-fund"],
      2 * 60 * 1000,
      env as Record<string, string>
    );
    if (result.code !== 0) {
      throw new Error(firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout) ?? `${packageName} update failed`);
    }
  } finally {
    release();
  }
}

let codexToolchainAutoUpdatePromise: Promise<void> | null = null;

async function runCodexPackageAutoUpdate(
  target: CodexUpdateTarget
): Promise<void> {
  const installed = await cliCheck(target.adapter);
  if (!installed.installed) {
    setRuntimeUpdateState(target.adapter, "idle");
    return;
  }
  if (!isNpmManagedBinary(installed.path, target.packageName)) {
    setRuntimeUpdateState(target.adapter, "idle");
    return;
  }
  const current = extractSemver(installed.version);
  if (!current) {
    setRuntimeUpdateState(target.adapter, "error", {
      error: `Could not read the installed ${target.packageName} version.`
    });
    return;
  }
  if (recentSuccessfulUpdateCheck(runtimeFor(target.adapter))) return;

  setRuntimeUpdateState(target.adapter, "checking");
  const checkedAt = new Date().toISOString();
  try {
    const latestVersion = await latestPackageVersion(target.packageName);
    const latest = extractSemver(latestVersion)!;
    if (compareSemver(current, latest) >= 0) {
      setRuntimeUpdateState(target.adapter, "current", {
        latestVersion,
        checkedAt
      });
      return;
    }

    assertRuntimeIdle(target.adapter);
    setRuntimeUpdateState(target.adapter, "updating", { latestVersion });
    await installPackageVersion(target.packageName, latestVersion, installed.path);
    await verifyCliUpgrade({ adapter: target.adapter, binary: installed.path }, {
      command: "", previousVersion: installed.version, targetVersion: latestVersion,
      expectedBinaryPath: installed.path
    });
    setRuntimeUpdateState(target.adapter, "updated", {
      latestVersion,
      checkedAt
    });
  } catch (error) {
    setRuntimeUpdateState(target.adapter, "error", {
      checkedAt,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function runCodexToolchainAutoUpdate(): Promise<void> {
  for (const target of CODEX_UPDATE_TARGETS) {
    await runCodexPackageAutoUpdate(target);
  }
}

export function startCodexToolchainAutoUpdate(): Promise<void> {
  if (codexToolchainAutoUpdatePromise) return codexToolchainAutoUpdatePromise;
  const promise = runCodexToolchainAutoUpdate().finally(() => {
    if (codexToolchainAutoUpdatePromise === promise) {
      codexToolchainAutoUpdatePromise = null;
    }
  });
  codexToolchainAutoUpdatePromise = promise;
  return promise;
}

/** Read the version FreeBuddy's managed dsh-acp install currently has on disk. */
function readDshAcpManagedVersion(root: string): string | undefined {
  try {
    const pkgPath = path.join(
      root,
      "node_modules",
      DSH_ACP_PACKAGE,
      "package.json"
    );
    if (!fs.existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

let dshAcpAutoUpdatePromise: Promise<void> | null = null;

async function runDshAcpAutoUpdate(): Promise<void> {
  const root = dshAcpManagedRoot(getDataDir());
  const current = extractSemver(readDshAcpManagedVersion(root));
  if (!current) {
    // Nothing managed by FreeBuddy yet (not installed, or a PATH binary is
    // used instead) — there is nothing for us to keep up to date.
    setRuntimeUpdateState(DSH_ACP_ADAPTER, "idle");
    return;
  }
  if (recentSuccessfulUpdateCheck(runtimeFor(DSH_ACP_ADAPTER))) return;

  setRuntimeUpdateState(DSH_ACP_ADAPTER, "checking");
  const checkedAt = new Date().toISOString();
  try {
    const latestVersion = await latestPackageVersion(DSH_ACP_PACKAGE);
    const latest = extractSemver(latestVersion)!;
    if (compareSemver(current, latest) >= 0) {
      setRuntimeUpdateState(DSH_ACP_ADAPTER, "current", {
        latestVersion,
        checkedAt
      });
      return;
    }

    assertRuntimeIdle(DSH_ACP_ADAPTER);
    setRuntimeUpdateState(DSH_ACP_ADAPTER, "updating", { latestVersion });
    // Reuses the managed-install path used by the manual "install" button in
    // Settings, which now wipes node_modules/lockfile first (see
    // cleanDshAcpManagedNodeModules) so sibling packages published under the
    // same floating alpha tag can't drift out of sync with each other.
    const result = await cliInstall("", DSH_ACP_ADAPTER, latestVersion);
    if (!result.success) {
      throw new Error(
        firstNonEmptyLine(result.stderr) ??
          firstNonEmptyLine(result.stdout) ??
          `${DSH_ACP_PACKAGE} update failed`
      );
    }

    await verifyCliUpgrade({ adapter: DSH_ACP_ADAPTER }, {
      command: "", previousVersion: current.raw, targetVersion: latestVersion,
      expectedBinaryPath: dshAcpManagedDemoBin(getDataDir())
    });
    setRuntimeUpdateState(DSH_ACP_ADAPTER, "updated", {
      latestVersion,
      checkedAt
    });
  } catch (error) {
    setRuntimeUpdateState(DSH_ACP_ADAPTER, "error", {
      checkedAt,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export function startDshAcpAutoUpdate(): Promise<void> {
  if (dshAcpAutoUpdatePromise) return dshAcpAutoUpdatePromise;
  const promise = runDshAcpAutoUpdate().finally(() => {
    if (dshAcpAutoUpdatePromise === promise) {
      dshAcpAutoUpdatePromise = null;
    }
  });
  dshAcpAutoUpdatePromise = promise;
  return promise;
}

export async function waitForCodexToolchainAutoUpdate(
  adapter: string
): Promise<void> {
  await waitForRuntimeInstall(adapter);
  if (adapter === DSH_ACP_ADAPTER) {
    await dshAcpAutoUpdatePromise;
    return;
  }
  if (adapter !== CODEX_ACP_ADAPTER && adapter !== CODEX_CLI_ADAPTER) return;
  await codexToolchainAutoUpdatePromise;
}

export interface CliInstallResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

type CliInstallFailureCode =
  | "tool_missing"
  | "node_arch_mismatch"
  | "timeout"
  | "spawn_error";

interface InstallPreflightResult {
  env: NodeJS.ProcessEnv;
  command: string;
  requiresPowerShell?: boolean;
  failureCode?: CliInstallFailureCode;
  failureDetail?: string;
  error?: string;
}

function absoluteInstallCommand(
  command: string,
  executable: string
): Pick<InstallPreflightResult, "command" | "requiresPowerShell"> {
  if (process.platform === "win32") {
    // Keep the command name unquoted on Windows. Passing a quoted absolute
    // path through `cmd /C` makes Node escape the quotes as literal \" bytes
    // for some shim layouts. PATH/PATHEXT will select the resolved .cmd/.exe.
    return windowsInstallInvocation(command, executable);
  }
  const quoted = `'${executable.replace(/'/g, `'"'"'`)}'`;
  return {
    command: command.replace(
      /^(\s*)[^\s|;&]+/,
      (_match, leading: string) => `${leading}${quoted}`
    )
  };
}

function requiredInstallTool(command: string): string | undefined {
  if (process.platform === "win32" && /^(irm|Invoke-)/i.test(command)) {
    return undefined;
  }
  const tool = command.match(/^\s*([^\s|;&]+)/)?.[1];
  if (!tool) return undefined;
  const name = path.basename(tool).toLowerCase();
  return name === "npm" || name === "curl" ? name : undefined;
}

async function isAppleSiliconHardware(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (process.arch === "arm64") return true;
  const result = await runCheckProbe(
    "/usr/sbin/sysctl",
    ["-n", "hw.optional.arm64"],
    undefined,
    3000
  );
  return result.ok && result.output?.trim() === "1";
}

async function prepareInstallEnvironment(
  command: string,
  adapter: string
): Promise<InstallPreflightResult> {
  const tool = requiredInstallTool(command);
  if (!tool) {
    return {
      env: applyDshAcpNpmInstallEnv(adapter, { ...process.env }),
      command
    };
  }

  const env = await getFreshWindowsEnvironment(process.env);
  const executable = await which(tool, env as Record<string, string>);
  if (!executable) {
    return {
      env: { ...process.env },
      command,
      failureCode: "tool_missing",
      failureDetail: tool,
      error: `Required install tool not found: ${tool}`
    };
  }

  env.PATH = [path.dirname(executable), env.PATH || ""]
    .filter(Boolean)
    .join(path.delimiter);
  Object.assign(env, applyDshAcpNpmInstallEnv(adapter, env));

  if (
    tool === "npm" &&
    (adapter === "claude-agent-acp" || adapter === "claude") &&
    (await isAppleSiliconHardware())
  ) {
    const node = await which("node", env as Record<string, string>);
    if (node) {
      const arch = await runCheckProbe(
        node,
        ["-p", "process.arch"],
        env as Record<string, string>,
        5000
      );
      if (arch.ok && arch.output?.trim() === "x64") {
        return {
          env,
          ...absoluteInstallCommand(command, executable),
          failureCode: "node_arch_mismatch",
          failureDetail: node,
          error: "Apple Silicon Mac is using an x64 Node.js runtime"
        };
      }
    }
  }

  return { env, ...absoluteInstallCommand(command, executable) };
}

async function removeDshAcpWindowsResidue(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const target = dshAcpWindowsResiduePath(env);
  if (!target) return;
  await fs.promises
    .rm(windowsExtendedPath(target), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250
    })
    .catch(() => undefined);
}

async function prepareDshAcpManagedInstall(): Promise<void> {
  const root = dshAcpManagedRoot(getDataDir());
  // `@deepseek-ai/*` shims beside the managed prefix resolve upward from the tree and
  // reintroduce the version conflict that demotes the harness plugin subtree.
  await removeDshAcpWindowsResidue();
  // Wipe any existing node_modules/lockfile first so npm re-resolves every package from
  // scratch instead of reusing a stale sibling dependency (see cleanDshAcpManagedNodeModules).
  if (!cleanDshAcpManagedNodeModules(root)) {
    throw new Error(
      `DeepSeek Harness runtime directory is still in use: ${root}. Quit FreeBuddy and retry.`
    );
  }
  syncDshAcpManagedConfig(getDataDir());
}

export function cliInstall(command: string, adapter = "custom", targetVersion?: string): Promise<CliInstallResult> {
  return new Promise((resolve, reject) => {
    let release = () => {};
    void (async () => {
      const trimmed =
        adapter === "dsh-acp" ? dshAcpInstallCommand({ prefix: dshAcpManagedRoot(getDataDir()), version: targetVersion }) : command.trim();
      if (!trimmed) {
        throw new Error("install command required");
      }
      release = acquireRuntimeInstall(adapter);
      if (adapter === "dsh-acp") await prepareDshAcpManagedInstall();

      const isWindows = process.platform === "win32";
      const isPowerShellCommand =
        /^irm\s/i.test(trimmed) ||
        /\|\s*iex\b/i.test(trimmed) ||
        /Invoke-(WebRequest|Expression)/i.test(trimmed) ||
        (isWindows && /"/.test(trimmed));

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

      const env = applyDshAcpNpmInstallEnv(adapter, { ...process.env });
      const child = spawn(shell, args, { env });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let setupTracked = false;
      const reportSetup = (result: "installed" | "failed" | "timeout", error?: unknown) => {
        if (setupTracked) return;
        setupTracked = true;
        trackAgentSetup(adapter, "install", result, error);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 10 * 60 * 1000);
      child.stdout!.on("data", (d) => (stdout += d.toString()));
      child.stderr!.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        release();
        clearTimeout(timer);
        reportSetup("failed", err);
        reject(err);
      });
      child.on("close", (code) => {
        release();
        clearTimeout(timer);
        if (adapter === "dsh-acp" && code === 0) {
          patchDshAcpManagedRuntime(dshAcpManagedRoot(getDataDir()));
        }
        reportSetup(
          timedOut ? "timeout" : code === 0 ? "installed" : "failed",
          timedOut ? "timeout" : code === 0 ? undefined : `process exited ${code ?? "unknown"}`
        );
        resolve({
          success: code === 0,
          exitCode: code,
          stdout,
          stderr
        });
      });
    })().catch(error => { release(); reject(error); });
  });
}

export function cliInstallStream(
  command: string,
  webContents?: Electron.WebContents | null,
  adapter = "custom",
  requestId = adapter,
  targetVersion?: string
): Promise<CliInstallResult> {
  return new Promise((resolve, reject) => {
    let release = () => {};
    const channel = "cli://install";
    const send = (payload: Record<string, unknown>) => {
      safeSendToWebContents(webContents, channel, { ...payload, requestId });
    };
    void (async () => {
      const trimmed = adapter === "dsh-acp"
        ? dshAcpInstallCommand({ prefix: dshAcpManagedRoot(getDataDir()), version: targetVersion })
        : command.trim();
      if (!trimmed) throw new Error("install command required");

      const preflight = await prepareInstallEnvironment(trimmed, adapter);
      if (preflight.failureCode) {
        const error = preflight.error || "Install environment check failed";
        const exitCode = preflight.failureCode === "tool_missing" ? 127 : 1;
        trackAgentSetup(adapter, "install", "failed", preflight.failureCode);
        send({ type: "stderr", content: `${error}\n` });
        send({
          type: "done",
          exitCode,
          failureCode: preflight.failureCode,
          failureDetail: preflight.failureDetail
        });
        resolve({ success: false, exitCode, stdout: "", stderr: error });
        return;
      }

      release = acquireRuntimeInstall(adapter);
      if (adapter === "dsh-acp") await prepareDshAcpManagedInstall();
      const installCommand = preflight.command;
      const isWindows = process.platform === "win32";
      const isPowerShellCommand =
        preflight.requiresPowerShell ||
        /^irm\s/i.test(installCommand) ||
        /\|\s*iex\b/i.test(installCommand) ||
        /Invoke-(WebRequest|Expression)/i.test(installCommand) ||
        (isWindows && /"/.test(installCommand));

      let shell: string;
      let args: string[];
      if (isWindows && isPowerShellCommand) {
        shell = "powershell";
        args = [
          "-ExecutionPolicy", "Bypass",
          "-OutputFormat", "Text",
          "-Command",
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; " +
            installCommand
        ];
      } else if (isWindows) {
        shell = "cmd";
        args = ["/C", installCommand];
      } else {
        shell = process.env.SHELL || "/bin/sh";
        args = ["-lc", installCommand];
      }

      const child = spawn(shell, args, { env: preflight.env });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let setupTracked = false;
      const reportSetup = (
        result: "installed" | "failed" | "timeout",
        error?: unknown
      ) => {
        if (setupTracked) return;
        setupTracked = true;
        trackAgentSetup(adapter, "install", result, error);
      };
      const complete = (
        exitCode: number | null,
        failureCode?: CliInstallFailureCode,
        failureDetail?: string
      ) => {
        if (settled) return;
        settled = true;
        release();
        clearTimeout(timer);
        send({ type: "done", exitCode, failureCode, failureDetail });
        resolve({ success: exitCode === 0, exitCode, stdout, stderr });
      };
      const timer = setTimeout(() => {
        child.kill();
        const message = "Install timed out after 10 minutes.";
        stderr = `${stderr}\n${message}`.trim();
        reportSetup("timeout", "timeout");
        send({ type: "stderr", content: `${message}\n` });
        complete(1, "timeout");
      }, 10 * 60 * 1000);

      child.stdout!.on("data", (d) => {
        const chunk = d.toString();
        stdout = (stdout + chunk).slice(-80_000);
        send({ type: "stdout", content: chunk });
      });
      child.stderr!.on("data", (d) => {
        const chunk = d.toString();
        stderr = (stderr + chunk).slice(-80_000);
        send({ type: "stderr", content: chunk });
      });
      child.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        stderr = `${stderr}\n${message}`.trim();
        reportSetup("failed", err);
        send({ type: "stderr", content: `${message}\n` });
        complete(1, "spawn_error", message);
      });
      child.on("close", (code) => {
        if (settled) return;
        if (adapter === "dsh-acp" && code === 0) {
          patchDshAcpManagedRuntime(dshAcpManagedRoot(getDataDir()));
        }
        reportSetup(
          code === 0 ? "installed" : "failed",
          code === 0 ? undefined : `process exited ${code ?? "unknown"}`
        );
        complete(code);
      });
    })().catch(error => { release(); reject(error); });
  });
}

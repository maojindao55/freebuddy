import path from "node:path";
import fs from "node:fs";
import spawn from "cross-spawn";
import { BrowserWindow } from "electron";
import { adapterBinary, getCliCheckProbe } from "./adapters.js";
import { getDb } from "./db.js";
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

const CODEX_ACP_UPGRADE_REQUIRED = "codex-acp requires @agentclientprotocol/codex-acp";
const CODEX_ACP_ADAPTER = "codex-acp";
const CODEX_CLI_ADAPTER = "codex";
const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp";
const CODEX_CLI_PACKAGE = "@openai/codex";
const CODEX_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLI_RUNTIME_CHANNEL = "cli://runtime";

interface CodexUpdateTarget {
  adapter: string;
  packageName: string;
}

const CODEX_UPDATE_TARGETS: CodexUpdateTarget[] = [
  { adapter: CODEX_CLI_ADAPTER, packageName: CODEX_CLI_PACKAGE },
  { adapter: CODEX_ACP_ADAPTER, packageName: CODEX_ACP_PACKAGE }
];

export type CliRuntimeUpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "updating"
  | "updated"
  | "error";

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
  const effectiveEnv = await getFreshWindowsEnvironment({
    ...process.env,
    ...(env || {})
  });
  const resolved = await which(bin, effectiveEnv as Record<string, string>);
  if (!resolved) {
    upsertRuntime(runtimeKey, false, undefined, undefined, "binary not found");
    trackAgentSetup(adapter, "check", "missing", "binary not found");
    return { installed: false };
  }
  const probe = getCliCheckProbe(adapter);
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
  const result: CliCheckResult = {
    installed: true,
    path: resolved,
    version: probe.versionOptional ? undefined : probeResult.output
  };
  upsertRuntime(runtimeKey, true, resolved, result.version);
  trackAgentSetup(adapter, "check", "detected");
  return result;
}

export interface CliRuntime {
  adapter: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  latestVersion?: string;
  updateStatus?: CliRuntimeUpdateStatus;
  lastUpdateCheckAt?: string;
  lastUpdateError?: string;
  lastCheckAt?: string;
  lastRunAt?: string;
  lastError?: string;
  updatedAt: string;
}

export function listRuntimes(): CliRuntime[] {
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

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NPM_CONFIG_OFFLINE: "false" };
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
    Date.now() - checkedAt < CODEX_UPDATE_INTERVAL_MS
  );
}

function isNpmManagedBinary(
  binaryPath: string | undefined,
  packageName: string
): boolean {
  if (!binaryPath) return false;
  const candidates = [binaryPath];
  try {
    candidates.push(fs.realpathSync(binaryPath));
  } catch {
    /* Windows npm shims are regular command files, not symlinks. */
  }
  const packagePath = `/node_modules/${packageName.toLowerCase()}/`;
  return candidates.some((candidate) => {
    const normalized = candidate.replace(/\\/g, "/").toLowerCase();
    return (
      normalized.includes(packagePath) ||
      (process.platform === "win32" &&
        normalized.includes("/appdata/roaming/npm/"))
    );
  });
}

async function latestPackageVersion(packageName: string): Promise<string> {
  const result = await runProcess(
    "npm",
    ["view", packageName, "version", "--json", "--offline=false"],
    30_000
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
  version: string
): Promise<void> {
  const result = await runProcess(
    "npm",
    [
      "install",
      "-g",
      "--force",
      `${packageName}@${version}`,
      "--offline=false",
      "--no-audit",
      "--no-fund"
    ],
    2 * 60 * 1000
  );
  if (result.code !== 0) {
    throw new Error(
      firstNonEmptyLine(result.stderr) ??
        firstNonEmptyLine(result.stdout) ??
        `${packageName} update failed`
    );
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

    setRuntimeUpdateState(target.adapter, "updating", { latestVersion });
    await installPackageVersion(target.packageName, latestVersion);
    const verified = await cliCheck(target.adapter);
    const verifiedVersion = extractSemver(verified.version);
    if (
      !verified.installed ||
      !verifiedVersion ||
      compareSemver(verifiedVersion, latest) < 0
    ) {
      throw new Error(
        `${target.packageName} update completed but the new version was not detected`
      );
    }
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

export async function waitForCodexToolchainAutoUpdate(
  adapter: string
): Promise<void> {
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
  if (!tool) return { env: { ...process.env }, command };

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

export function cliInstall(command: string, adapter = "custom"): Promise<CliInstallResult> {
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
      clearTimeout(timer);
      reportSetup("failed", err);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
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
  });
}

export function cliInstallStream(
  command: string,
  webContents?: Electron.WebContents | null,
  adapter = "custom",
  requestId = adapter
): Promise<CliInstallResult> {
  return new Promise((resolve, reject) => {
    const channel = "cli://install";
    const send = (payload: Record<string, unknown>) => {
      safeSendToWebContents(webContents, channel, { ...payload, requestId });
    };
    void (async () => {
      const trimmed = command.trim();
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

      const installCommand = preflight.command;
      const isWindows = process.platform === "win32";
      const isPowerShellCommand =
        preflight.requiresPowerShell ||
        /^irm\s/i.test(installCommand) ||
        /\|\s*iex\b/i.test(installCommand) ||
        /Invoke-(WebRequest|Expression)/i.test(installCommand);

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
        reportSetup(
          code === 0 ? "installed" : "failed",
          code === 0 ? undefined : `process exited ${code ?? "unknown"}`
        );
        complete(code);
      });
    })().catch(reject);
  });
}

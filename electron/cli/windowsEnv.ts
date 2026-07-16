import fs from "node:fs";
import path from "node:path";
import spawn from "cross-spawn";

const WINDOWS_PATH_QUERY = [
  "$machine=[Environment]::GetEnvironmentVariable('Path','Machine')",
  "$user=[Environment]::GetEnvironmentVariable('Path','User')",
  "$nvmHome=[Environment]::GetEnvironmentVariable('NVM_HOME','User')",
  "$nvmSymlink=[Environment]::GetEnvironmentVariable('NVM_SYMLINK','User')",
  "@($machine,$user,$nvmHome,$nvmSymlink)|ConvertTo-Json -Compress"
].join(";");

const COMMAND_RESULT_MARKER = "__FREEBUDDY_COMMAND__";

function windowsPowerShell(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

function runPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
  options: { loadProfile?: boolean; timeoutMs?: number } = {}
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const args = ["-NoLogo", "-NonInteractive"];
    if (!options.loadProfile) args.push("-NoProfile");
    args.push(
      "-OutputFormat",
      "Text",
      "-Command",
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${script}`
    );
    const child = spawn(
      windowsPowerShell(env),
      args,
      { env }
    );
    let stdout = "";
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, options.timeoutMs ?? 5000);
    child.stdout?.on("data", (data) => {
      stdout = (stdout + data.toString()).slice(-64 * 1024);
    });
    child.on("error", () => finish());
    child.on("close", (code) => finish(code === 0 ? stdout.trim() : undefined));
  });
}

export function mergeWindowsPath(...values: Array<string | undefined>): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const rawEntry of (value || "").split(";")) {
      const trimmed = rawEntry.trim();
      const entry =
        trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
          ? trimmed.slice(1, -1).trim()
          : trimmed;
      if (!entry) continue;
      const key = entry.replace(/[\\/]+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries.join(";");
}

function isExistingFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function parseWindowsWhereOutput(
  output: string | undefined,
  isFile: (candidate: string) => boolean = isExistingFile
): string | undefined {
  for (const line of output?.split(/\r?\n/) || []) {
    const trimmed = line.trim();
    const candidate =
      trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1)
        : trimmed;
    if (path.win32.isAbsolute(candidate) && isFile(candidate)) return candidate;
  }
  return undefined;
}

export interface WindowsCommandInvocation {
  prefix: string;
  requiresPowerShell: boolean;
}

export function windowsCommandInvocation(
  executable: string
): WindowsCommandInvocation {
  const quoted = `"${executable.replace(/"/g, '""')}"`;
  const requiresPowerShell =
    path.win32.extname(executable).toLowerCase() === ".ps1";
  return {
    prefix: requiresPowerShell ? `& ${quoted}` : quoted,
    requiresPowerShell
  };
}

export function parseWindowsShellCommandOutput(
  output: string | undefined
): string | undefined {
  const markerIndex = output?.lastIndexOf(COMMAND_RESULT_MARKER) ?? -1;
  if (markerIndex < 0) return undefined;
  const resolved = output
    ?.slice(markerIndex + COMMAND_RESULT_MARKER.length)
    .trim();
  return resolved && path.win32.isAbsolute(resolved) ? resolved : undefined;
}

async function readCurrentWindowsPaths(
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  const output = await runPowerShell(WINDOWS_PATH_QUERY, env);
  if (!output) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : typeof parsed === "string"
        ? [parsed]
        : [];
  } catch {
    return [];
  }
}

export async function getFreshWindowsEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  const env = { ...source };
  if (process.platform !== "win32") return env;

  const registryPaths = await readCurrentWindowsPaths(env);
  const currentPath = env.PATH || env.Path || "";
  const mergedPath = mergeWindowsPath(...registryPaths, currentPath);
  if (mergedPath) {
    env.PATH = mergedPath;
    // Avoid passing two differently-cased PATH variables to Windows children.
    delete env.Path;
  }
  return env;
}

export async function resolveWindowsShellCommand(
  command: string,
  source: NodeJS.ProcessEnv
): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const env = {
    ...source,
    FREEBUDDY_COMMAND_NAME: command
  };
  const script = [
    "$resolved=Get-Command -Name $env:FREEBUDDY_COMMAND_NAME -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if(-not $resolved){$resolved=Get-Command -Name $env:FREEBUDDY_COMMAND_NAME -CommandType ExternalScript -ErrorAction Stop | Select-Object -First 1}",
    `[Console]::Out.Write('${COMMAND_RESULT_MARKER}'+$resolved.Source)`
  ].join(";");
  const output = await runPowerShell(script, env, { loadProfile: true });
  return parseWindowsShellCommandOutput(output);
}

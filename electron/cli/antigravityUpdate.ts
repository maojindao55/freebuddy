import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Match the bridge's executable selection, including a newly installed CLI. */
export function antigravityUpdateBinary(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  home = os.homedir()
): string {
  const override = env.AGY_ACP_COMMAND?.trim();
  if (override) return override;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const directories = (env.PATH ?? env.Path ?? env.path ?? "")
    .split(windows ? ";" : ":")
    .map(entry => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const installDirectory = windows
    ? env.LOCALAPPDATA && paths.join(env.LOCALAPPDATA, "agy", "bin")
    : paths.join(home, ".local", "bin");
  if (installDirectory) directories.push(installDirectory);
  for (const directory of new Set(directories)) {
    for (const name of windows ? ["agy.exe", "agy.cmd", "agy.bat", "agy.com", "agy"] : ["agy"]) {
      const candidate = paths.join(directory, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch { /* Continue to the next bridge search location. */ }
    }
  }
  // npm's postinstall may create this executable after preparing the plan.
  return installDirectory ? paths.join(installDirectory, windows ? "agy.exe" : "agy") : "agy";
}

/** Preserve either failure on Windows PowerShell 5 as well as POSIX shells. */
export function antigravityUpgradeCommand(
  adapterCommand: string | undefined,
  binary: string,
  platform = process.platform
): string {
  if (platform === "win32") {
    // Double quotes also select the installer's PowerShell execution path.
    const quoted = `"${binary.replace(/[`"$]/g, character => "`" + character)}"`;
    const adapter = adapterCommand
      ? `${adapterCommand}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; `
      : "";
    return `$ErrorActionPreference = 'Stop'; ${adapter}& ${quoted} update; exit $LASTEXITCODE`;
  }
  const quoted = `'${binary.replace(/'/g, `'"'"'`)}'`;
  return (adapterCommand ? `${adapterCommand} && ` : "") + `${quoted} update`;
}

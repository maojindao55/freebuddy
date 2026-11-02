import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** App presence is discovery evidence, never proof that an ACP CLI is ready. */
export function localAgentAppCandidates(
  name: "Codex" | "Qoder",
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (platform === "darwin") {
    return ["/Applications", path.posix.join(home, "Applications")]
      .map((root) => path.posix.join(root, `${name}.app`, "Contents", "Info.plist"));
  }
  if (platform === "win32") {
    return [
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", name, `${name}.exe`),
      env.ProgramFiles && path.win32.join(env.ProgramFiles, name, `${name}.exe`)
    ].filter((entry): entry is string => Boolean(entry));
  }
  return [
    `/usr/share/applications/${name.toLowerCase()}.desktop`,
    path.posix.join(home, ".local/share/applications", `${name.toLowerCase()}.desktop`)
  ];
}

export function hasLocalAgentApp(name: "Codex" | "Qoder"): boolean {
  return localAgentAppCandidates(name).some((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}

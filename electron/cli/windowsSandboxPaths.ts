import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDataDir } from "./db.js";

/**
 * Windows WebUI sandbox paths must stay outside %APPDATA%. Bun-based agents
 * (OpenCode) lstat every parent of cwd/USERPROFILE during startup; granting
 * the host AppData directory would expose the entire profile to the sandbox
 * user, so managed state lives under %ProgramData%\FreeBuddy instead.
 */
function windowsManagedRoot(): string {
  const dir = path.join(
    process.env.ProgramData || path.join(os.homedir(), "..", "ProgramData"),
    "FreeBuddy"
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getRemoteWorkspacesRoot(): string {
  if (process.platform === "win32") {
    const dir = path.join(windowsManagedRoot(), "remote-workspaces");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  return path.join(getDataDir(), "remote-workspaces");
}

export function getWindowsAgentLinksRoot(): string {
  if (process.platform !== "win32") {
    throw new Error("getWindowsAgentLinksRoot is Windows-only");
  }
  const dir = path.join(windowsManagedRoot(), "agent-links");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("remote_sandbox_unsafe_windows_agent_alias_root");
  }
  return dir;
}

export function getWindowsManagedRoot(): string {
  if (process.platform !== "win32") {
    throw new Error("getWindowsManagedRoot is Windows-only");
  }
  return windowsManagedRoot();
}

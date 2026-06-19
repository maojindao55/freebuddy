import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";

type Killable = Pick<ChildProcess, "pid" | "kill">;

/** Args for `taskkill` that force-kill a whole process tree. Pure/testable. */
export function taskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

/**
 * Terminate a child process and (on Windows) its entire descendant tree.
 * - win32: `taskkill /T /F` (no graceful/forceful distinction).
 * - unix: `child.kill(SIGTERM | SIGKILL)` depending on `mode`.
 */
export function killProcessTree(child: Killable, mode: "term" | "force"): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", taskkillArgs(pid), { stdio: "ignore" });
    return;
  }
  child.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
}

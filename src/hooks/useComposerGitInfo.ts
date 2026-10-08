import { useEffect, useState } from "react";
import { cliClient } from "@/services/cli/client";
import type { GitWorkspaceInfo } from "@/services/cli/types";

// Share overlapping inspections (including React StrictMode's effect replay).
const inspections = new Map<string, Promise<GitWorkspaceInfo>>();
function inspect(cwd: string, refreshKey: string) {
  const key = JSON.stringify([cwd, refreshKey]);
  const existing = inspections.get(key);
  if (existing) return existing;
  const request = Promise.resolve()
    .then(() => cliClient.inspectTaskWorkspace(cwd))
    .finally(() => inspections.delete(key));
  inspections.set(key, request);
  return request;
}

/** Refresh on conversation/run changes and foregrounding, never on draft edits. */
export function useComposerGitInfo(cwd: string | undefined, refreshKey: string) {
  const [snapshot, setSnapshot] = useState<{ cwd: string; info: GitWorkspaceInfo }>();
  useEffect(() => {
    if (!cwd || !cliClient.isAvailable() || window.freebuddy?.platform === "web") return;
    let cancelled = false;
    let lastRefresh = 0;
    const refresh = () => {
      if (document.visibilityState === "hidden" || Date.now() - lastRefresh < 500) return;
      lastRefresh = Date.now();
      void inspect(cwd, refreshKey).then(info => {
        if (!cancelled) setSnapshot({ cwd, info });
      }).catch(() => {
        if (!cancelled) setSnapshot(undefined);
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [cwd, refreshKey]);
  return snapshot && snapshot.cwd === cwd ? snapshot.info : undefined;
}

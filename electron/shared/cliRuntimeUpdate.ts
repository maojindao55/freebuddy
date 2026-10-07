import { compareSemver, extractSemver } from "../cli/version.js";

export interface CliRuntimeUpdateRequest {
  adapter: string;
  binary?: string;
  env?: Record<string, string>;
  runtimeAdapter?: string;
  extraArgs?: string[];
  cwd?: string;
  force?: boolean;
}

export interface CliUpgradePlan {
  command: string;
  previousVersion?: string;
  targetVersion?: string;
  expectedBinaryPath?: string;
  alreadyCurrent?: boolean;
}

export type RuntimeUpdateStatus = "idle" | "checking" | "current" | "available" | "updating" | "updated" | "error";

export function runtimeVersionBelow(version: string | undefined, minimum: string | undefined): boolean {
  const current = extractSemver(version), required = extractSemver(minimum);
  return !!current && !!required && compareSemver(current, required) < 0;
}

/** Optional version probes may omit a version, but must retain a valid response. */
export function versionFromProbe(output: string | undefined, optional: boolean): string | undefined {
  return optional ? extractSemver(output)?.raw : output;
}

export interface RuntimeUpdateSnapshot {
  version?: string;
  latestVersion?: string;
  updateStatus?: RuntimeUpdateStatus;
  lastUpdateCheckAt?: string;
  lastUpdateError?: string;
}

/** A registry failure changes update health, never local installation health. */
export async function checkRuntimeUpdate(
  snapshot: RuntimeUpdateSnapshot,
  fetchLatest: () => Promise<string>,
  { force = false, now = Date.now() }: { force?: boolean; now?: number } = {}
): Promise<RuntimeUpdateSnapshot> {
  const checkedAt = Date.parse(snapshot.lastUpdateCheckAt ?? "");
  const cached = extractSemver(snapshot.latestVersion);
  const current = extractSemver(snapshot.version);
  const successful = ["current", "available", "updated"].includes(snapshot.updateStatus ?? "");
  if (!force && successful && cached && checkedAt <= now && now - checkedAt < 24 * 60 * 60 * 1000) {
    return { ...snapshot, updateStatus: current && compareSemver(current, cached) >= 0 ? "current" : "available", lastUpdateError: undefined };
  }
  const lastUpdateCheckAt = new Date(now).toISOString();
  try {
    const latestVersion = await fetchLatest();
    const latest = extractSemver(latestVersion);
    if (!latest) throw new Error("Registry returned an invalid version.");
    return { version: snapshot.version, latestVersion: latest.raw, lastUpdateCheckAt,
      updateStatus: current && compareSemver(current, latest) >= 0 ? "current" : "available" };
  } catch (error) {
    return { ...snapshot, updateStatus: "error", lastUpdateCheckAt,
      lastUpdateError: error instanceof Error ? error.message : String(error) };
  }
}

export function upgradeVerificationError(
  actual: { installed: boolean; path?: string; version?: string },
  plan: CliUpgradePlan,
  platform: string
): string | undefined {
  if (!actual.installed) return "runtime_not_installed";
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (plan.expectedBinaryPath && (!actual.path || normalize(actual.path) !== normalize(plan.expectedBinaryPath))) {
    return "runtime_path_changed";
  }
  const actualVersion = extractSemver(actual.version);
  const target = extractSemver(plan.targetVersion);
  if (target && !actualVersion) return "runtime_version_unknown";
  if (target && actualVersion && compareSemver(actualVersion, target) < 0) return "runtime_target_not_active";
  const previous = extractSemver(plan.previousVersion);
  if (!target && previous && (!actualVersion || compareSemver(actualVersion, previous) < 0)) return "runtime_version_regressed";
  return undefined;
}

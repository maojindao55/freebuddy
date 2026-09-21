import type { CLIAdapterDefinition } from "@/config/cliAdapters";
import type { CliRuntime } from "@/services/cli/types";

export const RECOMMENDED_AGENT_IDS = ["codex-acp", "dsh-acp", "claude-agent-acp"];

export interface OnboardingInstallItem {
  id: string;
  name: string;
  binary: string;
  command?: string;
  installed: boolean;
  detected: boolean;
  recommended: boolean;
  needsRepair: boolean;
}

export function buildOnboardingInstallPlan(
  adapters: CLIAdapterDefinition[],
  runtimes: Record<string, CliRuntime>,
  discoveryRuntimes = runtimes
): OnboardingInstallItem[] {
  const items = adapters.filter((adapter) => adapter.protocol === "acp" && adapter.id !== "pi-acp")
    .map((adapter) => {
      const runtime = runtimes[adapter.id];
      const discovery = discoveryRuntimes[adapter.id];
      const detected = Boolean(discovery?.installed || discovery?.binaryPath ||
        /^(codex (cli|app) found; acp adapter missing|claude cli found; acp adapter missing|qoder app found; cli missing)$/.test(discovery?.lastError ?? ""));
      return {
        id: adapter.id,
        name: adapter.label,
        binary: adapter.defaultBinary,
        command: adapter.installHint,
        installed: Boolean(runtime?.installed),
        detected,
        recommended: RECOMMENDED_AGENT_IDS.includes(adapter.id),
        needsRepair: Boolean(!runtime?.installed && runtime?.binaryPath)
      };
    }).filter((item) => item.detected || item.recommended);
  // Stable partition: existing tools first, then the missing recommendations.
  return [...items.filter((item) => item.detected),
    ...RECOMMENDED_AGENT_IDS.flatMap((id) => items.filter((item) => item.id === id && !item.detected))]
    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
}

import type { CLIMember } from "@/config/aiMembers";
import type { CliRuntime } from "@/services/cli/types";

export const AGENT_RUNTIME_STALE_MS = 6 * 60 * 60 * 1000;

export type AgentAvailabilityState = "available" | "checking" | "unavailable";

export type AgentAvailabilityEntry = {
  member: CLIMember;
  runtimeKey: string;
  runtime?: CliRuntime;
  state: AgentAvailabilityState;
  stale: boolean;
};

export type AgentAvailabilityGroups = {
  available: AgentAvailabilityEntry[];
  checking: AgentAvailabilityEntry[];
  unavailable: AgentAvailabilityEntry[];
};

export function agentRuntimeKey(member: CLIMember): string {
  return member.id.startsWith("cli-")
    ? member.id.slice(4)
    : member.cli.adapter;
}

function runtimeTimestamp(runtime: CliRuntime): number | undefined {
  const raw = runtime.lastCheckAt ?? runtime.updatedAt;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function agentRuntimeIsStale(
  runtime: CliRuntime | undefined,
  now = Date.now(),
  staleAfterMs = AGENT_RUNTIME_STALE_MS
): boolean {
  if (!runtime) return true;
  const timestamp = runtimeTimestamp(runtime);
  return timestamp == null || now - timestamp > staleAfterMs;
}

export function buildAgentAvailabilityGroups(
  members: CLIMember[],
  runtimes: Record<string, CliRuntime>,
  now = Date.now()
): AgentAvailabilityGroups {
  const groups: AgentAvailabilityGroups = {
    available: [],
    checking: [],
    unavailable: []
  };

  for (const member of members) {
    if (member.enabled === false) continue;
    const runtimeKey = agentRuntimeKey(member);
    const runtime = runtimes[runtimeKey];
    const entry: AgentAvailabilityEntry = {
      member,
      runtimeKey,
      runtime,
      state: runtime
        ? runtime.installed
          ? "available"
          : "unavailable"
        : "checking",
      stale: agentRuntimeIsStale(runtime, now)
    };
    groups[entry.state].push(entry);
  }

  groups.available.sort((left, right) => {
    const leftRun = Date.parse(left.runtime?.lastRunAt ?? "") || 0;
    const rightRun = Date.parse(right.runtime?.lastRunAt ?? "") || 0;
    if (leftRun !== rightRun) return rightRun - leftRun;
    return left.member.name.localeCompare(right.member.name);
  });
  groups.checking.sort((left, right) =>
    left.member.name.localeCompare(right.member.name)
  );
  groups.unavailable.sort((left, right) =>
    left.member.name.localeCompare(right.member.name)
  );

  return groups;
}

export function agentEntriesNeedingRefresh(
  groups: AgentAvailabilityGroups
): AgentAvailabilityEntry[] {
  return [
    ...groups.available.filter((entry) => entry.stale),
    ...groups.checking,
    ...groups.unavailable.filter((entry) => entry.stale)
  ];
}

import { useCallback, useRef, useState } from "react";

import { cliClient } from "@/services/cli/client";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import type { AgentAvailabilityEntry } from "@/utils/agentAvailability";

export function useAgentAvailabilityChecks() {
  const [checkingAgentIds, setCheckingAgentIds] = useState<Set<string>>(
    () => new Set()
  );
  const checkingAgentIdsRef = useRef<Set<string>>(new Set());
  const refreshRuntimes = useCliExecutorStore((s) => s.refreshRuntimes);

  const checkAgentEntries = useCallback(
    async (entries: AgentAvailabilityEntry[]) => {
      if (!cliClient.isAvailable()) return;
      const targets = entries.filter(
        (entry) => !checkingAgentIdsRef.current.has(entry.member.id)
      );
      if (targets.length === 0) return;

      const nextChecking = new Set(checkingAgentIdsRef.current);
      targets.forEach((entry) => nextChecking.add(entry.member.id));
      checkingAgentIdsRef.current = nextChecking;
      setCheckingAgentIds(new Set(nextChecking));

      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const entry = targets[cursor];
          cursor += 1;
          const member = entry.member;
          const resolved = useCliExecutorStore
            .getState()
            .resolve(member.cli.adapter);
          try {
            await cliClient.check(
              member.cli.adapter,
              member.cli.binary || resolved?.binary,
              { ...(resolved?.env ?? {}), ...(member.cli.env ?? {}) },
              entry.runtimeKey
            );
          } catch {
            // Background availability checks are reflected by runtime state.
          }
        }
      };

      try {
        await Promise.all(
          Array.from({ length: Math.min(2, targets.length) }, () => worker())
        );
        await refreshRuntimes();
      } finally {
        const remaining = new Set(checkingAgentIdsRef.current);
        targets.forEach((entry) => remaining.delete(entry.member.id));
        checkingAgentIdsRef.current = remaining;
        setCheckingAgentIds(new Set(remaining));
      }
    },
    [refreshRuntimes]
  );

  return { checkingAgentIds, checkAgentEntries };
}

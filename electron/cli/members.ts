import { getAdapterDefinition } from "./adapters.js";
import { listOverrides } from "./store.js";

export interface CLIMember {
  id: string;
  name: string;
  enabled?: boolean;
  cli: {
    adapter: string;
    binary?: string;
    extraArgs?: string[];
    env?: Record<string, string>;
    approvalMode?: "auto" | "ask";
    showStderr?: boolean;
  };
}

export const builtinCliMembers: CLIMember[] = [
  {
    id: "cli-codex-acp",
    name: "Codex",
    enabled: true,
    cli: { adapter: "codex-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-claude-agent-acp",
    name: "ClaudeCode",
    enabled: true,
    cli: { adapter: "claude-agent-acp", approvalMode: "auto", showStderr: false }
  },
  {
    id: "cli-opencode-acp",
    name: "OpenCode",
    enabled: true,
    cli: { adapter: "opencode-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-cursor-agent-acp",
    name: "Cursor",
    enabled: true,
    cli: { adapter: "cursor-agent-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-kimi-acp",
    name: "Kimi",
    enabled: true,
    cli: { adapter: "kimi-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-qoder-acp",
    name: "Qoder",
    enabled: true,
    cli: { adapter: "qoder-acp", approvalMode: "auto", showStderr: true }
  }
];

export function listCliMembers(): CLIMember[] {
  const customMembers = listOverrides()
    .filter((override) => override.baseAdapter)
    .map((override): CLIMember | undefined => {
      const baseAdapter = override.baseAdapter!;
      const definition = getAdapterDefinition(baseAdapter);
      if (!definition) return undefined;
      return {
        id: `cli-${override.id}`,
        name: override.label?.trim() || definition.label,
        enabled: override.enabled !== false,
        cli: {
          adapter: baseAdapter,
          binary: override.binary,
          extraArgs: override.extraArgs,
          env: override.env,
          approvalMode: "auto",
          showStderr: true
        }
      };
    })
    .filter((member): member is CLIMember => Boolean(member));
  return [...builtinCliMembers, ...customMembers];
}

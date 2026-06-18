import type { CLIAdapterId } from "@/config/cliAdapters";

export interface CLIMember {
  id: string;
  kind: "cli";
  name: string;
  avatar?: string;
  description?: string;
  source: "builtin" | "user";
  enabled?: boolean;
  cli: {
    adapter: CLIAdapterId;
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
    kind: "cli",
    name: "Codex ACP",
    description: "Codex through the Agent Client Protocol adapter.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "codex-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-claude-agent-acp",
    kind: "cli",
    name: "Claude Agent ACP",
    description: "Claude Agent SDK through the Agent Client Protocol adapter.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "claude-agent-acp", approvalMode: "auto", showStderr: false }
  },
  {
    id: "cli-opencode-acp",
    kind: "cli",
    name: "OpenCode ACP",
    description: "OpenCode through its native Agent Client Protocol server.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "opencode-acp", approvalMode: "auto", showStderr: true }
  }
];

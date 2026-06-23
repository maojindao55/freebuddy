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
    id: "cli-trae-acp",
    name: "Trae CLI",
    enabled: true,
    cli: { adapter: "trae-acp", approvalMode: "auto", showStderr: true }
  }
];

export interface CLIMember {
  id: string;
  name: string;
  /** Official built-in profiles: "butler" (ButlerBuddy) / "guide" (onboarding). */
  profile?: "butler" | "guide";
  description?: string;
  runtimeKey?: string;
  requiredSkillIds?: string[];
  enabled?: boolean;
  cli: {
    adapter: string;
    binary?: string;
    extraArgs?: string[];
    env?: Record<string, string>;
    approvalMode?: "auto" | "ask";
    showStderr?: boolean;
    skillIds?: string[];
  };
}

export const builtinCliMembers: CLIMember[] = [
  {
    id: "cli-butlerbuddy",
    name: "ButlerBuddy",
    profile: "butler",
    runtimeKey: "codex-acp",
    requiredSkillIds: ["butlerbuddy"],
    enabled: true,
    cli: {
      adapter: "codex-acp",
      approvalMode: "auto",
      showStderr: true,
      skillIds: ["butlerbuddy"]
    }
  },
  {
    id: "cli-onboarding-guide",
    name: "GuideBuddy",
    profile: "guide",
    runtimeKey: "pi-acp",
    requiredSkillIds: ["onboarding-guide"],
    enabled: true,
    cli: {
      adapter: "pi-acp",
      approvalMode: "auto",
      showStderr: true,
      skillIds: ["onboarding-guide"]
    }
  },
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
  },
  {
    id: "cli-codebuddy-acp",
    name: "CodeBuddy",
    enabled: true,
    cli: { adapter: "codebuddy-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-grok-acp",
    name: "Grok",
    enabled: true,
    cli: { adapter: "grok-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-agy-acp",
    name: "Antigravity",
    enabled: true,
    cli: { adapter: "agy-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-dsh-acp",
    name: "DeepSeek Harness",
    enabled: true,
    cli: { adapter: "dsh-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-zcode-acp",
    name: "ZCode",
    enabled: true,
    cli: { adapter: "zcode-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-cline-acp",
    name: "Cline",
    enabled: true,
    cli: { adapter: "cline-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-pi-acp",
    name: "Pi",
    enabled: true,
    cli: { adapter: "pi-acp", approvalMode: "auto", showStderr: true }
  }
];

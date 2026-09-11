import type { CLIAdapterId } from "@/config/cliAdapters";

export interface CLIMember {
  id: string;
  kind: "cli";
  name: string;
  profile?: "butler";
  runtimeKey?: CLIAdapterId;
  requiredSkillIds?: string[];
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
    skillIds?: string[];
  };
}

export const builtinCliMembers: CLIMember[] = [
  {
    id: "cli-butlerbuddy",
    kind: "cli",
    name: "ButlerBuddy",
    profile: "butler",
    runtimeKey: "codex-acp",
    requiredSkillIds: ["butlerbuddy"],
    description: "FreeBuddy's built-in configuration and troubleshooting agent.",
    source: "builtin",
    enabled: true,
    cli: {
      adapter: "codex-acp",
      approvalMode: "auto",
      showStderr: true,
      skillIds: ["butlerbuddy"]
    }
  },
  {
    id: "cli-codex-acp",
    kind: "cli",
    name: "Codex",
    description: "Local Codex coding agent.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "codex-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-claude-agent-acp",
    kind: "cli",
    name: "ClaudeCode",
    description: "Local ClaudeCode coding agent.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "claude-agent-acp", approvalMode: "auto", showStderr: false }
  },
  {
    id: "cli-opencode-acp",
    kind: "cli",
    name: "OpenCode",
    description: "Local OpenCode coding agent.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "opencode-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-cursor-agent-acp",
    kind: "cli",
    name: "Cursor",
    description: "Local Cursor coding agent.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "cursor-agent-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-kimi-acp",
    kind: "cli",
    name: "Kimi",
    description: "Local Kimi coding agent.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "kimi-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-qoder-acp",
    kind: "cli",
    name: "Qoder",
    description: "Local Qoder CLI coding agent.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "qoder-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-codebuddy-acp",
    kind: "cli",
    name: "CodeBuddy",
    description: "Local CodeBuddy coding agent.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "codebuddy-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-grok-acp",
    kind: "cli",
    name: "Grok",
    description: "Local Grok coding agent.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "grok-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-agy-acp",
    kind: "cli",
    name: "Antigravity",
    description: "Local Antigravity coding agent via ACP.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "agy-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-dsh-acp",
    kind: "cli",
    name: "DeepSeek Harness",
    description: "Local DeepSeek Harness coding agent via ACP.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "dsh-acp", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-zcode-acp",
    kind: "cli",
    name: "ZCode",
    description: "Local ZCode coding agent via ACP.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "zcode-acp", approvalMode: "auto", showStderr: true }
  }
];

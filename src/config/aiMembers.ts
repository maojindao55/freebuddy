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
    skillIds?: string[];
  };
}

export const builtinCliMembers: CLIMember[] = [
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
  }
];

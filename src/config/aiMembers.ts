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
    id: "cli-codex",
    kind: "cli",
    name: "Codex",
    description: "OpenAI Codex CLI — strong at refactors and implementation.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "codex", approvalMode: "auto", showStderr: true }
  },
  {
    id: "cli-claude",
    kind: "cli",
    name: "Claude Code",
    description: "Anthropic Claude Code — codebase analysis and debugging.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "claude", approvalMode: "auto", showStderr: false }
  },
  {
    id: "cli-opencode",
    kind: "cli",
    name: "OpenCode",
    description: "OpenCode open-source coding assistant.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "opencode", approvalMode: "auto", showStderr: true }
  }
];

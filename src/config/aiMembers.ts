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
    id: "cli-trae-acp",
    kind: "cli",
    name: "Trae CLI",
    description: "Local Trae CLI coding agent. Requires TRAECLI_PERSONAL_ACCESS_TOKEN.",
    source: "builtin",
    enabled: true,
    cli: { adapter: "trae-acp", approvalMode: "auto", showStderr: true }
  }
];

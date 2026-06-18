export type CLIAdapterId =
  | "codex"
  | "codex-acp"
  | "claude"
  | "claude-agent-acp"
  | "opencode"
  | "opencode-acp"
  | (string & {});

export type CLIStreamMode =
  | "codex-json"
  | "claude-json"
  | "opencode-json"
  | "raw";

export interface CLIAdapterDefinition {
  id: CLIAdapterId;
  label: string;
  defaultBinary: string;
  streamMode: CLIStreamMode;
  commandGroup: string;
  capabilities: { toolSession: boolean };
  toolSessionArgs: string[];
  toolSessionArgPrefixes: string[];
  installHint?: string;
  docsUrl?: string;
  protocol?: "legacy-cli-json" | "acp";
}

// Kept in sync with electron/cli/adapters.ts. Renderer uses this only for
// labels / UI defaults / install hints; the source of truth at run-time is
// what `cli.listAdapters()` returns from the main process.
export const cliAdapterDefinitions: CLIAdapterDefinition[] = [
  {
    id: "codex",
    label: "Codex Legacy",
    defaultBinary: "codex",
    streamMode: "codex-json",
    commandGroup: "codex",
    capabilities: { toolSession: true },
    toolSessionArgs: ["resume", "--last"],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g @openai/codex",
    docsUrl: "https://github.com/openai/codex",
    protocol: "legacy-cli-json"
  },
  {
    id: "codex-acp",
    label: "Codex ACP",
    defaultBinary: "codex-acp",
    streamMode: "raw",
    commandGroup: "codex",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g @zed-industries/codex-acp",
    docsUrl: "https://github.com/zed-industries/codex-acp",
    protocol: "acp"
  },
  {
    id: "claude",
    label: "Claude Code Legacy",
    defaultBinary: "claude",
    streamMode: "claude-json",
    commandGroup: "claude",
    capabilities: { toolSession: true },
    toolSessionArgs: ["--resume", "-r", "--continue", "-c", "--session-id"],
    toolSessionArgPrefixes: ["--resume=", "--session-id="],
    installHint: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    protocol: "legacy-cli-json"
  },
  {
    id: "claude-agent-acp",
    label: "Claude Agent ACP",
    defaultBinary: "claude-agent-acp",
    streamMode: "raw",
    commandGroup: "claude",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g @agentclientprotocol/claude-agent-acp",
    docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    protocol: "acp"
  },
  {
    id: "opencode",
    label: "OpenCode Legacy",
    defaultBinary: "opencode",
    streamMode: "opencode-json",
    commandGroup: "opencode",
    capabilities: { toolSession: true },
    toolSessionArgs: ["--session", "-s", "--continue", "-c"],
    toolSessionArgPrefixes: ["--session="],
    installHint: "npm install -g opencode-ai",
    docsUrl: "https://opencode.ai/docs",
    protocol: "legacy-cli-json"
  },
  {
    id: "opencode-acp",
    label: "OpenCode ACP",
    defaultBinary: "opencode",
    streamMode: "raw",
    commandGroup: "opencode",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g opencode-ai",
    docsUrl: "https://opencode.ai/docs",
    protocol: "acp"
  }
];

export function getAdapter(id: string): CLIAdapterDefinition | undefined {
  return cliAdapterDefinitions.find((d) => d.id === id);
}

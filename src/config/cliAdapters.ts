export type CLIAdapterId =
  | "codex"
  | "codex-acp"
  | "claude"
  | "claude-agent-acp"
  | "opencode"
  | "opencode-acp"
  | "cursor-agent-acp"
  | "kimi-acp"
  | "trae-acp"
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

// User-visible adapters. Legacy command builders still exist in the main
// process for older saved runs, but the product surface is ACP-only.
export const cliAdapterDefinitions: CLIAdapterDefinition[] = [
  {
    id: "codex-acp",
    label: "Codex",
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
    id: "claude-agent-acp",
    label: "ClaudeCode",
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
    id: "opencode-acp",
    label: "OpenCode",
    defaultBinary: "opencode",
    streamMode: "raw",
    commandGroup: "opencode",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g opencode-ai",
    docsUrl: "https://opencode.ai/docs",
    protocol: "acp"
  },
  {
    id: "cursor-agent-acp",
    label: "Cursor",
    defaultBinary: "cursor-agent",
    streamMode: "raw",
    commandGroup: "cursor",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "curl https://cursor.com/install -fsS | bash",
    docsUrl: "https://docs.cursor.com/en/cli/overview",
    protocol: "acp"
  },
  {
    id: "kimi-acp",
    label: "Kimi",
    defaultBinary: "kimi",
    streamMode: "raw",
    commandGroup: "kimi",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/ides",
    protocol: "acp"
  },
  {
    id: "trae-acp",
    label: "Trae CLI",
    defaultBinary: "traecli",
    streamMode: "raw",
    commandGroup: "trae",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: 'sh -c "$(curl -L https://trae.cn/trae-cli/install.sh)" \u0026\u0026 export PATH=~/.local/bin:$PATH',
    docsUrl: "https://docs.trae.cn/cli",
    protocol: "acp"
  }
];

export function getAdapter(id: string): CLIAdapterDefinition | undefined {
  return cliAdapterDefinitions.find((d) => d.id === id);
}

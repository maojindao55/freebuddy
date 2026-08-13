export type CLIAdapterId =
  | "codex"
  | "codex-acp"
  | "claude"
  | "claude-agent-acp"
  | "opencode"
  | "opencode-acp"
  | "cursor-agent-acp"
  | "kimi-acp"
  | "qoder-acp"
  | "codebuddy-acp"
  | "grok-acp"
  | "agy-acp"
  | "dsh-acp"
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
  capabilities: {
    toolSession: boolean;
    skills?: {
      mode: "native" | "mcp";
      nativeDirs?: string[];
      reloadPolicy: "process-start" | "new-session";
    };
  };
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
    installHint: "npm install -g --force @agentclientprotocol/codex-acp",
    docsUrl: "https://github.com/agentclientprotocol/codex-acp",
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
    installHint:
      "npm install -g --include=optional @agentclientprotocol/claude-agent-acp",
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
    id: "qoder-acp",
    label: "Qoder",
    defaultBinary: "qodercli",
    streamMode: "raw",
    commandGroup: "qoder",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "curl -fsSL https://qoder.com/install | bash",
    docsUrl: "https://docs.qoder.com/en/cli/acp",
    protocol: "acp"
  },
  {
    id: "codebuddy-acp",
    label: "CodeBuddy",
    defaultBinary: "codebuddy",
    streamMode: "raw",
    commandGroup: "codebuddy",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g @tencent-ai/codebuddy-code",
    docsUrl: "https://www.codebuddy.cn/docs/cli/acp",
    protocol: "acp"
  },
  {
    id: "grok-acp",
    label: "Grok",
    defaultBinary: "grok",
    streamMode: "raw",
    commandGroup: "grok",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint:
      "curl -fsSL https://x.ai/cli/install.sh | bash",
    docsUrl: "https://docs.x.ai/build/cli/reference",
    protocol: "acp"
  },
  {
    id: "agy-acp",
    label: "Antigravity",
    defaultBinary: "agy-acp",
    streamMode: "raw",
    commandGroup: "antigravity",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g agy-acp-bridge",
    docsUrl: "https://github.com/maojindao55/agy-acp",
    protocol: "acp"
  },
  {
    id: "dsh-acp",
    label: "DeepSeek",
    defaultBinary: "dsh-acp-demo",
    streamMode: "raw",
    commandGroup: "deepseek",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g @deepseek-ai/dsh-acp-demo@next",
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    protocol: "acp"
  }
];

export function getAdapter(id: string): CLIAdapterDefinition | undefined {
  return cliAdapterDefinitions.find((d) => d.id === id);
}

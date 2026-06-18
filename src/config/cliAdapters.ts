export type CLIAdapterId =
  | "codex"
  | "claude"
  | "opencode"
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
}

// Kept in sync with electron/cli/adapters.ts. Renderer uses this only for
// labels / UI defaults / install hints; the source of truth at run-time is
// what `cli.listAdapters()` returns from the main process.
export const cliAdapterDefinitions: CLIAdapterDefinition[] = [
  {
    id: "codex",
    label: "Codex",
    defaultBinary: "codex",
    streamMode: "codex-json",
    commandGroup: "codex",
    capabilities: { toolSession: true },
    toolSessionArgs: ["resume", "--last"],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g @openai/codex",
    docsUrl: "https://github.com/openai/codex"
  },
  {
    id: "claude",
    label: "Claude Code",
    defaultBinary: "claude",
    streamMode: "claude-json",
    commandGroup: "claude",
    capabilities: { toolSession: true },
    toolSessionArgs: ["--resume", "-r", "--continue", "-c", "--session-id"],
    toolSessionArgPrefixes: ["--resume=", "--session-id="],
    installHint: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code"
  },
  {
    id: "opencode",
    label: "OpenCode",
    defaultBinary: "opencode",
    streamMode: "opencode-json",
    commandGroup: "opencode",
    capabilities: { toolSession: true },
    toolSessionArgs: ["--session", "-s", "--continue", "-c"],
    toolSessionArgPrefixes: ["--session="],
    installHint: "npm install -g opencode-ai",
    docsUrl: "https://opencode.ai/docs"
  }
];

export function getAdapter(id: string): CLIAdapterDefinition | undefined {
  return cliAdapterDefinitions.find((d) => d.id === id);
}

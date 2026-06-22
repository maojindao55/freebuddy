export type CLIAdapterId =
  | "codex"
  | "codex-acp"
  | "claude"
  | "claude-agent-acp"
  | "opencode"
  | "opencode-acp"
  | "cursor-agent-acp"
  | "kimi-acp"
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
  /** Args that, when present in user extraArgs, indicate the user is already
   *  controlling tool-session resume manually. */
  toolSessionArgs: string[];
  toolSessionArgPrefixes: string[];
  installHint?: string;
  docsUrl?: string;
  protocol?: "legacy-cli-json" | "acp";
}

const legacyAdapterDefinitions: CLIAdapterDefinition[] = [
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
  }
];

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
    installHint:
      process.platform === "win32"
        ? "irm 'https://cursor.com/install?win32=true' | iex"
        : "curl https://cursor.com/install -fsS | bash",
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
    installHint:
      process.platform === "win32"
        ? "irm https://code.kimi.com/kimi-code/install.ps1 | iex"
        : "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/ides",
    protocol: "acp"
  }
];

const allAdapterDefinitions = [
  ...legacyAdapterDefinitions,
  ...cliAdapterDefinitions
];

const definitionsById = new Map(
  allAdapterDefinitions.map((definition) => [definition.id, definition])
);

export function getAdapterDefinition(
  adapter: string
): CLIAdapterDefinition | undefined {
  return definitionsById.get(adapter as CLIAdapterId);
}

export function adapterBinary(adapter: string): string | undefined {
  return definitionsById.get(adapter as CLIAdapterId)?.defaultBinary;
}

export function hasExplicitToolSessionArg(
  adapter: string | null | undefined,
  extraArgs: string[] | null | undefined
): boolean {
  if (!adapter || !extraArgs?.length) return false;
  const def = getAdapterDefinition(adapter);
  if (!def) return false;
  return extraArgs.some(
    (arg) =>
      def.toolSessionArgs.includes(arg) ||
      def.toolSessionArgPrefixes.some((prefix) => arg.startsWith(prefix))
  );
}

export interface BuildCommandInput {
  adapter: string;
  binary?: string;
  prompt: string;
  extraArgs?: string[];
  cwd?: string;
  toolSessionId?: string;
}

export interface BuiltCommand {
  bin: string;
  args: string[];
  env?: Record<string, string>;
  /** When true, the prompt is delivered via stdin instead of argv. */
  promptViaStdin: boolean;
  protocol?: "legacy-cli-json" | "acp";
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function normalizeCodexAcpArgs(args: string[]): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-m" || arg === "--model") {
      const model = args[i + 1];
      if (model) {
        normalized.push("-c", `model=${tomlString(model)}`);
        i += 1;
        continue;
      }
    }
    if (arg.startsWith("--model=")) {
      normalized.push("-c", `model=${tomlString(arg.slice("--model=".length))}`);
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function splitModelArg(args: string[]): {
  model?: string;
  args: string[];
} {
  const rest: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-m" || arg === "--model") {
      const value = args[i + 1];
      if (value) {
        model = value;
        i += 1;
        continue;
      }
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }
    rest.push(arg);
  }
  return { model, args: rest };
}

/**
 * Per-adapter command construction. The result is fed straight to spawn().
 * Stream parsing happens in the renderer; here we only assemble argv that
 * makes the CLI emit a structured/JSON stream we can later parse.
 */
export function buildCommand(input: BuildCommandInput): BuiltCommand {
  const def = getAdapterDefinition(input.adapter);
  const bin = (input.binary?.trim() || def?.defaultBinary || input.adapter).trim();
  const extra = (input.extraArgs || []).filter((a) => a != null && a !== "");

  switch (input.adapter) {
    case "codex": {
      if (input.toolSessionId && !hasExplicitToolSessionArg("codex", extra)) {
        const args: string[] = ["exec", "resume", "--json"];
        args.push(...extra);
        args.push(input.toolSessionId, input.prompt);
        return { bin, args, promptViaStdin: false, protocol: "legacy-cli-json" };
      }
      const args: string[] = ["exec", "--json", "--color", "never"];
      args.push(...extra);
      args.push(input.prompt);
      return { bin, args, promptViaStdin: false, protocol: "legacy-cli-json" };
    }
    case "codex-acp":
      return {
        bin,
        args: normalizeCodexAcpArgs(extra),
        promptViaStdin: false,
        protocol: "acp"
      };
    case "claude-agent-acp": {
      const { model, args } = splitModelArg(extra);
      return {
        bin,
        args,
        ...(model ? { env: { ANTHROPIC_MODEL: model } } : {}),
        promptViaStdin: false,
        protocol: "acp"
      };
    }
    case "opencode-acp": {
      const { model, args: acpArgs } = splitModelArg(extra);
      const args: string[] = ["acp"];
      if (input.cwd) args.push("--cwd", input.cwd);
      args.push(...acpArgs);
      return {
        bin,
        args,
        ...(model
          ? { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model }) } }
          : {}),
        promptViaStdin: false,
        protocol: "acp"
      };
    }
    case "cursor-agent-acp": {
      const { model, args: acpArgs } = splitModelArg(extra);
      const args: string[] = ["acp"];
      args.push(...acpArgs);
      return {
        bin,
        args,
        ...(model ? { env: { CURSOR_MODEL: model } } : {}),
        promptViaStdin: false,
        protocol: "acp"
      };
    }
    case "kimi-acp": {
      const { model, args: acpArgs } = splitModelArg(extra);
      const args: string[] = ["acp"];
      args.push(...acpArgs);
      return {
        bin,
        args,
        ...(model ? { env: { KIMI_MODEL_NAME: model } } : {}),
        promptViaStdin: false,
        protocol: "acp"
      };
    }
    case "claude": {
      const args: string[] = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose"
      ];
      if (input.toolSessionId && !hasExplicitToolSessionArg("claude", extra)) {
        args.push("--resume", input.toolSessionId);
      }
      args.push(...extra);
      args.push(input.prompt);
      return { bin, args, promptViaStdin: false, protocol: "legacy-cli-json" };
    }
    case "opencode": {
      const args: string[] = ["run", "--print-logs"];
      if (input.toolSessionId && !hasExplicitToolSessionArg("opencode", extra)) {
        args.push("--session", input.toolSessionId);
      }
      args.push(...extra);
      args.push(input.prompt);
      return { bin, args, promptViaStdin: false, protocol: "legacy-cli-json" };
    }
    default: {
      const args = [...extra];
      return { bin, args, promptViaStdin: true, protocol: "legacy-cli-json" };
    }
  }
}

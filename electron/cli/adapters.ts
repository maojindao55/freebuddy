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
  checkProbe?: CliCheckProbe;
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

export interface CliCheckProbe {
  args: string[];
  versionOptional: boolean;
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
    checkProbe: { args: ["--version"], versionOptional: false },
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
    checkProbe: { args: ["--cli", "--version"], versionOptional: false },
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
    installHint:
      process.platform === "win32"
        ? "irm https://qoder.com/install.ps1 | iex"
        : "curl -fsSL https://qoder.com/install | bash",
    docsUrl: "https://docs.qoder.com/en/cli/acp",
    protocol: "acp"
  },
  {
    id: "codebuddy-acp",
    label: "CodeBuddy",
    defaultBinary: "codebuddy",
    checkProbe: { args: ["--version"], versionOptional: false },
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
    checkProbe: { args: ["version"], versionOptional: false },
    streamMode: "raw",
    commandGroup: "grok",
    capabilities: { toolSession: true },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint:
      process.platform === "win32"
        ? "irm https://x.ai/cli/install.ps1 | iex"
        : "curl -fsSL https://x.ai/cli/install.sh | bash",
    docsUrl: "https://docs.x.ai/build/cli/reference",
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

export function getCliCheckProbe(adapter: string): CliCheckProbe {
  return (
    definitionsById.get(adapter as CLIAdapterId)?.checkProbe ?? {
      args: ["--version"],
      versionOptional: false
    }
  );
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

function parseCodexConfigValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function setDottedConfigValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown
) {
  const parts = key.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return;
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function normalizeCodexAcpArgs(args: string[]): {
  args: string[];
  env?: Record<string, string>;
} {
  const normalized: string[] = [];
  const config: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-m" || arg === "--model") {
      const model = args[i + 1];
      if (model) {
        config.model = model;
        i += 1;
        continue;
      }
    }
    if (arg.startsWith("--model=")) {
      config.model = arg.slice("--model=".length);
      continue;
    }
    if (arg === "-c" || arg === "--config") {
      const pair = args[i + 1];
      if (pair) {
        const eq = pair.indexOf("=");
        if (eq > 0) {
          setDottedConfigValue(
            config,
            pair.slice(0, eq),
            parseCodexConfigValue(pair.slice(eq + 1))
          );
        }
        i += 1;
        continue;
      }
    }
    if (arg.startsWith("-c=") || arg.startsWith("--config=")) {
      const pair = arg.slice(arg.indexOf("=") + 1);
      const eq = pair.indexOf("=");
      if (eq > 0) {
        setDottedConfigValue(
          config,
          pair.slice(0, eq),
          parseCodexConfigValue(pair.slice(eq + 1))
        );
      }
      continue;
    }
    normalized.push(arg);
  }
  return {
    args: normalized,
    ...(Object.keys(config).length
      ? { env: { CODEX_CONFIG: JSON.stringify(config) } }
      : {})
  };
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
    case "codex-acp": {
      const normalized = normalizeCodexAcpArgs(extra);
      return {
        bin,
        args: normalized.args,
        ...(normalized.env ? { env: normalized.env } : {}),
        promptViaStdin: false,
        protocol: "acp"
      };
    }
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
    case "qoder-acp": {
      const args: string[] = ["--acp"];
      args.push(...extra);
      return {
        bin,
        args,
        promptViaStdin: false,
        protocol: "acp"
      };
    }
    case "codebuddy-acp": {
      const args: string[] = ["--acp"];
      args.push(...extra);
      return {
        bin,
        args,
        promptViaStdin: false,
        protocol: "acp"
      };
    }
    case "grok-acp": {
      const args: string[] = [...extra, "agent", "stdio"];
      return {
        bin,
        args,
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

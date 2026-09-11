import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync as fsRealpath,
  unlinkSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DSH_ACP_NPM_TAG = "next";

/** Node 22+ emits this for `node:sqlite`; DeepSeek ACP uses it via session-query-sqlite. */
export const DSH_ACP_NODE_DISABLE_WARNING =
  "--disable-warning=ExperimentalWarning";

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
  | "zcode-acp"
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
  capabilities: {
    toolSession: boolean;
    skills?: {
      mode: "native" | "mcp";
      nativeDirs?: string[];
      reloadPolicy: "process-start" | "new-session";
    };
  };
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
  /**
   * Skip spawning the binary. Used for ACP stdio servers that have no
   * `--version` and would otherwise hang on stdin.
   */
  skipSpawn?: boolean;
}

const legacyAdapterDefinitions: CLIAdapterDefinition[] = [
  {
    id: "codex",
    label: "Codex Legacy",
    defaultBinary: "codex",
    streamMode: "codex-json",
    commandGroup: "codex",
    capabilities: { toolSession: true, skills: { mode: "native", nativeDirs: [".agents/skills"], reloadPolicy: "process-start" } },
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
    capabilities: { toolSession: true, skills: { mode: "native", nativeDirs: [".claude/skills"], reloadPolicy: "process-start" } },
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
    capabilities: { toolSession: true, skills: { mode: "native", nativeDirs: [".opencode/skills"], reloadPolicy: "process-start" } },
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
    capabilities: { toolSession: true, skills: { mode: "native", nativeDirs: [".agents/skills"], reloadPolicy: "process-start" } },
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
    capabilities: { toolSession: true, skills: { mode: "native", nativeDirs: [".claude/skills"], reloadPolicy: "process-start" } },
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
    capabilities: { toolSession: true, skills: { mode: "native", nativeDirs: [".opencode/skills"], reloadPolicy: "process-start" } },
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
    capabilities: { toolSession: true, skills: { mode: "mcp", reloadPolicy: "new-session" } },
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
    capabilities: { toolSession: true, skills: { mode: "native", nativeDirs: [".kimi/skills"], reloadPolicy: "process-start" } },
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
    capabilities: { toolSession: true, skills: { mode: "mcp", reloadPolicy: "new-session" } },
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
    capabilities: { toolSession: true, skills: { mode: "native", nativeDirs: [".codebuddy/skills"], reloadPolicy: "process-start" } },
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
    capabilities: { toolSession: true, skills: { mode: "mcp", reloadPolicy: "new-session" } },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint:
      process.platform === "win32"
        ? "irm https://x.ai/cli/install.ps1 | iex"
        : "curl -fsSL https://x.ai/cli/install.sh | bash",
    docsUrl: "https://docs.x.ai/build/cli/reference",
    protocol: "acp"
  },
  {
    id: "agy-acp",
    label: "Antigravity",
    defaultBinary: "agy-acp",
    checkProbe: { args: ["--version"], versionOptional: true },
    streamMode: "raw",
    commandGroup: "antigravity",
    capabilities: { toolSession: true, skills: { mode: "native", nativeDirs: [".agents/skills"], reloadPolicy: "process-start" } },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g agy-acp-bridge",
    docsUrl: "https://github.com/maojindao55/agy-acp",
    protocol: "acp"
  },
  {
    id: "dsh-acp",
    label: "DeepSeek Harness",
    defaultBinary: "deepseek-harness-acp",
    checkProbe: { args: [], versionOptional: true, skipSpawn: true },
    streamMode: "raw",
    commandGroup: "deepseek",
    capabilities: {
      toolSession: true,
      skills: { mode: "native", nativeDirs: [".dsh/skills"], reloadPolicy: "process-start" }
    },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: dshAcpInstallCommand(),
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    protocol: "acp"
  },
  {
    id: "zcode-acp",
    label: "ZCode",
    defaultBinary: "zcode-acp-server",
    checkProbe: { args: ["--version"], versionOptional: false },
    streamMode: "raw",
    commandGroup: "zcode",
    capabilities: {
      toolSession: true,
      skills: {
        mode: "native",
        nativeDirs: [".agents/skills", ".zcode/skills"],
        reloadPolicy: "process-start"
      }
    },
    toolSessionArgs: [],
    toolSessionArgPrefixes: [],
    installHint: "npm install -g zcode-acp-server",
    docsUrl: "https://github.com/william0wang/zcode-acp",
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

/**
 * DeepSeek Harness ACP and other adapters accept FreeBuddy's Draft/Browser/skill MCP.
 */
export function adapterAcceptsClientMcpServers(_adapter: string): boolean {
  return true;
}


export function mergeNodeOptions(
  current: string | undefined,
  patch: string
): string {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const token of [...(current ?? "").split(/\s+/), ...patch.split(/\s+/)]) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens.join(" ");
}

export function isDshAcpExperimentalWarningLine(line: string): boolean {
  const text = line.trim();
  if (/ExperimentalWarning:\s*SQLite is an experimental feature/i.test(text)) {
    return true;
  }
  return /Use `node --trace-warnings/i.test(text);
}

function dshAcpBinaryBaseName(binary: string): string {
  return binary.split(/[/\\]/).pop()?.toLowerCase() ?? "";
}

function isNodeBinary(bin: string): boolean {
  const base = dshAcpBinaryBaseName(bin);
  return base === "node" || base === "node.exe";
}

const DSH_ACP_DEFAULT_BINARIES = new Set([
  "deepseek-harness-acp",
  "deepseek-harness-acp.cmd",
  "deepseek-harness-acp.exe",
  "deepseek-harness-acp.bat",
  "deepseek-harness-acp.ps1",
  "dsh-acp",
  "dsh-acp.cmd",
  "dsh-acp.exe",
  "dsh-acp.bat",
  "dsh-acp.ps1",
  "dsh-acp-demo",
  "dsh-acp-demo.cmd",
  "dsh-acp-demo.exe",
  "dsh-acp-demo.bat",
  "dsh-acp-demo.ps1"
]);

/**
 * Settings persist `defaultBinary`, and Windows Check/PATH resolution often
 * stores `%AppData%\\npm\\dsh-acp-demo.cmd`. Those are still the stock demo.
 */
export function isDefaultDshAcpBinary(binary?: string): boolean {
  const trimmed = binary?.trim();
  if (!trimmed) return true;
  const base = dshAcpBinaryBaseName(trimmed);
  if (!DSH_ACP_DEFAULT_BINARIES.has(base)) return false;
  if (!/[\\/]/.test(trimmed)) return true;
  const normalized = trimmed.replace(/\\/g, "/").toLowerCase();
  return (
    /\/npm\/(?:dsh-acp-demo|deepseek-harness-acp|dsh-acp)(?:\.cmd|\.exe|\.bat|\.ps1)?$/i.test(normalized) ||
    /\/node_modules\/(@deepseek-ai\/dsh-acp-demo|deepseek-harness-acp)\/lib\/bin\.js$/i.test(normalized)
  );
}

function dshAcpDemoBinJsFromDir(demoDir: string): string | undefined {
  const binJs = path.join(demoDir, "lib", "bin.js");
  return existsSync(binJs) ? binJs : undefined;
}

function dshAcpDemoBinJsFromBinaryHint(binary?: string): string | undefined {
  const trimmed = binary?.trim();
  if (!trimmed || !/[\\/]/.test(trimmed)) return undefined;
  if (/(?:dsh-acp-demo|deepseek-harness-acp)[/\\]lib[/\\]bin\.js$/i.test(trimmed) && existsSync(trimmed)) {
    return trimmed;
  }
  const demoDir = resolveDshAcpDemoDirFromBinary(trimmed);
  return demoDir ? dshAcpDemoBinJsFromDir(demoDir) : undefined;
}

function wellKnownGlobalDshAcpDemoBinJs(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const residue =
    dshAcpWindowsResiduePath(env) ??
    (env.APPDATA?.trim()
      ? path.join(env.APPDATA.trim(), "npm", "node_modules", "@deepseek-ai")
      : undefined);
  if (residue) {
    const demo = dshAcpDemoBinJsFromDir(path.join(residue, "dsh-acp-demo"));
    if (demo) return demo;
  }
  const appdata = env.APPDATA?.trim();
  if (appdata) {
    const standalone = dshAcpDemoBinJsFromDir(
      path.join(appdata, "npm", "node_modules", "deepseek-harness-acp")
    );
    if (standalone) return standalone;
  }
  return undefined;
}

const ELECTRON_CHILD_ENV_BLOCKLIST = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ASAR",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "CHROME_CRASHPAD_PIPE_NAME",
  "ELECTRON_CRASHPAD_PIPE_NAME"
] as const;

/** NTSTATUS STATUS_ACCESS_VIOLATION; Node reports it as signed or unsigned. */
export const WINDOWS_STATUS_ACCESS_VIOLATION = 0xc0000005;

export function isWindowsAccessViolationExit(code: number): boolean {
  return (code >>> 0) === WINDOWS_STATUS_ACCESS_VIOLATION;
}

/**
 * Chromium/Electron env inherited by `spawn("node")` can make native addons
 * (koffi, node:sqlite) abort with 0xC0000005 on Windows.
 */
export function sanitizeCliAgentEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const next = { ...env };
  for (const key of ELECTRON_CHILD_ENV_BLOCKLIST) {
    delete next[key];
  }
  if (typeof next.NODE_OPTIONS === "string") {
    const kept = sanitizeNodeOptions(next.NODE_OPTIONS);
    if (kept) next.NODE_OPTIONS = kept;
    else delete next.NODE_OPTIONS;
  }
  return next;
}

const NODE_OPTIONS_PATH_FLAGS = new Set([
  "--require",
  "-r",
  "--import",
  "--loader",
  "--experimental-loader"
]);

function sanitizeNodeOptions(value: string): string | undefined {
  const tokens = value.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/electron|asar/i.test(token)) continue;
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? "" : token.slice(eq + 1);
    if (NODE_OPTIONS_PATH_FLAGS.has(flag)) {
      const arg = inline || tokens[i + 1];
      if (arg && /electron|asar/i.test(arg)) {
        if (!inline) i += 1;
        continue;
      }
    }
    kept.push(token);
  }
  return kept.length ? kept.join(" ") : undefined;
}

export function dshAcpFallbackWorkspace(dataDir: string): string {
  return path.join(dshAcpManagedRoot(dataDir), "workspace");
}

/** DeepSeek's sandbox/persistence use `process.cwd()`; never spawn with no cwd. */
export function ensureDshAcpCwd(
  cwd: string | undefined,
  dataDir: string
): string {
  const trimmed = cwd?.trim();
  if (trimmed) return trimmed;
  const fallback = dshAcpFallbackWorkspace(dataDir);
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

export function formatAcpAgentExitMessage(
  code: number,
  language?: string,
  adapter?: string
): string {
  if (isWindowsAccessViolationExit(code)) {
    if (adapter === "dsh-acp") {
      return language === "zh-CN"
        ? "ACP 进程发生 Windows 访问冲突 (0xC0000005)。initialize / session/new 已成功，崩溃发生在 session/prompt。官方 JSONL / Windows ACL 会用 koffi 调 Win32（含 MoveFileExW）；本版本会覆盖 JSONL，并用 Node --import 拦截 koffi。请重新编译本版本后再试（无需重装 DeepSeek）。若仍崩溃，请用「导出调试日志」把 zip 发回来。"
        : "ACP agent crashed with a Windows access violation (0xC0000005). initialize and session/new succeeded; the abort happened on session/prompt. Official JSONL / Windows ACL call Win32 through koffi (including MoveFileExW). This build overlays JSONL and intercepts koffi with Node --import. Rebuild this version — you do not need to reinstall DeepSeek. If it still crashes, export debug logs and send the zip.";
    }
    return language === "zh-CN"
      ? "ACP 进程发生 Windows 访问冲突 (0xC0000005)。进程异常终止，请检查原生依赖或系统安全软件。"
      : "ACP agent crashed with a Windows access violation (0xC0000005). The process aborted unexpectedly.";
  }
  return `ACP agent exited with code ${code}`;
}

/** Whether a composition file mounts the native `dsh-sandbox-local` (the only koffi source). */
function dshAcpConfigUsesNativeSandbox(configPath: string | undefined): boolean {
  // Unknown or missing config: assume it may use the native sandbox so the guard still applies.
  if (!configPath || !existsSync(configPath)) return true;
  return /name:\s*'@deepseek-ai\/dsh-sandbox-local'/.test(
    readFileSync(configPath, "utf8")
  );
}

/** Extract the `--config`/`-c` value from a dsh-acp argv, if present. */
function dshAcpConfigPathFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--config" || token === "-c") return args[i + 1];
    const match = token?.match(/^(?:--config|-c)=(.+)$/);
    if (match) return match[1];
  }
  return undefined;
}

function withDshAcpSqliteWarningSuppressed(command: BuiltCommand): BuiltCommand {
  // The koffi guard intercepts `dsh-sandbox-windows-acl` (loaded by
  // `dsh-sandbox-local`). Compositions that omit the native sandbox never load
  // koffi, so the guard is unnecessary — and its bare-path `--import` aborts
  // Node 24+ with ERR_UNSUPPORTED_ESM_URL_SCHEME, so injecting it there would
  // break the spawn. Apply it only when the active composition needs it.
  const configUsesNativeSandbox = dshAcpConfigUsesNativeSandbox(
    dshAcpConfigPathFromArgs(command.args) ?? bundledDshAcpConfigPath()
  );
  // The koffi guard stubs the native addon so the Win32 calls return 0
  // (a catchable JS error) instead of aborting Electron children with
  // STATUS_ACCESS_VIOLATION (0xC0000005). On macOS/Linux the real koffi
  // loads cleanly and `dsh-sandbox-windows-acl` asserts its struct layouts
  // (STARTUPINFOW=104, PROCESS_INFORMATION=24) against real koffi at import,
  // so the stub must stay Windows-only.
  const needsKoffiGuard =
    process.platform === "win32" && configUsesNativeSandbox;
  const flags = [
    DSH_ACP_NODE_DISABLE_WARNING,
    needsKoffiGuard ? dshAcpKoffiGuardImportFlag() : undefined
  ].filter((flag): flag is string => Boolean(flag));
  let env = command.env;
  for (const flag of flags) {
    env = {
      ...env,
      NODE_OPTIONS: mergeNodeOptions(env?.NODE_OPTIONS, flag)
    };
  }
  if (!isNodeBinary(command.bin)) {
    return { ...command, env };
  }
  const prepend = flags.filter((flag) => !command.args.includes(flag));
  return {
    ...command,
    args: [...prepend, ...command.args],
    env
  };
}

/**
 * Force koffi to keep its optional platform prebuild. Its install script
 * otherwise rebuilds from source, and that CMake path exceeds Windows MAX_PATH
 * under the nested global `@deepseek-ai/dsh-acp-demo` install.
 */
export function applyDshAcpNpmInstallEnv(
  adapter: string,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  if (adapter !== "dsh-acp") return env;
  return {
    ...env,
    npm_config_ignore_scripts: "true",
    npm_config_include: "optional"
  };
}

export function dshAcpWindowsResiduePath(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (process.platform !== "win32") return undefined;
  const appdata = env.APPDATA?.trim();
  if (!appdata) return undefined;
  return path.join(appdata, "npm", "node_modules", "@deepseek-ai");
}

export function extraArgsHaveDshConfig(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === "-c" ||
      arg === "--config" ||
      arg.startsWith("-c=") ||
      arg.startsWith("--config=")
  );
}

/** Resolve the `dsh-acp-demo` entry we should spawn with `node`, if any. */
export function resolveDshAcpDemoBinJs(input: {
  binary?: string;
  cwd?: string;
  dshAcpRuntimeRoot?: string;
}): string | undefined {
  const configPath = resolveDshAcpConfigPath(input.cwd, input.dshAcpRuntimeRoot);
  const standaloneManagedBin = input.dshAcpRuntimeRoot
    ? path.join(
        input.dshAcpRuntimeRoot,
        "node_modules",
        "deepseek-harness-acp",
        "lib",
        "bin.js"
      )
    : "";
  const standaloneReady =
    Boolean(standaloneManagedBin) &&
    existsSync(standaloneManagedBin) &&
    dshAcpCompositionReady(standaloneManagedBin, configPath);
  if (isDefaultDshAcpBinary(input.binary) && standaloneReady) {
    return standaloneManagedBin;
  }
  const managedBin = input.dshAcpRuntimeRoot
    ? path.join(
        input.dshAcpRuntimeRoot,
        "node_modules",
        "@deepseek-ai",
        "dsh-acp-demo",
        "lib",
        "bin.js"
      )
    : "";
  const managedReady =
    Boolean(managedBin) &&
    existsSync(managedBin) &&
    dshAcpCompositionReady(managedBin, configPath);
  if (isDefaultDshAcpBinary(input.binary) && managedReady) return managedBin;
  const fromHint = dshAcpDemoBinJsFromBinaryHint(input.binary);
  if (fromHint) return fromHint;
  const base = dshAcpBinaryBaseName(input.binary?.trim() ?? "");
  if (isDefaultDshAcpBinary(input.binary) && base.startsWith("dsh-acp-demo")) {
    const globalBin = wellKnownGlobalDshAcpDemoBinJs();
    if (globalBin) return globalBin;
  }
  return undefined;
}

/**
 * The platform-specific composition basename. Windows mounts
 * `cordis.win32.yml`, which replaces the native sandbox stack
 * (`dsh-sandbox-local` → `dsh-sandbox-windows-acl` → `koffi`) with the
 * non-sandboxed `dsh-bash-local` executor; koffi aborts Windows ACP children
 * with STATUS_ACCESS_VIOLATION (0xC0000005). Other platforms use `cordis.yml`.
 */
function bundledDshAcpConfigBasename(): string {
  return process.platform === "win32" ? "cordis.win32.yml" : "cordis.yml";
}

/** Packaged extraResources, else the repo `assets/dsh/cordis.yml` used in dev. */
export function bundledDshAcpConfigPath(): string {
  const basename = bundledDshAcpConfigBasename();
  const fromSource = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "assets",
    "dsh",
    basename
  );
  const packaged =
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "dsh", basename)
      : "";
  if (packaged && existsSync(packaged)) return packaged;
  // Fall back to the cross-platform file if the platform variant is absent
  // (e.g. an older packaged build without cordis.win32.yml).
  if (basename !== "cordis.yml" && !existsSync(fromSource)) {
    return path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "assets",
      "dsh",
      "cordis.yml"
    );
  }
  return fromSource;
}

/**
 * `dsh-acp-demo` defaults to `./cordis.yml` in the session cwd. Prefer a
 * workspace file when present; otherwise use FreeBuddy's bundled default.
 */
export function resolveDshAcpConfigPath(
  cwd?: string,
  runtimeRoot?: string
): string {
  if (cwd) {
    const local = path.join(cwd, "cordis.yml");
    if (existsSync(local)) return local;
  }
  if (runtimeRoot) {
    const managed = path.join(runtimeRoot, "cordis.yml");
    if (existsSync(managed)) return managed;
  }
  return bundledDshAcpConfigPath();
}

export const DSH_ACP_PLUGIN_TREE_MISSING = "DeepSeek ACP plugin tree missing";
export const DSH_ACP_PROBE_PACKAGE = "@deepseek-ai/dsh-llm-deepseek";

export function dshAcpManagedRoot(dataDir: string): string {
  return path.join(dataDir, "runtimes", "dsh-acp");
}

const DSH_JSONL_PACKAGE = "@deepseek-ai/dsh-session-persistence-jsonl";
const DSH_DEMO_PACKAGE = "@deepseek-ai/dsh-acp-demo";

/** Packaged extraResources, else the repo `third_party/deepseek-harness/overlays`. */
export function dshHarnessOverlayDir(): string {
  const fromSource = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "third_party",
    "deepseek-harness",
    "overlays"
  );
  const packaged =
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "dsh-harness-overlays")
      : "";
  if (packaged && existsSync(packaged)) return packaged;
  return fromSource;
}

/**
 * Copy the thin harness-fork overlays onto an installed official runtime.
 * Official JSONL durable-publish aborts Windows Electron children with
 * STATUS_ACCESS_VIOLATION (0xC0000005) on session/prompt.
 *
 * Walk every nested `node_modules` copy. npm may hoist the JSONL package or
 * nest it under another `@deepseek-ai/*` plugin; covering only the prefix
 * root left the running import unpatched.
 */
export function findDshPackageDirs(root: string, packageName: string): string[] {
  const found = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (depth > 8) return;
    const nm = path.join(dir, "node_modules");
    if (!existsSync(nm)) return;
    const pkg = path.join(nm, packageName);
    if (existsSync(pkg)) found.add(pkg);
    let entries: string[] = [];
    try {
      entries = readdirSync(nm);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".bin" || name.startsWith(".")) continue;
      const child = path.join(nm, name);
      if (name.startsWith("@")) {
        let scoped: string[] = [];
        try {
          scoped = readdirSync(child);
        } catch {
          continue;
        }
        for (const nested of scoped) visit(path.join(child, nested), depth + 1);
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(root, 0);
  return [...found];
}

export function findDshPackageLibIndex(
  root: string,
  packageName: string
): string[] {
  return findDshPackageDirs(root, packageName)
    .map((dir) => path.join(dir, "lib", "index.js"))
    .filter((file) => existsSync(file));
}

const DSH_KOFFI_IMPORT_RE =
  /(?:import\(|from\s+|load\()["']koffi["']|koffi\.load/;

function fileUsesKoffi(file: string): boolean {
  try {
    return DSH_KOFFI_IMPORT_RE.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

function packageJsUsesKoffi(pkgDir: string): boolean {
  const lib = path.join(pkgDir, "lib");
  let names: string[] = [];
  try {
    names = existsSync(lib) ? readdirSync(lib) : [];
  } catch {
    return false;
  }
  return names.some(
    (name) => name.endsWith(".js") && fileUsesKoffi(path.join(lib, name))
  );
}

function toPosixRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

export function dshAcpJsonlStillUsesKoffi(root: string): string[] {
  return findDshPackageLibIndex(root, DSH_JSONL_PACKAGE).filter(fileUsesKoffi);
}

const DSH_WINDOWS_ACL_PACKAGE = "@deepseek-ai/dsh-sandbox-windows-acl";

export function dshAcpKoffiGuardPath(): string {
  const fromSource = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "assets",
    "dsh",
    "koffi-guard.mjs"
  );
  const packaged =
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "dsh", "koffi-guard.mjs")
      : "";
  if (packaged && existsSync(packaged)) return packaged;
  return fromSource;
}

export function dshAcpKoffiGuardImportFlag(): string | undefined {
  const file = dshAcpKoffiGuardPath();
  if (!existsSync(file)) return undefined;
  // Use a filesystem path. `file:///C:/...` is misparsed inside Windows
  // NODE_OPTIONS because of the drive colon, and PATH `.cmd` shims only
  // receive the guard through NODE_OPTIONS.
  return `--import=${file}`;
}

export interface DshAcpRuntimeDiagnostics {
  runtimePresent: boolean;
  overlayDirPresent: boolean;
  jsonlCopyCount: number;
  jsonlKoffiCopyCount: number;
  windowsAclPresent: boolean;
  windowsAclUsesKoffi: boolean;
  persistenceCompressionNone: boolean;
  sandboxDisabledOnWin32: boolean;
  koffiGuardPresent: boolean;
  spawnBin?: string;
  spawnKind?: string;
  koffiGuardOnArgv?: boolean;
  jsonlRelatives: Array<{ path: string; usesKoffi: boolean }>;
}

function classifyDshAcpSpawnKind(
  spawnBin: string | undefined,
  spawnArgs: string[] | undefined,
  runtimeRoot: string
): string | undefined {
  if (!spawnBin) return undefined;
  if (!isNodeBinary(spawnBin)) return dshAcpBinaryBaseName(spawnBin);
  const entry = spawnArgs?.find((arg) =>
    /dsh-acp-demo[/\\]lib[/\\]bin\.js$/i.test(arg)
  );
  if (!entry) return "node";
  const posix = entry.split(path.sep).join("/");
  const managed = runtimeRoot.split(path.sep).join("/");
  if (managed && posix.toLowerCase().includes(managed.toLowerCase())) {
    return "managed-node";
  }
  if (/\/npm\/node_modules\/@deepseek-ai\/dsh-acp-demo\/lib\/bin\.js$/i.test(posix)) {
    return "npm-global-node";
  }
  return "node-entry";
}

/** Snapshot of the managed DeepSeek runtime for debug-log export. */
export function buildDshAcpRuntimeDiagnostics(input: {
  runtimeRoot: string;
  overlayDir?: string;
  configPath?: string;
  spawnBin?: string;
  spawnArgs?: string[];
}): DshAcpRuntimeDiagnostics {
  const root = input.runtimeRoot;
  const overlayDir = input.overlayDir ?? dshHarnessOverlayDir();
  const jsonlFiles = findDshPackageLibIndex(root, DSH_JSONL_PACKAGE);
  const jsonlRelatives = jsonlFiles.map((file) => ({
    path: toPosixRelative(root, file),
    usesKoffi: fileUsesKoffi(file)
  }));
  const aclDirs = findDshPackageDirs(root, DSH_WINDOWS_ACL_PACKAGE);
  const configPath =
    input.configPath && existsSync(input.configPath)
      ? input.configPath
      : path.join(root, "cordis.yml");
  const cordis = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  return {
    runtimePresent: existsSync(root),
    overlayDirPresent: existsSync(overlayDir),
    jsonlCopyCount: jsonlFiles.length,
    jsonlKoffiCopyCount: jsonlRelatives.filter((file) => file.usesKoffi).length,
    windowsAclPresent: aclDirs.length > 0,
    windowsAclUsesKoffi: aclDirs.some((dir) => packageJsUsesKoffi(dir)),
    persistenceCompressionNone: /persistenceCompression:\s*none/.test(cordis),
    sandboxDisabledOnWin32:
      /dsh-sandbox-local[\s\S]{0,400}disabled:/.test(cordis),
    koffiGuardPresent: existsSync(dshAcpKoffiGuardPath()),
    spawnBin: input.spawnBin ? dshAcpBinaryBaseName(input.spawnBin) : undefined,
    spawnKind: classifyDshAcpSpawnKind(
      input.spawnBin,
      input.spawnArgs,
      root
    ),
    koffiGuardOnArgv: Boolean(
      input.spawnArgs?.some((arg) => arg.includes("koffi-guard"))
    ),
    jsonlRelatives
  };
}

export function patchDshAcpManagedRuntime(root: string): number {
  const overlayRoot = dshHarnessOverlayDir();
  const jsonlFrom = path.join(
    overlayRoot,
    "dsh-session-persistence-jsonl",
    "lib",
    "index.js"
  );
  const demoFrom = path.join(overlayRoot, "dsh-acp-demo", "lib", "index.js");
  let count = 0;
  try {
    if (existsSync(jsonlFrom)) {
      for (const dest of findDshPackageLibIndex(root, DSH_JSONL_PACKAGE)) {
        try {
          copyFileSync(jsonlFrom, dest);
          count += 1;
        } catch {
          /* ignore unwriteable / permission-restricted files */
        }
      }
    }
    if (existsSync(demoFrom)) {
      for (const dest of findDshPackageLibIndex(root, DSH_DEMO_PACKAGE)) {
        try {
          copyFileSync(demoFrom, dest);
        } catch {
          /* ignore unwriteable / permission-restricted files */
        }
      }
    }
  } catch {
    /* ignore unreadable overlay dirs */
  }
  return count;
}

/** Overlay the npm prefix that owns a `dsh-acp-demo` bin, including PATH installs. */
export function patchDshAcpRuntimeFromBin(binPath: string): void {
  try {
    const demoDir = resolveDshAcpDemoDirFromBinary(binPath);
    if (!demoDir) return;
    const scoped = path.dirname(demoDir);
    const nodeModules = path.dirname(scoped);
    const prefix = path.dirname(nodeModules);
    patchDshAcpManagedRuntime(prefix);
  } catch {
    /* ignore permission / traversal errors */
  }
}

export function patchDshAcpRuntimeFromCommand(command: {
  bin: string;
  args: string[];
}): void {
  const entry = isNodeBinary(command.bin)
    ? command.args.find((arg) => /dsh-acp-demo[/\\]lib[/\\]bin\.js$/i.test(arg))
    : command.bin;
  if (entry) patchDshAcpRuntimeFromBin(entry);
}

/** Clean up legacy package.json and lockfile in the managed runtime if they hold stale granular dependencies. */
export function cleanupLegacyDshAcpManagedFiles(root: string): void {
  const pkgJsonPath = path.join(root, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      const deps = { ...parsed.dependencies, ...parsed.devDependencies };
      if (deps["@deepseek-ai/dsh-acp-demo"] || !deps["deepseek-harness-acp"]) {
        unlinkSync(pkgJsonPath);
        const lockPath = path.join(root, "package-lock.json");
        if (existsSync(lockPath)) unlinkSync(lockPath);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Refresh the managed composition from the bundled default before spawn/install. */
export function syncDshAcpManagedConfig(dataDir: string): string {
  const root = dshAcpManagedRoot(dataDir);
  try {
    mkdirSync(root, { recursive: true });
    copyFileSync(bundledDshAcpConfigPath(), path.join(root, "cordis.yml"));
  } catch {
    /* ignore permission errors */
  }
  cleanupLegacyDshAcpManagedFiles(root);
  patchDshAcpManagedRuntime(root);
  return root;
}

export function dshAcpManagedDemoBin(dataDir: string): string {
  const root = dshAcpManagedRoot(dataDir);
  const standalone = path.join(
    root,
    "node_modules",
    "deepseek-harness-acp",
    "lib",
    "bin.js"
  );
  if (existsSync(standalone)) return standalone;
  return path.join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh-acp-demo",
    "lib",
    "bin.js"
  );
}

export function quoteForShell(value: string): string {
  if (process.platform === "win32") {
    if (!/[\s^&|<>]/.test(value)) {
      return value;
    }
    return `"${value.replace(/"/g, '""')}"`;
  }
  if (!/[\s'"\\$`*?#~&|;<>()\[\]{}]/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Walk up from `startDir` looking for `node_modules/<package>`. */
export function nodeModulesHasPackage(
  startDir: string,
  packageName: string
): boolean {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, "node_modules", packageName, "package.json"))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function resolveDshAcpDemoDirFromBinary(
  binPath: string
): string | undefined {
  let current = path.resolve(binPath);
  try {
    current = fsRealpath(binPath);
  } catch {
    /* keep resolved path */
  }
  if (/\.(cmd|ps1|bat)$/i.test(current)) {
    try {
      const text = readFileSync(current, "utf8");
      const match = text.match(
        /node_modules[/\\](@deepseek-ai[/\\]dsh-acp-demo|deepseek-harness-acp)[/\\]lib[/\\]bin\.js/i
      );
      if (match) {
        const relative = match[0]
          .replace(/[/\\]lib[/\\]bin\.js$/i, "")
          .replace(/\\/g, "/");
        const pkg = path.resolve(
          path.dirname(current),
          ...relative.split("/").filter(Boolean)
        );
        if (existsSync(path.join(pkg, "package.json"))) return pkg;
      }
    } catch {
      /* ignore unreadable shims */
    }
  }
  if (current.endsWith(`${path.sep}lib${path.sep}bin.js`)) {
    const pkg = path.dirname(path.dirname(current));
    if (existsSync(path.join(pkg, "package.json"))) return pkg;
  }
  return undefined;
}

export function isStandaloneDshAcpBinary(binary?: string): boolean {
  const base = dshAcpBinaryBaseName(binary ?? "");
  return base.startsWith("deepseek-harness-acp") || base.startsWith("dsh-acp");
}

export function dshAcpCompositionReady(
  binPath: string,
  configPath?: string
): boolean {
  const pkgDir = resolveDshAcpDemoDirFromBinary(binPath) ?? path.dirname(binPath);
  if (!nodeModulesHasPackage(pkgDir, DSH_ACP_PROBE_PACKAGE)) {
    return false;
  }
  const cfg = configPath && existsSync(configPath) ? configPath : undefined;
  if (cfg) {
    try {
      const packages = parseDshAcpCompositionPackages(readFileSync(cfg, "utf8"));
      return packages.every((pkg) => nodeModulesHasPackage(pkgDir, pkg));
    } catch {
      /* ignore unreadable config */
    }
  }
  return true;
}

/** Bare npm package names referenced by the bundled ACP composition. */
export function parseDshAcpCompositionPackages(yamlText: string): string[] {
  const names = new Set<string>();
  for (const match of yamlText.matchAll(
    /^\s*(?:-\s+)?name:\s*['"]?(@deepseek-ai\/[^'"\s]+)['"]?/gm
  )) {
    names.add(match[1].split("/").slice(0, 2).join("/"));
  }
  return [...names];
}

/**
 * `dsh-acp-demo` ships with `deps: none`. Installing only the bin leaves
 * cordis unable to import `@deepseek-ai/dsh-llm-deepseek` and the rest of
 * the official ACP plugin tree (`ERR_MODULE_NOT_FOUND`).
 */
export function dshAcpInstallCommand(options?: {
  yamlText?: string;
  prefix?: string;
  platform?: NodeJS.Platform;
}): string {
  const isWin = (options?.platform ?? process.platform) === "win32";
  const target = options?.prefix
    ? `--prefix ${quoteForShell(options.prefix)}`
    : "-g";
  const extra = isWin ? " @deepseek-ai/dsh-bash-local@next" : "";
  return `npm install ${target} deepseek-harness-acp${extra}`;
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
  /** Absolute multi-folder project roots; OpenCode gets external_directory allows when length > 1. */
  workspaceRoots?: string[];
  /** FreeBuddy-managed `runtimes/dsh-acp` prefix; used when no custom binary. */
  dshAcpRuntimeRoot?: string;
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

/** Build OpenCode OPENCODE_CONFIG_CONTENT object (model + multi-root permission). */
export function buildOpenCodeConfigContent(input: {
  model?: string;
  workspaceRoots?: string[];
}): Record<string, unknown> | undefined {
  const content: Record<string, unknown> = {};
  if (input.model) {
    content.model = input.model;
  }

  const roots = (input.workspaceRoots ?? [])
    .map((raw) => {
      if (typeof raw !== "string") return "";
      const trimmed = raw.trim();
      if (!trimmed) return "";
      try {
        return path.resolve(trimmed).replace(/[/\\]+$/, "");
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  const uniqueRoots = [...new Set(roots)];
  if (uniqueRoots.length > 1) {
    const externalDirectory: Record<string, "allow"> = {};
    for (const root of uniqueRoots) {
      const pattern = `${root.replace(/\\/g, "/")}/**`;
      externalDirectory[pattern] = "allow";
    }
    content.permission = { external_directory: externalDirectory };
  }

  return Object.keys(content).length > 0 ? content : undefined;
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
      const configContent = buildOpenCodeConfigContent({
        model,
        workspaceRoots: input.workspaceRoots
      });
      return {
        bin,
        args,
        ...(configContent
          ? { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent) } }
          : {}),
        promptViaStdin: false,
        protocol: "acp"
      };
    }
    case "cursor-agent-acp": {
      const { model, args: globalArgs } = splitModelArg(extra);
      const args: string[] = [];
      if (model) args.push("--model", model);
      args.push(...globalArgs, "acp");
      return {
        bin,
        args,
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
    case "agy-acp": {
      const args: string[] = [...extra];
      return {
        bin,
        args,
        promptViaStdin: false,
        protocol: "acp"
      };
    }
    case "zcode-acp": {
      const args: string[] = [...extra];
      return {
        bin,
        args,
        promptViaStdin: false,
        protocol: "acp"
      };
    }
    case "dsh-acp": {
      const nodeEntry = resolveDshAcpDemoBinJs({
        binary: input.binary,
        cwd: input.cwd,
        dshAcpRuntimeRoot: input.dshAcpRuntimeRoot
      });
      const args = extraArgsHaveDshConfig(extra)
        ? [...extra]
        : [
            "--config",
            resolveDshAcpConfigPath(input.cwd, input.dshAcpRuntimeRoot),
            ...extra
          ];
      if (nodeEntry) {
        return withDshAcpSqliteWarningSuppressed({
          bin: "node",
          args: [nodeEntry, ...args],
          promptViaStdin: false,
          protocol: "acp"
        });
      }
      return withDshAcpSqliteWarningSuppressed({
        bin,
        args,
        promptViaStdin: false,
        protocol: "acp"
      });
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

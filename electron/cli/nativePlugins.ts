import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";

import { getFreshWindowsEnvironment } from "./windowsEnv.js";

export type NativePluginAgent = "codex" | "claude";
export type NativePluginScope = "user" | "project" | "local" | "managed";

export interface NativePluginRecord {
  id: string;
  name: string;
  displayName?: string;
  marketplace?: string;
  version?: string;
  description?: string;
  installed: boolean;
  enabled: boolean;
  scope?: NativePluginScope;
  source?: string;
  updateAvailable?: boolean;
  iconPath?: string;
  iconPathDark?: string;
  brandColor?: string;
  managedBy?: "cli" | "desktop";
  mentionUri?: string;
}

export interface NativePluginMarketplace {
  name: string;
  source?: string;
  root?: string;
}

export interface NativePluginSnapshot {
  agent: NativePluginAgent;
  label: string;
  available: boolean;
  version?: string;
  error?: string;
  plugins: NativePluginRecord[];
  marketplaces: NativePluginMarketplace[];
  capabilities: {
    list: boolean;
    install: boolean;
    update: boolean;
    uninstall: boolean;
    marketplaces: boolean;
    scopes: NativePluginScope[];
  };
}

export interface NativePluginCommandResult {
  ok: true;
  agent: NativePluginAgent;
  output?: unknown;
  message?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
}

interface PluginCommand {
  binary: string;
  args: string[];
}

type PluginAction =
  | { type: "list" }
  | { type: "list-marketplaces" }
  | { type: "install"; pluginId: string; scope?: NativePluginScope }
  | { type: "update"; pluginId: string; marketplace?: string; scope?: NativePluginScope }
  | { type: "uninstall"; pluginId: string; scope?: NativePluginScope }
  | { type: "add-marketplace"; source: string; ref?: string; scope?: NativePluginScope }
  | { type: "update-marketplace"; marketplace?: string }
  | { type: "remove-marketplace"; marketplace: string };

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_PLUGIN_ICON_BYTES = 2 * 1024 * 1024;
const PLUGIN_ICON_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const AGENT_LABELS: Record<NativePluginAgent, string> = {
  codex: "Codex",
  claude: "Claude"
};

interface PluginPresentation {
  displayName?: string;
  description?: string;
  iconPath?: string;
  iconPathDark?: string;
  brandColor?: string;
}

interface CachedPluginPresentation {
  mtimeMs: number;
  size: number;
  presentation: PluginPresentation;
}

const pluginPresentationCache = new Map<string, CachedPluginPresentation>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeScope(value: unknown): NativePluginScope | undefined {
  return value === "user" || value === "project" || value === "local" || value === "managed"
    ? value
    : undefined;
}

function sourceValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const source = asRecord(value);
  if (!source) return undefined;
  return stringValue(
    source.path,
    source.repo,
    source.url,
    source.source,
    source.sourceType,
    source.type
  );
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePluginIconPath(pluginRoot: string, value: unknown): string | undefined {
  const asset = stringValue(value);
  if (!asset || /^\w+:\/\//.test(asset) || path.isAbsolute(asset)) return undefined;
  try {
    const realRoot = fs.realpathSync(pluginRoot);
    const realAsset = fs.realpathSync(path.resolve(pluginRoot, asset));
    if (!isWithinRoot(realRoot, realAsset)) return undefined;
    const stats = fs.statSync(realAsset);
    if (
      !stats.isFile()
      || stats.size > MAX_PLUGIN_ICON_BYTES
      || !PLUGIN_ICON_EXTENSIONS.has(path.extname(realAsset).toLowerCase())
    ) {
      return undefined;
    }
    return realAsset;
  } catch {
    return undefined;
  }
}

function normalizedBrandColor(value: unknown): string | undefined {
  const color = stringValue(value);
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

export function enrichPluginPresentation(
  plugin: NativePluginRecord,
  marketplaceRoot?: string
): NativePluginRecord {
  const pluginRoot = [plugin.source, marketplaceRoot].find((candidate) => {
    if (!candidate || !path.isAbsolute(candidate)) return false;
    try {
      return fs.statSync(path.join(candidate, ".codex-plugin", "plugin.json")).isFile();
    } catch {
      return false;
    }
  });
  if (!pluginRoot) return plugin;
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  try {
    const stats = fs.statSync(manifestPath);
    if (!stats.isFile() || stats.size > 1024 * 1024) return plugin;
    const cached = pluginPresentationCache.get(manifestPath);
    let presentation: PluginPresentation;
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      presentation = cached.presentation;
    } else {
      const manifest = asRecord(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      const pluginInterface = asRecord(manifest?.interface);
      const logo = stringValue(
        pluginInterface?.logo,
        pluginInterface?.icon,
        manifest?.icon,
        pluginInterface?.composerIcon,
        pluginInterface?.logoDark
      );
      const logoDark = stringValue(pluginInterface?.logoDark);
      const iconPath = resolvePluginIconPath(pluginRoot, logo);
      const iconPathDark = resolvePluginIconPath(pluginRoot, logoDark);
      const brandColor = normalizedBrandColor(pluginInterface?.brandColor);
      const displayName = stringValue(pluginInterface?.displayName);
      const description = stringValue(pluginInterface?.shortDescription, manifest?.description);
      presentation = {
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(iconPath ? { iconPath } : {}),
        ...(iconPathDark ? { iconPathDark } : {}),
        ...(brandColor ? { brandColor } : {})
      };
      pluginPresentationCache.set(manifestPath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        presentation
      });
    }
    return { ...plugin, ...presentation };
  } catch {
    return plugin;
  }
}

function normalizePlugin(
  value: unknown,
  installedFallback: boolean
): NativePluginRecord | undefined {
  const plugin = asRecord(value);
  if (!plugin) return undefined;
  const marketplace = stringValue(
    plugin.marketplaceName,
    plugin.marketplace,
    plugin.marketplace_name,
    plugin.sourceMarketplace
  );
  const name = stringValue(plugin.name, plugin.pluginName, plugin.plugin_name);
  const id = stringValue(
    plugin.pluginId,
    plugin.id,
    plugin.plugin_id,
    name && marketplace ? `${name}@${marketplace}` : name
  );
  if (!id) return undefined;
  const resolvedName = name ?? id.split("@")[0] ?? id;
  const installed = booleanValue(plugin.installed, installedFallback);
  return {
    id,
    name: resolvedName,
    ...(marketplace ? { marketplace } : {}),
    ...(marketplace ? { mentionUri: `plugin://${resolvedName}@${marketplace}` } : {}),
    ...(stringValue(plugin.version, plugin.installedVersion, plugin.installed_version)
      ? { version: stringValue(plugin.version, plugin.installedVersion, plugin.installed_version) }
      : {}),
    ...(stringValue(plugin.description, plugin.summary)
      ? { description: stringValue(plugin.description, plugin.summary) }
      : {}),
    installed,
    enabled: booleanValue(plugin.enabled, installed),
    ...(normalizeScope(plugin.scope) ? { scope: normalizeScope(plugin.scope) } : {}),
    ...(sourceValue(plugin.source) ? { source: sourceValue(plugin.source) } : {}),
    managedBy: "cli",
    ...(typeof plugin.updateAvailable === "boolean"
      ? { updateAvailable: plugin.updateAvailable }
      : typeof plugin.update_available === "boolean"
        ? { updateAvailable: plugin.update_available }
        : {})
  };
}

function directoryEntries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function newestCachedPluginRoot(pluginDirectory: string): string | undefined {
  const candidates = [
    pluginDirectory,
    ...directoryEntries(pluginDirectory)
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(pluginDirectory, entry.name))
  ];
  return candidates
    .flatMap((candidate) => {
      const manifestPath = path.join(candidate, ".codex-plugin", "plugin.json");
      try {
        const stats = fs.statSync(manifestPath);
        return stats.isFile() ? [{ candidate, mtimeMs: stats.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.candidate;
}

function desktopMarketplaceName(cacheName: string): string {
  return cacheName === "openai-curated-remote" ? "openai-curated" : cacheName;
}

export function listCodexDesktopPlugins(
  codexHome: string = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex")
): NativePluginRecord[] {
  const cacheRoot = path.join(codexHome, "plugins", "cache");
  const plugins: NativePluginRecord[] = [];
  for (const marketplaceEntry of directoryEntries(cacheRoot)) {
    if (!marketplaceEntry.isDirectory() || marketplaceEntry.name.startsWith(".")) continue;
    const marketplaceDirectory = path.join(cacheRoot, marketplaceEntry.name);
    const marketplace = desktopMarketplaceName(marketplaceEntry.name);
    for (const pluginEntry of directoryEntries(marketplaceDirectory)) {
      if (!pluginEntry.isDirectory() || pluginEntry.name.startsWith(".")) continue;
      const pluginRoot = newestCachedPluginRoot(path.join(marketplaceDirectory, pluginEntry.name));
      if (!pluginRoot) continue;
      const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
      try {
        const stats = fs.statSync(manifestPath);
        if (!stats.isFile() || stats.size > 1024 * 1024) continue;
        const manifest = asRecord(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
        const name = stringValue(manifest?.name, pluginEntry.name);
        if (!name) continue;
        plugins.push(enrichPluginPresentation({
          id: `${name}@${marketplace}`,
          name,
          marketplace,
          mentionUri: `plugin://${name}@${marketplaceEntry.name}`,
          ...(stringValue(manifest?.version) ? { version: stringValue(manifest?.version) } : {}),
          installed: true,
          enabled: true,
          source: pluginRoot,
          managedBy: "desktop"
        }));
      } catch {
        // Ignore incomplete cache entries while Codex is installing or updating a plugin.
      }
    }
  }
  return plugins.sort((left, right) =>
    (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name)
  );
}

export function mergeCodexDesktopPlugins(
  cliPlugins: NativePluginRecord[],
  desktopPlugins: NativePluginRecord[]
): NativePluginRecord[] {
  const merged = new Map(cliPlugins.map((plugin) => [plugin.id, plugin]));
  for (const desktopPlugin of desktopPlugins) {
    const cliPlugin = merged.get(desktopPlugin.id);
    if (!cliPlugin) {
      merged.set(desktopPlugin.id, desktopPlugin);
      continue;
    }
    merged.set(
      desktopPlugin.id,
      cliPlugin.installed
        ? {
            ...desktopPlugin,
            ...cliPlugin,
            displayName: desktopPlugin.displayName ?? cliPlugin.displayName,
            description: desktopPlugin.description ?? cliPlugin.description,
            iconPath: desktopPlugin.iconPath ?? cliPlugin.iconPath,
            iconPathDark: desktopPlugin.iconPathDark ?? cliPlugin.iconPathDark,
            brandColor: desktopPlugin.brandColor ?? cliPlugin.brandColor,
            managedBy: "cli"
          }
        : { ...cliPlugin, ...desktopPlugin, managedBy: "desktop" }
    );
  }
  return [...merged.values()].sort((left, right) => {
    if (left.installed !== right.installed) return left.installed ? -1 : 1;
    return (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name);
  });
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizePluginListPayload(payload: unknown): NativePluginRecord[] {
  const root = asRecord(payload);
  const entries: NativePluginRecord[] = [];
  const add = (values: unknown[], installed: boolean) => {
    for (const value of values) {
      const plugin = normalizePlugin(value, installed);
      if (plugin) entries.push(plugin);
    }
  };

  if (Array.isArray(payload)) {
    add(payload, true);
  } else if (root) {
    add(arrayValue(root.installed), true);
    add(arrayValue(root.available), false);
    if (!entries.length) add(arrayValue(root.plugins), true);
  }

  const byId = new Map<string, NativePluginRecord>();
  for (const plugin of entries) {
    const current = byId.get(plugin.id);
    if (!current || plugin.installed || !current.installed) byId.set(plugin.id, plugin);
  }
  return [...byId.values()].sort((left, right) => {
    if (left.installed !== right.installed) return left.installed ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function normalizeMarketplace(value: unknown, fallbackName?: string): NativePluginMarketplace | undefined {
  const marketplace = asRecord(value);
  if (!marketplace) {
    const name = stringValue(value, fallbackName);
    return name ? { name } : undefined;
  }
  const name = stringValue(marketplace.name, marketplace.marketplaceName, fallbackName);
  if (!name) return undefined;
  const source = sourceValue(marketplace.source);
  const root = stringValue(marketplace.root, marketplace.path);
  return {
    name,
    ...(source ? { source } : {}),
    ...(root ? { root } : {})
  };
}

export function normalizeMarketplacePayload(payload: unknown): NativePluginMarketplace[] {
  const root = asRecord(payload);
  const raw = root?.marketplaces ?? payload;
  const entries: NativePluginMarketplace[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const marketplace = normalizeMarketplace(value);
      if (marketplace) entries.push(marketplace);
    }
  } else {
    const record = asRecord(raw);
    if (record) {
      for (const [name, value] of Object.entries(record)) {
        const marketplace = normalizeMarketplace(value, name);
        if (marketplace) entries.push(marketplace);
      }
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function assertSafeArgument(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || trimmed.startsWith("-") || /[\0\r\n]/.test(trimmed)) {
    throw new Error(`Invalid ${label}`);
  }
  return trimmed;
}

function optionalScope(agent: NativePluginAgent, scope?: NativePluginScope): string[] {
  if (agent !== "claude" || !scope || scope === "managed") return [];
  return ["--scope", scope];
}

export function buildPluginCommand(agent: NativePluginAgent, action: PluginAction): PluginCommand[] {
  const binary = agent;
  switch (action.type) {
    case "list":
      return [{ binary, args: ["plugin", "list", "--available", "--json"] }];
    case "list-marketplaces":
      return [{ binary, args: ["plugin", "marketplace", "list", "--json"] }];
    case "install":
      return [{
        binary,
        args: [
          "plugin",
          agent === "codex" ? "add" : "install",
          assertSafeArgument(action.pluginId, "plugin id"),
          ...optionalScope(agent, action.scope),
          ...(agent === "codex" ? ["--json"] : [])
        ]
      }];
    case "update": {
      const pluginId = assertSafeArgument(action.pluginId, "plugin id");
      if (agent === "claude") {
        return [{
          binary,
          args: ["plugin", "update", pluginId, ...optionalScope(agent, action.scope)]
        }];
      }
      const marketplace = assertSafeArgument(
        action.marketplace ?? pluginId.split("@")[1] ?? "",
        "marketplace"
      );
      return [{ binary, args: ["plugin", "marketplace", "upgrade", marketplace, "--json"] }];
    }
    case "uninstall":
      return [{
        binary,
        args: [
          "plugin",
          agent === "codex" ? "remove" : "uninstall",
          assertSafeArgument(action.pluginId, "plugin id"),
          ...optionalScope(agent, action.scope),
          ...(agent === "codex" ? ["--json"] : [])
        ]
      }];
    case "add-marketplace":
    {
      const source = assertSafeArgument(action.source, "marketplace source");
      const ref = action.ref ? assertSafeArgument(action.ref, "ref") : undefined;
      return [{
        binary,
        args: [
          "plugin",
          "marketplace",
          "add",
          agent === "claude" && ref ? `${source}#${ref}` : source,
          ...(agent === "codex" && ref ? ["--ref", ref] : []),
          ...optionalScope(agent, action.scope),
          ...(agent === "codex" ? ["--json"] : [])
        ]
      }];
    }
    case "update-marketplace":
      return [{
        binary,
        args: [
          "plugin",
          "marketplace",
          agent === "codex" ? "upgrade" : "update",
          ...(action.marketplace
            ? [assertSafeArgument(action.marketplace, "marketplace")]
            : []),
          ...(agent === "codex" ? ["--json"] : [])
        ]
      }];
    case "remove-marketplace":
      return [{
        binary,
        args: [
          "plugin",
          "marketplace",
          "remove",
          assertSafeArgument(action.marketplace, "marketplace"),
          ...(agent === "codex" ? ["--json"] : [])
        ]
      }];
  }
}

async function runCommand(command: PluginCommand, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  let env: NodeJS.ProcessEnv;
  try {
    env = await getFreshWindowsEnvironment(process.env);
  } catch {
    env = { ...process.env };
  }
  return new Promise((resolve) => {
    const child = spawn(command.binary, command.args, { env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ stdout, stderr, exitCode: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-OUTPUT_LIMIT);
    });
    child.on("error", (error) => {
      finish({
        stdout,
        stderr,
        exitCode: null,
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error)
      });
    });
    child.on("close", (exitCode) => {
      finish({ stdout, stderr, exitCode, timedOut: false });
    });
  });
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    const start = [objectStart, arrayStart].filter((value) => value >= 0).sort((a, b) => a - b)[0];
    if (start === undefined) throw new Error("CLI returned invalid JSON");
    return JSON.parse(trimmed.slice(start));
  }
}

function commandFailure(agent: NativePluginAgent, result: CommandResult): Error {
  const detail = result.timedOut
    ? "command timed out"
    : result.spawnError || result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return new Error(`${AGENT_LABELS[agent]} plugin command failed: ${detail}`);
}

async function runJsonAction(
  agent: NativePluginAgent,
  action: PluginAction,
  binary: string = agent
): Promise<unknown> {
  let output: unknown;
  for (const command of buildPluginCommand(agent, action).map((entry) => ({
    ...entry,
    binary
  }))) {
    const result = await runCommand(command);
    if (result.exitCode !== 0 || result.spawnError || result.timedOut) {
      throw commandFailure(agent, result);
    }
    output = result.stdout.trim() ? parseJsonOutput(result.stdout) : result.stderr.trim() || undefined;
  }
  return output;
}

function embeddedClaudePackageName(): string | undefined {
  if (process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64")) {
    return `claude-agent-sdk-win32-${process.arch}`;
  }
  if (process.platform === "darwin" && (process.arch === "x64" || process.arch === "arm64")) {
    return `claude-agent-sdk-darwin-${process.arch}`;
  }
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    return `claude-agent-sdk-linux-${process.arch}`;
  }
  return undefined;
}

function embeddedClaudeCandidate(npmRoot: string): string | undefined {
  const platformPackage = embeddedClaudePackageName();
  if (!platformPackage) return undefined;
  const candidate = path.join(
    npmRoot,
    "@agentclientprotocol",
    "claude-agent-acp",
    "node_modules",
    "@anthropic-ai",
    platformPackage,
    process.platform === "win32" ? "claude.exe" : "claude"
  );
  try {
    return fs.statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function findEmbeddedClaudeBinary(): Promise<string | undefined> {
  const candidates = new Set<string>();
  if (process.env.APPDATA) candidates.add(path.join(process.env.APPDATA, "npm", "node_modules"));
  candidates.add(path.join(process.cwd(), "node_modules"));
  for (const entry of (process.env.NODE_PATH || "").split(path.delimiter)) {
    if (entry.trim()) candidates.add(entry.trim());
  }

  const npmRoot = await runCommand({ binary: "npm", args: ["root", "-g"] }, 10_000);
  if (npmRoot.exitCode === 0 && npmRoot.stdout.trim()) candidates.add(npmRoot.stdout.trim());
  for (const root of candidates) {
    const candidate = embeddedClaudeCandidate(root);
    if (candidate) return candidate;
  }
  return undefined;
}

interface AgentProbe {
  available: boolean;
  binary?: string;
  version?: string;
  error?: string;
}

async function probeAgent(agent: NativePluginAgent): Promise<AgentProbe> {
  let binary: string = agent;
  let result = await runCommand({ binary, args: ["--version"] }, 15_000);
  if (agent === "claude" && (result.exitCode !== 0 || result.spawnError || result.timedOut)) {
    const embedded = await findEmbeddedClaudeBinary();
    if (embedded) {
      binary = embedded;
      result = await runCommand({ binary, args: ["--version"] }, 15_000);
    }
  }
  if (result.exitCode !== 0 || result.spawnError || result.timedOut) {
    const error = result.timedOut
      ? "Version check timed out"
      : result.spawnError || result.stderr.trim() || "CLI is not installed";
    return { available: false, error };
  }
  return {
    available: true,
    binary,
    ...(stringValue(result.stdout.split(/\r?\n/)[0], result.stderr.split(/\r?\n/)[0])
      ? { version: stringValue(result.stdout.split(/\r?\n/)[0], result.stderr.split(/\r?\n/)[0]) }
      : {})
  };
}

export async function listNativePlugins(agent: NativePluginAgent): Promise<NativePluginSnapshot> {
  const probe = await probeAgent(agent);
  const capabilities = {
    list: probe.available,
    install: probe.available,
    update: probe.available,
    uninstall: probe.available,
    marketplaces: probe.available,
    scopes: (agent === "claude" ? ["user", "project", "local"] : ["user"]) as NativePluginScope[]
  };
  if (!probe.available) {
    return {
      agent,
      label: AGENT_LABELS[agent],
      available: false,
      ...(probe.error ? { error: probe.error } : {}),
      plugins: [],
      marketplaces: [],
      capabilities
    };
  }

  try {
    const [pluginsPayload, marketplacesPayload] = await Promise.all([
      runJsonAction(agent, { type: "list" }, probe.binary),
      runJsonAction(agent, { type: "list-marketplaces" }, probe.binary)
    ]);
    const marketplaces = normalizeMarketplacePayload(marketplacesPayload);
    const marketplaceRoots = new Map(
      marketplaces.flatMap((marketplace) =>
        marketplace.root ? [[marketplace.name, marketplace.root] as const] : []
      )
    );
    const cliPlugins = normalizePluginListPayload(pluginsPayload).map((plugin) =>
      enrichPluginPresentation(plugin, marketplaceRoots.get(plugin.marketplace ?? ""))
    );
    const plugins = agent === "codex"
      ? mergeCodexDesktopPlugins(cliPlugins, listCodexDesktopPlugins())
      : cliPlugins;
    return {
      agent,
      label: AGENT_LABELS[agent],
      available: true,
      ...(probe.version ? { version: probe.version } : {}),
      plugins,
      marketplaces,
      capabilities
    };
  } catch (error) {
    return {
      agent,
      label: AGENT_LABELS[agent],
      available: true,
      ...(probe.version ? { version: probe.version } : {}),
      error: error instanceof Error ? error.message : String(error),
      plugins: [],
      marketplaces: [],
      capabilities
    };
  }
}

async function mutate(agent: NativePluginAgent, action: PluginAction): Promise<NativePluginCommandResult> {
  const probe = await probeAgent(agent);
  if (!probe.available || !probe.binary) {
    throw new Error(`${AGENT_LABELS[agent]} CLI is unavailable: ${probe.error || "not installed"}`);
  }
  const output = await runJsonAction(agent, action, probe.binary);
  return {
    ok: true,
    agent,
    ...(output !== undefined && typeof output !== "string" ? { output } : {}),
    ...(typeof output === "string" && output ? { message: output } : {})
  };
}

export function installNativePlugin(
  agent: NativePluginAgent,
  pluginId: string,
  scope?: NativePluginScope
): Promise<NativePluginCommandResult> {
  return mutate(agent, { type: "install", pluginId, scope });
}

export function updateNativePlugin(
  agent: NativePluginAgent,
  pluginId: string,
  marketplace?: string,
  scope?: NativePluginScope
): Promise<NativePluginCommandResult> {
  return mutate(agent, { type: "update", pluginId, marketplace, scope });
}

export function uninstallNativePlugin(
  agent: NativePluginAgent,
  pluginId: string,
  scope?: NativePluginScope
): Promise<NativePluginCommandResult> {
  return mutate(agent, { type: "uninstall", pluginId, scope });
}

export function addNativePluginMarketplace(
  agent: NativePluginAgent,
  source: string,
  ref?: string,
  scope?: NativePluginScope
): Promise<NativePluginCommandResult> {
  return mutate(agent, { type: "add-marketplace", source, ref, scope });
}

export function updateNativePluginMarketplace(
  agent: NativePluginAgent,
  marketplace?: string
): Promise<NativePluginCommandResult> {
  return mutate(agent, { type: "update-marketplace", marketplace });
}

export function removeNativePluginMarketplace(
  agent: NativePluginAgent,
  marketplace: string
): Promise<NativePluginCommandResult> {
  return mutate(agent, { type: "remove-marketplace", marketplace });
}

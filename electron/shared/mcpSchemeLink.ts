export const MCP_SCHEME_MAX_URL_LENGTH = 32 * 1024;
export const MCP_SCHEME_MAX_PAYLOAD_BYTES = 32 * 1024;
export const MCP_SCHEME_MAX_ITEMS = 64;

export const SECRET_NAME_PATTERN =
  /(^|[-_.])(?:token|api[-_]?key|secret|password|passwd|pat|auth|credential)s?$/i;
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type McpSchemeLinkSource =
  | "freebuddy"
  | "freebuddy-dev"
  | "cursor"
  | "vscode"
  | "vscode-insiders";

export type McpSchemeLinkWarning = "name_normalized" | "contains_secrets";

export type McpSchemeLinkErrorCode =
  | "empty_link"
  | "too_large"
  | "invalid_url"
  | "unsupported_scheme"
  | "unsupported_route"
  | "invalid_config"
  | "multiple_servers_unsupported"
  | "invalid_transport"
  | "ambiguous_transport"
  | "missing_target"
  | "invalid_command"
  | "invalid_args"
  | "invalid_remote_url"
  | "invalid_env"
  | "invalid_header"
  | "invalid_auth_type"
  | "invalid_oauth_config";

export interface McpSchemeImportDraft {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string; secret?: boolean }>;
  url?: string;
  headers?: Array<{ name: string; value: string; secret: true }>;
  authType?: "headers" | "oauth";
  oauthClientId?: string;
  oauthScope?: string;
}

export type McpSchemeParseResult =
  | {
      ok: true;
      source: McpSchemeLinkSource;
      draft: McpSchemeImportDraft;
      warnings: McpSchemeLinkWarning[];
    }
  | {
      ok: false;
      source?: McpSchemeLinkSource;
      errorCode: McpSchemeLinkErrorCode;
    };

export interface McpSchemeImportEvent {
  id: string;
  source: McpSchemeLinkSource;
  draft?: McpSchemeImportDraft;
  warnings?: McpSchemeLinkWarning[];
  errorCode?: McpSchemeLinkErrorCode;
}

export interface BuildMcpSchemeLinkEnvEntry {
  name: string;
  value?: string;
  secret?: boolean;
  hasValue?: boolean;
}

export interface BuildMcpSchemeLinkInput {
  name: string;
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: BuildMcpSchemeLinkEnvEntry[];
  url?: string;
  headers?: BuildMcpSchemeLinkEnvEntry[];
  authType?: "headers" | "oauth";
  oauthClientId?: string;
  oauthScope?: string;
}

export interface BuildMcpSchemeLinkResult {
  url: string;
  strippedSecrets: boolean;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getRouteSegments(parsed: URL): string[] {
  const segments: string[] = [];
  if (parsed.hostname) {
    segments.push(parsed.hostname.toLowerCase());
  }
  for (const part of parsed.pathname.split("/")) {
    const clean = part.trim().toLowerCase();
    if (clean) segments.push(clean);
  }
  return segments;
}

function resolveSchemeSource(
  protocol: string,
  allowThirdPartySchemes: boolean
): McpSchemeLinkSource | null {
  switch (protocol.toLowerCase()) {
    case "freebuddy:":
      return "freebuddy";
    case "freebuddy-dev:":
      return "freebuddy-dev";
    case "cursor:":
      return allowThirdPartySchemes ? "cursor" : null;
    case "vscode:":
      return allowThirdPartySchemes ? "vscode" : null;
    case "vscode-insiders:":
      return allowThirdPartySchemes ? "vscode-insiders" : null;
    default:
      return null;
  }
}

function isSupportedRoute(
  source: McpSchemeLinkSource,
  segments: string[]
): boolean {
  if (source === "freebuddy" || source === "freebuddy-dev") {
    return (
      segments.length === 2 &&
      segments[0] === "mcp" &&
      (segments[1] === "install" || segments[1] === "import")
    );
  }
  if (source === "cursor") {
    return (
      (segments.length === 3 &&
        segments[0] === "anysphere.cursor-deeplink" &&
        segments[1] === "mcp" &&
        segments[2] === "install") ||
      (segments.length === 2 &&
        segments[0] === "mcp" &&
        segments[1] === "install")
    );
  }
  return (
    segments.length === 2 &&
    segments[0] === "mcp" &&
    segments[1] === "install"
  );
}

function encodeBase64Utf8(text: string): string {
  const bytes = textEncoder.encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function decodeBase64Utf8(
  raw: string
): { ok: true; text: string } | { ok: false; errorCode: "too_large" | "invalid_config" } {
  const normalized = raw
    .trim()
    .replace(/ /g, "+")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/[\r\n\t]/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return { ok: false, errorCode: "invalid_config" };
  }
  if (normalized.includes("=") && normalized.length % 4 !== 0) {
    return { ok: false, errorCode: "invalid_config" };
  }
  const remainder = normalized.length % 4;
  if (remainder === 1) {
    return { ok: false, errorCode: "invalid_config" };
  }
  const maxEncodedChars = Math.ceil((MCP_SCHEME_MAX_PAYLOAD_BYTES * 4) / 3) + 4;
  if (normalized.length > maxEncodedChars) {
    return { ok: false, errorCode: "too_large" };
  }
  const padded =
    remainder === 0 ? normalized : normalized + "=".repeat(4 - remainder);
  try {
    const binary = atob(padded);
    if (binary.length > MCP_SCHEME_MAX_PAYLOAD_BYTES) {
      return { ok: false, errorCode: "too_large" };
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const text = textDecoder.decode(bytes);
    return { ok: true, text };
  } catch {
    return { ok: false, errorCode: "invalid_config" };
  }
}

function parseJsonObjectString(
  jsonText: string
): { ok: true; value: Record<string, unknown> } | { ok: false; errorCode: "too_large" | "invalid_config" } {
  if (textEncoder.encode(jsonText).byteLength > MCP_SCHEME_MAX_PAYLOAD_BYTES) {
    return { ok: false, errorCode: "too_large" };
  }
  try {
    const parsed = JSON.parse(jsonText);
    if (!isPlainObject(parsed)) {
      return { ok: false, errorCode: "invalid_config" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, errorCode: "invalid_config" };
  }
}

function parseQueryConfigObject(
  parsed: URL
):
  | {
      ok: true;
      config: Record<string, unknown>;
      queryName?: string;
    }
  | {
      ok: false;
      errorCode: McpSchemeLinkErrorCode;
    } {
  const queryName = parsed.searchParams.get("name")?.trim() || undefined;
  const configParam = parsed.searchParams.get("config");

  if (configParam !== null) {
    const trimmed = configParam.trim();
    if (!trimmed) {
      return { ok: false, errorCode: "invalid_config" };
    }
    if (trimmed.startsWith("{")) {
      const jsonRes = parseJsonObjectString(trimmed);
      if (!jsonRes.ok) return jsonRes;
      return { ok: true, config: jsonRes.value, queryName };
    }
    const decodedRes = decodeBase64Utf8(trimmed);
    if (!decodedRes.ok) return decodedRes;
    const jsonRes = parseJsonObjectString(decodedRes.text);
    if (!jsonRes.ok) return jsonRes;
    return { ok: true, config: jsonRes.value, queryName };
  }

  const rawQuery = parsed.search.startsWith("?") ? parsed.search.slice(1) : "";
  if (rawQuery) {
    try {
      const decodedQuery = decodeURIComponent(rawQuery);
      if (decodedQuery.trimStart().startsWith("{")) {
        const jsonRes = parseJsonObjectString(decodedQuery.trim());
        if (!jsonRes.ok) return jsonRes;
        return { ok: true, config: jsonRes.value, queryName };
      }
    } catch {
      const trimmedRaw = rawQuery.trimStart();
      if (trimmedRaw.startsWith("{") || /^%7b/i.test(trimmedRaw)) {
        return { ok: false, errorCode: "invalid_config" };
      }
    }
  }

  const direct: Record<string, unknown> = {};
  const name = parsed.searchParams.get("name");
  if (name !== null) direct.name = name;
  const transport =
    parsed.searchParams.get("transport") ?? parsed.searchParams.get("type");
  if (transport !== null) direct.transport = transport;
  const command = parsed.searchParams.get("command");
  if (command !== null) direct.command = command;

  const argItems = parsed.searchParams.getAll("arg");
  if (argItems.length > 0) {
    direct.args = argItems;
  } else {
    const argsItems = parsed.searchParams.getAll("args");
    if (argsItems.length === 1 && argsItems[0]!.trimStart().startsWith("[")) {
      try {
        const parsedArgs = JSON.parse(argsItems[0]!);
        if (!Array.isArray(parsedArgs)) {
          return { ok: false, errorCode: "invalid_args" };
        }
        direct.args = parsedArgs;
      } catch {
        return { ok: false, errorCode: "invalid_args" };
      }
    } else if (argsItems.length > 0) {
      direct.args = argsItems;
    }
  }

  const url =
    parsed.searchParams.get("url") ??
    parsed.searchParams.get("serverUrl") ??
    parsed.searchParams.get("httpUrl");
  if (url !== null) direct.url = url;

  const authType = parsed.searchParams.get("authType");
  if (authType !== null) direct.authType = authType;
  const oauthClientId = parsed.searchParams.get("oauthClientId");
  if (oauthClientId !== null) direct.oauthClientId = oauthClientId;
  const oauthScope = parsed.searchParams.get("oauthScope");
  if (oauthScope !== null) direct.oauthScope = oauthScope;

  const envParam = parsed.searchParams.get("env");
  if (envParam !== null) {
    try {
      direct.env = JSON.parse(envParam);
    } catch {
      return { ok: false, errorCode: "invalid_env" };
    }
  }

  const headersParam = parsed.searchParams.get("headers");
  if (headersParam !== null) {
    try {
      direct.headers = JSON.parse(headersParam);
    } catch {
      return { ok: false, errorCode: "invalid_header" };
    }
  }

  return { ok: true, config: direct, queryName };
}

function unwrapServerContainer(
  config: Record<string, unknown>,
  queryName?: string
):
  | {
      ok: true;
      config: Record<string, unknown>;
      fallbackName?: string;
    }
  | {
      ok: false;
      errorCode: McpSchemeLinkErrorCode;
    } {
  const hasDirectTarget =
    config.command !== undefined ||
    config.url !== undefined ||
    config.serverUrl !== undefined ||
    config.httpUrl !== undefined;
  const container = isPlainObject(config.mcpServers)
    ? config.mcpServers
    : isPlainObject(config.servers)
      ? config.servers
      : null;
  if (!container || hasDirectTarget) {
    return { ok: true, config };
  }
  const entries = Object.entries(container);
  if (entries.length === 0) {
    return { ok: false, errorCode: "invalid_config" };
  }
  if (queryName) {
    const exact = entries.find(([key]) => key === queryName);
    const matched =
      exact ??
      entries.find(([key]) => key.toLowerCase() === queryName.toLowerCase());
    if (matched) {
      if (!isPlainObject(matched[1])) {
        return { ok: false, errorCode: "invalid_config" };
      }
      return { ok: true, config: matched[1], fallbackName: matched[0] };
    }
  }
  if (entries.length === 1) {
    const [entryName, entryConfig] = entries[0]!;
    if (!isPlainObject(entryConfig)) {
      return { ok: false, errorCode: "invalid_config" };
    }
    return { ok: true, config: entryConfig, fallbackName: entryName };
  }
  return { ok: false, errorCode: "multiple_servers_unsupported" };
}

function normalizeServerName(rawName: string): {
  name: string;
  normalized: boolean;
} {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return { name: "", normalized: false };
  }
  if (MCP_NAME_PATTERN.test(trimmed)) {
    return { name: trimmed, normalized: false };
  }
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return { name: sanitized, normalized: true };
}

function normalizeTransportValue(
  raw: unknown
): "stdio" | "http" | "sse" | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return "invalid";
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === "stdio") return "stdio";
  if (
    trimmed === "http" ||
    trimmed === "streamable-http" ||
    trimmed === "streamable_http" ||
    trimmed === "streamablehttp" ||
    trimmed === "remote"
  ) {
    return "http";
  }
  if (trimmed === "sse") return "sse";
  return "invalid";
}

function validateRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function parseEnvEntries(
  raw: unknown
):
  | {
      ok: true;
      env: Array<{ name: string; value: string; secret?: boolean }>;
      hasSecrets: boolean;
    }
  | { ok: false } {
  if (raw === undefined) {
    return { ok: true, env: [], hasSecrets: false };
  }
  const result: Array<{ name: string; value: string; secret?: boolean }> = [];
  const seen = new Set<string>();
  let hasSecrets = false;

  const pushEntry = (
    rawKey: string,
    rawVal: unknown,
    explicitSecret?: boolean
  ): boolean => {
    const name = rawKey.trim();
    if (!name || /[\r\n\0=]/.test(name)) return false;
    if (rawVal !== undefined && (typeof rawVal !== "string" || /\0/.test(rawVal))) {
      return false;
    }
    if (seen.has(name)) return true;
    seen.add(name);
    const value = rawVal ?? "";
    const secret = explicitSecret === true || SECRET_NAME_PATTERN.test(name);
    if (secret && value.trim().length > 0) {
      hasSecrets = true;
    }
    result.push(secret ? { name, value, secret: true } : { name, value });
    return true;
  };

  if (isPlainObject(raw)) {
    const entries = Object.entries(raw);
    if (entries.length > MCP_SCHEME_MAX_ITEMS) return { ok: false };
    for (const [key, value] of entries) {
      if (typeof value !== "string" || !pushEntry(key, value)) {
        return { ok: false };
      }
    }
    return { ok: true, env: result, hasSecrets };
  }

  if (Array.isArray(raw)) {
    if (raw.length > MCP_SCHEME_MAX_ITEMS) return { ok: false };
    for (const item of raw) {
      if (!isPlainObject(item) || typeof item.name !== "string") {
        return { ok: false };
      }
      if (
        item.secret !== undefined &&
        typeof item.secret !== "boolean"
      ) {
        return { ok: false };
      }
      if (!pushEntry(item.name, item.value, item.secret)) {
        return { ok: false };
      }
    }
    return { ok: true, env: result, hasSecrets };
  }

  return { ok: false };
}

function parseHeaderEntries(
  raw: unknown
):
  | {
      ok: true;
      headers: Array<{ name: string; value: string; secret: true }>;
      hasSecrets: boolean;
    }
  | { ok: false } {
  if (raw === undefined) {
    return { ok: true, headers: [], hasSecrets: false };
  }
  const result: Array<{ name: string; value: string; secret: true }> = [];
  const seenLower = new Set<string>();
  let hasSecrets = false;

  const pushHeader = (rawKey: string, rawVal: unknown): boolean => {
    const name = rawKey.trim();
    if (!HEADER_NAME_PATTERN.test(name)) return false;
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) return false;
    seenLower.add(lower);
    if (
      rawVal !== undefined &&
      (typeof rawVal !== "string" || /[^\t\x20-\x7e\x80-\xff]/.test(rawVal))
    ) {
      return false;
    }
    const value = rawVal ?? "";
    if (value.trim().length > 0) {
      hasSecrets = true;
    }
    result.push({ name, value, secret: true });
    return true;
  };

  if (isPlainObject(raw)) {
    const entries = Object.entries(raw);
    if (entries.length > MCP_SCHEME_MAX_ITEMS) return { ok: false };
    for (const [key, value] of entries) {
      if (typeof value !== "string" || !pushHeader(key, value)) {
        return { ok: false };
      }
    }
    return { ok: true, headers: result, hasSecrets };
  }

  if (Array.isArray(raw)) {
    if (raw.length > MCP_SCHEME_MAX_ITEMS) return { ok: false };
    for (const item of raw) {
      if (!isPlainObject(item) || typeof item.name !== "string") {
        return { ok: false };
      }
      if (!pushHeader(item.name, item.value)) {
        return { ok: false };
      }
    }
    return { ok: true, headers: result, hasSecrets };
  }

  return { ok: false };
}

function parseOptionalOAuthText(raw: unknown): { ok: true; value?: string } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string" || /[\x00-\x1f\x7f]/.test(raw) || raw.length > 2048) {
    return { ok: false };
  }
  return { ok: true, value: raw.trim() || undefined };
}

export function findSchemeUrlInArgv(argv: readonly string[]): string | undefined {
  for (const rawArg of argv) {
    if (typeof rawArg !== "string") continue;
    const unwrapped = unwrapQuotes(rawArg);
    if (/^freebuddy(?:-dev)?:\/\//i.test(unwrapped)) {
      return unwrapped;
    }
  }
  return undefined;
}

export function isMcpSchemeUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "freebuddy:" && protocol !== "freebuddy-dev:") {
      return false;
    }
    const segments = getRouteSegments(parsed);
    return segments[0] === "mcp";
  } catch {
    return false;
  }
}

export function parseMcpSchemeLink(
  raw: string,
  options?: { allowThirdPartySchemes?: boolean }
): McpSchemeParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, errorCode: "empty_link" };
  }
  if (trimmed.length > MCP_SCHEME_MAX_URL_LENGTH) {
    return { ok: false, errorCode: "too_large" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, errorCode: "invalid_url" };
  }

  const allowThirdParty = options?.allowThirdPartySchemes === true;
  const source = resolveSchemeSource(parsed.protocol, allowThirdParty);
  if (!source) {
    return { ok: false, errorCode: "unsupported_scheme" };
  }

  const segments = getRouteSegments(parsed);
  if (!isSupportedRoute(source, segments)) {
    return { ok: false, source, errorCode: "unsupported_route" };
  }

  const extracted = parseQueryConfigObject(parsed);
  if (!extracted.ok) {
    return { ok: false, source, errorCode: extracted.errorCode };
  }

  const unwrapped = unwrapServerContainer(extracted.config, extracted.queryName);
  if (!unwrapped.ok) {
    return { ok: false, source, errorCode: unwrapped.errorCode };
  }

  const cfg = unwrapped.config;
  const candidateName =
    extracted.queryName ??
    (typeof cfg.name === "string" && cfg.name.trim()
      ? cfg.name.trim()
      : unwrapped.fallbackName ?? "");

  const warnings: McpSchemeLinkWarning[] = [];
  const { name, normalized: nameNormalized } = normalizeServerName(candidateName);
  if (nameNormalized) {
    warnings.push("name_normalized");
  }

  const explicitTransport = normalizeTransportValue(cfg.transport ?? cfg.type);
  if (explicitTransport === "invalid") {
    return { ok: false, source, errorCode: "invalid_transport" };
  }

  const rawCommand = cfg.command;
  const rawUrl = cfg.url ?? cfg.serverUrl ?? cfg.httpUrl;
  const hasCommand = rawCommand !== undefined && rawCommand !== "";
  const hasUrl = rawUrl !== undefined && rawUrl !== "";

  let transport: "stdio" | "http" | "sse";
  if (explicitTransport) {
    transport = explicitTransport;
  } else {
    if (hasCommand && hasUrl) {
      return { ok: false, source, errorCode: "ambiguous_transport" };
    }
    if (!hasCommand && !hasUrl) {
      return { ok: false, source, errorCode: "missing_target" };
    }
    if (hasCommand) {
      transport = "stdio";
    } else {
      const validUrl = validateRemoteUrl(rawUrl);
      if (!validUrl) {
        return { ok: false, source, errorCode: "invalid_remote_url" };
      }
      const pathname = new URL(validUrl).pathname.toLowerCase().replace(/\/+$/, "");
      transport = pathname.endsWith("/sse") ? "sse" : "http";
    }
  }

  if (transport === "stdio") {
    if (
      typeof rawCommand !== "string" ||
      !rawCommand.trim() ||
      /[\r\n\0]/.test(rawCommand)
    ) {
      return { ok: false, source, errorCode: "invalid_command" };
    }
    let args: string[] = [];
    if (cfg.args !== undefined) {
      if (
        !Array.isArray(cfg.args) ||
        cfg.args.length > MCP_SCHEME_MAX_ITEMS ||
        cfg.args.some((item) => typeof item !== "string" || /[\r\n\0]/.test(item))
      ) {
        return { ok: false, source, errorCode: "invalid_args" };
      }
      args = [...cfg.args];
    }
    const envResult = parseEnvEntries(cfg.env);
    if (!envResult.ok) {
      return { ok: false, source, errorCode: "invalid_env" };
    }
    if (envResult.hasSecrets) {
      warnings.push("contains_secrets");
    }
    return {
      ok: true,
      source,
      draft: {
        name,
        transport: "stdio",
        command: rawCommand.trim(),
        args,
        env: envResult.env
      },
      warnings
    };
  }

  const validUrl = validateRemoteUrl(rawUrl);
  if (!validUrl) {
    return { ok: false, source, errorCode: "invalid_remote_url" };
  }

  const rawAuthType = cfg.authType;
  let authType: "headers" | "oauth" = "headers";
  if (rawAuthType !== undefined) {
    if (rawAuthType !== "headers" && rawAuthType !== "oauth") {
      return { ok: false, source, errorCode: "invalid_auth_type" };
    }
    authType = rawAuthType;
  }

  if (authType === "oauth") {
    const clientIdRes = parseOptionalOAuthText(cfg.oauthClientId);
    const scopeRes = parseOptionalOAuthText(cfg.oauthScope);
    if (!clientIdRes.ok || !scopeRes.ok) {
      return { ok: false, source, errorCode: "invalid_oauth_config" };
    }
    return {
      ok: true,
      source,
      draft: {
        name,
        transport,
        url: validUrl,
        authType: "oauth",
        headers: [],
        oauthClientId: clientIdRes.value,
        oauthScope: scopeRes.value
      },
      warnings
    };
  }

  const headerResult = parseHeaderEntries(cfg.headers);
  if (!headerResult.ok) {
    return { ok: false, source, errorCode: "invalid_header" };
  }
  if (headerResult.hasSecrets) {
    warnings.push("contains_secrets");
  }

  return {
    ok: true,
    source,
    draft: {
      name,
      transport,
      url: validUrl,
      authType: "headers",
      headers: headerResult.headers
    },
    warnings
  };
}

function redactShareArgs(args: string[]): {
  args: string[];
  strippedSecrets: boolean;
} {
  const out: string[] = [];
  let strippedSecrets = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const keyWithPrefix = arg.slice(0, eqIdx);
      const rawKey = keyWithPrefix.replace(/^-{1,2}/, "");
      const val = arg.slice(eqIdx + 1);
      if (/^[A-Za-z0-9_.-]+$/.test(rawKey) && SECRET_NAME_PATTERN.test(rawKey)) {
        if (val.trim().length > 0) {
          strippedSecrets = true;
        }
        out.push(`${keyWithPrefix}=`);
        continue;
      }
    }

    const flag = arg.match(/^-{1,2}([A-Za-z0-9_.-]+)$/);
    if (
      flag &&
      SECRET_NAME_PATTERN.test(flag[1]!) &&
      i + 1 < args.length &&
      !args[i + 1]!.startsWith("-")
    ) {
      out.push(arg);
      if (args[i + 1]!.trim().length > 0) {
        strippedSecrets = true;
      }
      out.push("");
      i += 1;
      continue;
    }

    if (/Bearer\s+\S+/i.test(arg)) {
      strippedSecrets = true;
      out.push(arg.replace(/(Bearer\s+)\S+/gi, "$1"));
      continue;
    }

    out.push(arg);
  }

  return { args: out, strippedSecrets };
}

export function buildMcpSchemeLink(
  server: BuildMcpSchemeLinkInput,
  options?: { scheme?: "freebuddy" | "freebuddy-dev" }
): BuildMcpSchemeLinkResult {
  const scheme = options?.scheme ?? "freebuddy";
  const transport = server.transport ?? "stdio";
  let strippedSecrets = false;
  let config: Record<string, unknown>;

  if (transport === "stdio") {
    const redactedArgs = redactShareArgs(server.args ?? []);
    if (redactedArgs.strippedSecrets) {
      strippedSecrets = true;
    }
    const envObj: Record<string, string> = {};
    for (const entry of server.env ?? []) {
      const name = entry.name.trim();
      if (!name) continue;
      const isSecret = entry.secret === true || SECRET_NAME_PATTERN.test(name);
      if (isSecret) {
        envObj[name] = "";
        if (entry.hasValue || (entry.value !== undefined && entry.value.trim().length > 0)) {
          strippedSecrets = true;
        }
      } else {
        envObj[name] = entry.value ?? "";
      }
    }
    config = {
      command: server.command ?? "",
      ...(redactedArgs.args.length > 0 ? { args: redactedArgs.args } : {}),
      ...(Object.keys(envObj).length > 0 ? { env: envObj } : {})
    };
  } else if (server.authType === "oauth") {
    config = {
      type: transport,
      url: server.url ?? "",
      authType: "oauth",
      ...(server.oauthClientId?.trim() ? { oauthClientId: server.oauthClientId.trim() } : {}),
      ...(server.oauthScope?.trim() ? { oauthScope: server.oauthScope.trim() } : {})
    };
  } else {
    const headersObj: Record<string, string> = {};
    for (const header of server.headers ?? []) {
      const name = header.name.trim();
      if (!name) continue;
      headersObj[name] = "";
      if (header.hasValue || (header.value !== undefined && header.value.trim().length > 0)) {
        strippedSecrets = true;
      }
    }
    config = {
      type: transport,
      url: server.url ?? "",
      ...(Object.keys(headersObj).length > 0 ? { headers: headersObj } : {})
    };
  }

  const encoded = encodeBase64Utf8(JSON.stringify(config));
  const url = `${scheme}://mcp/install?name=${encodeURIComponent(
    server.name.trim()
  )}&config=${encodeURIComponent(encoded)}`;

  return { url, strippedSecrets };
}

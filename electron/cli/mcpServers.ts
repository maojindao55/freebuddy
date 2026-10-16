import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";
import { getDb } from "./db.js";
import { getConversationMcpServerIds } from "./conversations.js";
import { encryptSecret, decryptSecret, redactApiKey, isSecretStorageAvailable } from "./store.js";
import { logMain } from "../debugLog.js";
import { isCallerAdmin, getCallerUserId } from "./callerContext.js";
import { killProcessTree } from "./process-kill.js";

const MCP_NAME_PREFIX_RESERVED = "freebuddy";
const MCP_RESERVED_NAMES = new Set([
  "office-engine",
  "freebuddy-browser",
  "freebuddy-butler",
  "freebuddy-context",
  "freebuddy-delegate",
  "freebuddy-game",
  "freebuddy-skills",
  "freebuddy-workspace-fs"
]);
const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const MCP_SELF_CHECK_TIMEOUT_MS = 15_000;
const SECRET_ARG_PATTERN = /(?:^|.*?)(?:token|key|secret|password|pat)=([^\s]+)$/i;

export interface UserMcpServerEnvVar {
  name: string;
  value?: string;
  valuePreview?: string;
  valueEncrypted?: string;
  secret?: boolean;
  hasValue?: boolean;
  previousName?: string;
}

export interface UserMcpServerInput {
  id?: string;
  name: string;
  command: string;
  args?: string[];
  env?: UserMcpServerEnvVar[];
  enabled?: boolean;
}

export interface UserMcpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: UserMcpServerEnvVar[];
  enabled: boolean;
  lastCheckStatus?: "ok" | "error";
  lastCheckError?: string;
  lastCheckTools?: string[];
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserMcpServerSelfCheckResult {
  status: "ok" | "error";
  error?: string;
  tools?: string[];
  stderr?: string;
}

function parseEnv(raw: string | null): UserMcpServerEnvVar[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is UserMcpServerEnvVar =>
        e && typeof e === "object" && typeof e.name === "string"
    );
  } catch {
    return [];
  }
}

function parseArgs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((a): a is string => typeof a === "string")
      : [];
  } catch {
    return [];
  }
}

function parseTools(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToServer(r: any): UserMcpServer {
  return {
    id: r.id,
    name: r.name,
    command: r.command,
    args: parseArgs(r.args),
    env: parseEnv(r.env),
    enabled: r.enabled === 1,
    lastCheckStatus:
      r.last_check_status === "ok" || r.last_check_status === "error"
        ? r.last_check_status
        : undefined,
    lastCheckError: r.last_check_error ?? undefined,
    lastCheckTools: parseTools(r.last_check_tools),
    lastCheckedAt: r.last_checked_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function sanitizeEnvForRenderer(env: UserMcpServerEnvVar[]): UserMcpServerEnvVar[] {
  return env.map((e) => {
    if (e.secret) {
      return {
        name: e.name,
        valuePreview: e.valuePreview,
        secret: true,
        hasValue: Boolean(e.valueEncrypted || e.value)
      };
    }
    return { name: e.name, value: e.value };
  });
}

function serverForRenderer(server: UserMcpServer): UserMcpServer {
  return {
    ...server,
    env: sanitizeEnvForRenderer(server.env)
  };
}

function normalizeEnvForStorage(
  env: UserMcpServerEnvVar[] | undefined,
  previousEnv: UserMcpServerEnvVar[] = []
): UserMcpServerEnvVar[] {
  if (!env) return previousEnv;
  const previousByName = new Map(previousEnv.map((e) => [e.name, e]));
  const seenNames = new Set<string>();
  const result: UserMcpServerEnvVar[] = [];
  for (const e of env) {
    const normalizedName = e.name.trim();
    if (!normalizedName || seenNames.has(normalizedName)) continue;
    seenNames.add(normalizedName);
    const previousName = e.previousName?.trim();
    const prev =
      previousByName.get(normalizedName) ??
      (previousName ? previousByName.get(previousName) : undefined);
    const isSecret = e.secret === true;
    if (isSecret && e.value !== undefined && e.value.trim()) {
      result.push({
        name: normalizedName,
        valueEncrypted: encryptSecret(e.value.trim()),
        valuePreview: redactApiKey(e.value.trim()),
        secret: true
      });
    } else if (isSecret && !e.value?.trim() && prev?.valueEncrypted) {
      result.push({
        name: normalizedName,
        valueEncrypted: prev.valueEncrypted,
        valuePreview: prev.valuePreview,
        secret: true
      });
    } else if (!isSecret && e.value !== undefined) {
      result.push({
        name: normalizedName,
        value: e.value
      });
    } else if (prev) {
      result.push(prev);
    } else {
      result.push({ name: normalizedName });
    }
  }
  return result;
}

function validateServerName(name: string, existingId?: string): void {
  const raw = name.trim();
  if (!MCP_NAME_PATTERN.test(raw)) {
    throw new Error(
      "Server name must match ^[A-Za-z0-9_-]{1,48}$"
    );
  }
  const trimmed = raw.toLowerCase();
  if (trimmed.startsWith(MCP_NAME_PREFIX_RESERVED)) {
    throw new Error(
      `Server name cannot start with reserved prefix "${MCP_NAME_PREFIX_RESERVED}"`
    );
  }
  if (MCP_RESERVED_NAMES.has(trimmed)) {
    throw new Error(
      `Server name "${name.trim()}" is reserved for builtin MCP servers`
    );
  }
  const existing = getDb()
    .prepare("SELECT id FROM user_mcp_servers WHERE LOWER(name) = ?")
    .get(trimmed) as { id: string } | undefined;
  if (existing && existing.id !== existingId) {
    throw new Error(
      `A server named "${name.trim()}" already exists (case-insensitive)`
    );
  }
}

function listUserMcpServersInternal(): UserMcpServer[] {
  const rows = getDb()
    .prepare("SELECT * FROM user_mcp_servers ORDER BY name ASC")
    .all() as any[];
  return rows.map(rowToServer);
}

export function listUserMcpServers(): UserMcpServer[] {
  return listUserMcpServersInternal().map(serverForRenderer);
}

function getUserMcpServerInternal(id: string): UserMcpServer | undefined {
  const row = getDb()
    .prepare("SELECT * FROM user_mcp_servers WHERE id = ?")
    .get(id) as any;
  return row ? rowToServer(row) : undefined;
}

export function getUserMcpServer(id: string): UserMcpServer | undefined {
  const server = getUserMcpServerInternal(id);
  return server ? serverForRenderer(server) : undefined;
}

export function createUserMcpServer(
  input: UserMcpServerInput
): UserMcpServer {
  validateServerName(input.name);
  const id = input.id || `mcp-${nanoid(8)}`;
  const now = new Date().toISOString();
  const env = normalizeEnvForStorage(input.env);
  getDb()
    .prepare(
      `INSERT INTO user_mcp_servers
         (id, name, command, args, env, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.name.trim(),
      input.command.trim(),
      JSON.stringify(input.args ?? []),
      JSON.stringify(env),
      input.enabled !== false ? 1 : 0,
      now,
      now
    );
  return getUserMcpServer(id)!;
}

export function updateUserMcpServer(
  id: string,
  input: Partial<UserMcpServerInput>
): UserMcpServer | undefined {
  const existing = getUserMcpServerInternal(id);
  if (!existing) return undefined;
  if (input.name !== undefined) {
    validateServerName(input.name, id);
  }
  const now = new Date().toISOString();
  const env = normalizeEnvForStorage(input.env, existing.env);
  const updates: string[] = ["updated_at = ?"];
  const params: any[] = [now];

  if (input.name !== undefined) {
    updates.push("name = ?");
    params.push(input.name.trim());
  }
  if (input.command !== undefined) {
    updates.push("command = ?");
    params.push(input.command.trim());
  }
  if (input.args !== undefined) {
    updates.push("args = ?");
    params.push(JSON.stringify(input.args));
  }
  if (input.env !== undefined) {
    updates.push("env = ?");
    params.push(JSON.stringify(env));
  }
  if (input.enabled !== undefined) {
    updates.push("enabled = ?");
    params.push(input.enabled ? 1 : 0);
  }

  params.push(id);
  getDb()
    .prepare(`UPDATE user_mcp_servers SET ${updates.join(", ")} WHERE id = ?`)
    .run(...params);
  return getUserMcpServer(id);
}

export function deleteUserMcpServer(id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM user_mcp_servers WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function setUserMcpServerEnabled(id: string, enabled: boolean): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      "UPDATE user_mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?"
    )
    .run(enabled ? 1 : 0, now, id);
  return result.changes > 0;
}

function updateSelfCheckResult(
  id: string,
  result: UserMcpServerSelfCheckResult
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE user_mcp_servers SET
         last_check_status = ?,
         last_check_error = ?,
         last_check_tools = ?,
         last_checked_at = ?
       WHERE id = ?`
    )
    .run(
      result.status,
      result.error ?? null,
      result.tools ? JSON.stringify(result.tools) : null,
      now,
      id
    );
}

export function resolveEnvForRuntime(
  env: UserMcpServerEnvVar[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const e of env) {
    if (e.value !== undefined) {
      result[e.name] = e.value;
    } else if (e.valueEncrypted) {
      const decrypted = decryptSecret(e.valueEncrypted);
      if (decrypted) result[e.name] = decrypted;
    }
  }
  return result;
}

export function collectSecretValues(env: UserMcpServerEnvVar[]): string[] {
  const secrets: string[] = [];
  for (const e of env) {
    if (!e.secret) continue;
    if (e.value !== undefined && e.value.trim()) {
      secrets.push(e.value.trim());
    } else if (e.valueEncrypted) {
      const decrypted = decryptSecret(e.valueEncrypted);
      if (decrypted) secrets.push(decrypted);
    }
  }
  return secrets.filter((s) => s.length >= 4);
}

function jsonStringContents(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function redactSecrets(text: string, secrets: string[]): string {
  if (!secrets.length || !text) return text;
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    needles.add(secret);
    const escaped = jsonStringContents(secret);
    if (escaped.length >= 4) needles.add(escaped);
  }
  const unique = [...needles].sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of unique) {
    if (!result.includes(secret)) continue;
    result = result.split(secret).join("<redacted>");
  }
  return result;
}

export function collectLogSecrets(
  servers: Array<{
    env?: Array<{ value?: string }>;
    args?: string[];
  }>
): string[] {
  const secrets: string[] = [];
  for (const server of servers) {
    for (const entry of server.env ?? []) {
      const value = entry.value?.trim();
      if (value && value.length >= 4) secrets.push(value);
    }
    for (const arg of server.args ?? []) {
      const match = arg.match(SECRET_ARG_PATTERN);
      const value = match?.[1]?.trim();
      if (value && value.length >= 4) secrets.push(value);
    }
  }
  return secrets;
}

export interface ResolvedCommand {
  command: string;
  error?: "command_not_found" | "relative_path_rejected";
}

function windowsPathExtensions(): string[] {
  return (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
}

function isAbsoluteCommand(command: string): boolean {
  return path.isAbsolute(command) || path.win32.isAbsolute(command);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutableFile(filePath: string): Promise<string | undefined> {
  if (await fileExists(filePath)) return filePath;
  if (process.platform !== "win32" || path.extname(filePath)) return undefined;
  for (const ext of windowsPathExtensions()) {
    const candidate = filePath + ext;
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

function findCommandOnPath(command: string): string | undefined {
  const dirs = (process.env.PATH || process.env.Path || "")
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  const suffixes =
    process.platform === "win32" && !path.extname(command)
      ? windowsPathExtensions()
      : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${command}${suffix}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function resolveCommandPath(
  command: string,
  cwd?: string
): Promise<ResolvedCommand> {
  const trimmed = command.trim();
  if (!trimmed) return { command: trimmed, error: "command_not_found" };

  if (!isAbsoluteCommand(trimmed) && (trimmed.startsWith(".") || /[\\/]/.test(trimmed))) {
    if (!cwd?.trim()) {
      return { command: trimmed, error: "relative_path_rejected" };
    }
    const resolved = await resolveExecutableFile(path.resolve(cwd, trimmed));
    return resolved
      ? { command: resolved }
      : { command: path.resolve(cwd, trimmed), error: "command_not_found" };
  }

  if (isAbsoluteCommand(trimmed)) {
    const resolved = await resolveExecutableFile(trimmed);
    return resolved
      ? { command: resolved }
      : { command: trimmed, error: "command_not_found" };
  }

  const fromPath = findCommandOnPath(trimmed);
  return fromPath
    ? { command: fromPath }
    : { command: trimmed, error: "command_not_found" };
}

export function substituteArgs(
  args: string[],
  cwd: string | undefined
): string[] {
  if (!cwd) return args;
  return args.map((arg) => arg.replace(/\$\{cwd\}/g, cwd));
}

const MAX_STDERR_BYTES = 8 * 1024;
/** A single unfinished stdout line. Complete lines are parsed in full. */
const MAX_PENDING_STDOUT_CHARS = 1024 * 1024;

/** Keep the true tail of a capture. A full chunk larger than the cap replaces the buffer. */
export function appendCappedTail(buffer: string, chunk: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (chunk.length >= maxChars) return chunk.slice(-maxChars);
  const next = buffer + chunk;
  return next.length <= maxChars ? next : next.slice(-maxChars);
}

export async function selfCheckUserMcpServer(
  id: string,
  cwd?: string
): Promise<UserMcpServerSelfCheckResult> {
  const server = getUserMcpServerInternal(id);
  if (!server) {
    return { status: "error", error: "Server not found" };
  }

  const commandResolution = await resolveCommandPath(server.command, cwd);
  if (commandResolution.error === "command_not_found") {
    const result: UserMcpServerSelfCheckResult = {
      status: "error",
      error: `Command not found: ${server.command}`
    };
    updateSelfCheckResult(id, result);
    return result;
  }
  if (commandResolution.error === "relative_path_rejected") {
    const result: UserMcpServerSelfCheckResult = {
      status: "error",
      error: `Relative path requires workspace: ${server.command}`
    };
    updateSelfCheckResult(id, result);
    return result;
  }

  const resolvedCommand = commandResolution.command;
  const resolvedArgs = substituteArgs(server.args, cwd);
  const resolvedEnv = resolveEnvForRuntime(server.env);
  const secretValues = [
    ...collectSecretValues(server.env),
    ...collectLogSecrets([{ args: resolvedArgs, env: Object.entries(resolvedEnv).map(([, value]) => ({ value })) }])
  ];

  return new Promise((resolve) => {
    let finished = false;
    let stdout = "";
    let stdoutDiscarding = false;
    let stderr = "";
    let requestId = 1;

    const finish = (result: UserMcpServerSelfCheckResult) => {
      if (finished) return;
      finished = true;
      const redactedStderr = stderr.trim()
        ? redactSecrets(stderr.trim().slice(-MAX_STDERR_BYTES), secretValues)
        : undefined;
      const finalResult = {
        ...result,
        stderr: redactedStderr
      };
      updateSelfCheckResult(id, finalResult);
      resolve(finalResult);
    };

    try {
      const child = spawn(resolvedCommand, resolvedArgs, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...resolvedEnv },
        stdio: ["pipe", "pipe", "pipe"]
      });

      const timeout = setTimeout(() => {
        killProcessTree(child, "force");
        finish({ status: "error", error: "Self-check timed out" });
      }, MCP_SELF_CHECK_TIMEOUT_MS);

      child.on("error", (err) => {
        clearTimeout(timeout);
        finish({ status: "error", error: `Spawn failed: ${err.message}` });
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        if (!finished) {
          if (signal) {
            finish({ status: "error", error: `Process killed by ${signal}` });
          } else if (code !== 0) {
            finish({
              status: "error",
              error: `Process exited with code ${code}`
            });
          } else {
            finish({
              status: "error",
              error: "Process exited without completing MCP handshake"
            });
          }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr = appendCappedTail(stderr, data.toString(), MAX_STDERR_BYTES);
      });

      child.stdout.on("data", (data: Buffer) => {
        let chunk = data.toString();
        if (stdoutDiscarding) {
          const newlineAt = chunk.indexOf("\n");
          if (newlineAt === -1) return;
          stdoutDiscarding = false;
          chunk = chunk.slice(newlineAt + 1);
        } else if (!chunk.includes("\n") && stdout.length + chunk.length > MAX_PENDING_STDOUT_CHARS) {
          stdout = "";
          stdoutDiscarding = true;
          return;
        }
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        if (stdout.length > MAX_PENDING_STDOUT_CHARS) {
          stdout = "";
          stdoutDiscarding = true;
        }
        for (const line of lines) {
          if (line.length > MAX_PENDING_STDOUT_CHARS) continue;
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.jsonrpc === "2.0" && msg.id === 1 && msg.result) {
              child.stdin.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/initialized"
                }) + "\n"
              );
              const listToolsRequest = {
                jsonrpc: "2.0",
                id: ++requestId,
                method: "tools/list",
                params: {}
              };
              child.stdin.write(JSON.stringify(listToolsRequest) + "\n");
            } else if (msg.jsonrpc === "2.0" && msg.id === 2) {
              clearTimeout(timeout);
              killProcessTree(child, "term");
              if (msg.error) {
                finish({
                  status: "error",
                  error: `tools/list failed: ${msg.error.message ?? JSON.stringify(msg.error)}`
                });
              } else {
                const tools = (msg.result?.tools ?? []).map(
                  (t: { name?: string }) => t.name ?? "unknown"
                );
                finish({ status: "ok", tools });
              }
            }
          } catch {
            // Complete line was not JSON-RPC. The unfinished fragment stays buffered above.
          }
        }
      });

      const initRequest = {
        jsonrpc: "2.0",
        id: requestId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "freebuddy", version: "1.0.0" }
        }
      };
      child.stdin.write(JSON.stringify(initRequest) + "\n");

      logMain().info("mcp-self-check", "started", {
        serverId: id,
        command: resolvedCommand,
        args: resolvedArgs.map((arg) => redactSecrets(arg, secretValues))
      });
    } catch (err) {
      finish({
        status: "error",
        error: `Failed to start: ${(err as Error).message}`
      });
    }
  });
}

export function getEnabledUserMcpServers(): UserMcpServer[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM user_mcp_servers WHERE enabled = 1 ORDER BY name ASC"
    )
    .all() as any[];
  return rows.map(rowToServer);
}

export function getMcpServersByIds(ids: string[]): UserMcpServer[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT * FROM user_mcp_servers WHERE id IN (${placeholders}) ORDER BY name ASC`
    )
    .all(...ids) as any[];
  return rows.map(rowToServer);
}

export function isRemoteMcpAllowed(): boolean {
  return isCallerAdmin() || getCallerUserId() === null;
}

export interface AcpStdioMcpServerFromUser {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export function userMcpServerToAcpFormat(
  server: UserMcpServer,
  command: string,
  cwd?: string
): AcpStdioMcpServerFromUser {
  return {
    name: server.name,
    command,
    args: substituteArgs(server.args, cwd),
    env: Object.entries(resolveEnvForRuntime(server.env)).map(
      ([name, value]) => ({ name, value })
    )
  };
}

export interface ResolvedUserMcpServers {
  servers: AcpStdioMcpServerFromUser[];
  skipped: Array<{ id: string; name: string; reason: string }>;
}

export async function getEnabledUserMcpServersByIds(
  ids: string[],
  cwd?: string
): Promise<ResolvedUserMcpServers> {
  if (!ids.length) return { servers: [], skipped: [] };
  const servers = getMcpServersByIds(ids).filter((s) => s.enabled);
  const resolved: AcpStdioMcpServerFromUser[] = [];
  const skipped: ResolvedUserMcpServers["skipped"] = [];
  for (const server of servers) {
    if (!cwd?.trim() && server.args.some((arg) => arg.includes("${cwd}"))) {
      skipped.push({ id: server.id, name: server.name, reason: "cwd_required" });
      continue;
    }
    const command = await resolveCommandPath(server.command, cwd);
    if (command.error) {
      skipped.push({
        id: server.id,
        name: server.name,
        reason: command.error
      });
      continue;
    }
    resolved.push(userMcpServerToAcpFormat(server, command.command, cwd));
  }
  return { servers: resolved, skipped };
}

/** Delegated sub-agents and workflow steps must not inherit the parent conversation's user MCP servers. */
export function shouldAttachUserMcpServers(input: {
  delegation?: unknown;
  toolSessionScope?: string;
}): boolean {
  if (input.delegation) return false;
  return !input.toolSessionScope?.startsWith("workflow:");
}

export async function resolveConversationUserMcpServers(input: {
  conversationId?: string;
  cwd?: string;
  delegation?: unknown;
  toolSessionScope?: string;
}): Promise<ResolvedUserMcpServers> {
  if (!shouldAttachUserMcpServers(input) || !input.conversationId) {
    return { servers: [], skipped: [] };
  }
  return getEnabledUserMcpServersByIds(
    getConversationMcpServerIds(input.conversationId),
    input.cwd
  );
}

/** First collision becomes `name-user`, then `name-user-2`, `name-user-3`, ... */
export function uniqueUserMcpServerName(name: string, takenNames: ReadonlySet<string>): string {
  if (!takenNames.has(name.toLowerCase())) return name;
  let n = 1;
  let candidate = `${name}-user`;
  while (takenNames.has(candidate.toLowerCase())) {
    n += 1;
    candidate = `${name}-user-${n}`;
  }
  return candidate;
}

export function mcpConfigFingerprint(ids: string[]): string {
  return JSON.stringify(
    getMcpServersByIds(ids).map((server) => ({
      id: server.id,
      name: server.name,
      command: server.command,
      args: server.args,
      enabled: server.enabled,
      env: server.env.map((entry) => ({
        name: entry.name,
        secret: Boolean(entry.secret),
        value: entry.secret ? entry.valueEncrypted ?? "" : entry.value ?? ""
      }))
    }))
  );
}

export function isMcpSecretStorageEncrypted(): boolean {
  return isSecretStorageAvailable();
}

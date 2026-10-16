import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";
import { getDb } from "./db.js";
import { encryptSecret, decryptSecret, redactApiKey } from "./store.js";
import { logMain } from "../debugLog.js";
import { isCallerAdmin, getCallerUserId } from "./callerContext.js";
import { killProcessTree } from "./process-kill.js";

const execFileAsync = promisify(execFile);

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
const MCP_SELF_CHECK_TIMEOUT_MS = 15_000;

export interface UserMcpServerEnvVar {
  name: string;
  value?: string;
  valuePreview?: string;
  valueEncrypted?: string;
  secret?: boolean;
  hasValue?: boolean;
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
    const prev = previousByName.get(normalizedName);
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
  const trimmed = name.trim().toLowerCase();
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
         last_checked_at = ?,
         updated_at = ?
       WHERE id = ?`
    )
    .run(
      result.status,
      result.error ?? null,
      result.tools ? JSON.stringify(result.tools) : null,
      now,
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

export function redactSecrets(text: string, secrets: string[]): string {
  if (!secrets.length) return text;
  let result = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    result = result.split(secret).join("<redacted>");
  }
  return result;
}

export interface ResolvedCommand {
  command: string;
  error?: "command_not_found" | "relative_path_rejected";
}

async function whichCommand(cmd: string): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("where", [cmd], {
        encoding: "utf8",
        timeout: 5000
      });
      return stdout.split("\n")[0]?.trim() || null;
    } else {
      const { stdout } = await execFileAsync("which", [cmd], {
        encoding: "utf8",
        timeout: 5000
      });
      return stdout.trim() || null;
    }
  } catch {
    return null;
  }
}

function isRelativePath(p: string): boolean {
  if (p.startsWith("./") || p.startsWith("../")) return true;
  if (process.platform === "win32") {
    if (p.startsWith(".\\") || p.startsWith("..\\")) return true;
  }
  return false;
}

function hasPathSeparator(p: string): boolean {
  return p.includes("/") || p.includes("\\");
}

export async function resolveCommandPath(
  command: string,
  cwd?: string
): Promise<ResolvedCommand> {
  const trimmed = command.trim();

  if (isRelativePath(trimmed)) {
    if (!cwd) {
      return { command: trimmed, error: "relative_path_rejected" };
    }
    const resolved = path.resolve(cwd, trimmed);
    if (fs.existsSync(resolved)) {
      return { command: resolved };
    }
    if (process.platform === "win32") {
      const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");
      for (const ext of pathext) {
        const withExt = resolved + ext.toLowerCase();
        if (fs.existsSync(withExt)) {
          return { command: withExt };
        }
      }
    }
    return { command: resolved, error: "command_not_found" };
  }

  if (hasPathSeparator(trimmed)) {
    if (fs.existsSync(trimmed)) {
      return { command: trimmed };
    }
    if (process.platform === "win32") {
      const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");
      for (const ext of pathext) {
        const withExt = trimmed + ext.toLowerCase();
        if (fs.existsSync(withExt)) {
          return { command: withExt };
        }
      }
    }
    return { command: trimmed, error: "command_not_found" };
  }

  const resolved = await whichCommand(trimmed);
  if (resolved) {
    return { command: resolved };
  }

  if (process.platform === "win32") {
    for (const variant of [`${trimmed}.cmd`, `${trimmed}.bat`, `${trimmed}.exe`]) {
      const variantResolved = await whichCommand(variant);
      if (variantResolved) {
        return { command: variantResolved };
      }
    }
  }

  return { command: trimmed, error: "command_not_found" };
}

export function substituteArgs(
  args: string[],
  cwd: string | undefined
): string[] {
  if (!cwd) return args;
  return args.map((arg) => arg.replace(/\$\{cwd\}/g, cwd));
}

const MAX_STDERR_BYTES = 8 * 1024;

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
  const secretValues = collectSecretValues(server.env);

  return new Promise((resolve) => {
    let finished = false;
    let stdout = "";
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
        if (stderr.length < MAX_STDERR_BYTES * 2) {
          stderr += data.toString();
        }
      });

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        const lines = stdout.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.jsonrpc === "2.0" && msg.id === 1 && msg.result) {
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
            // Not a complete JSON line yet
          }
        }
        stdout = lines[lines.length - 1] || "";
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
        command: resolvedCommand
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
  cwd?: string
): AcpStdioMcpServerFromUser {
  return {
    name: server.name,
    command: server.command.trim(),
    args: substituteArgs(server.args, cwd),
    env: Object.entries(resolveEnvForRuntime(server.env)).map(
      ([name, value]) => ({ name, value })
    )
  };
}

export function getEnabledUserMcpServersByIds(
  ids: string[],
  cwd?: string
): AcpStdioMcpServerFromUser[] {
  if (!ids.length) return [];
  const servers = getMcpServersByIds(ids).filter((s) => s.enabled);
  return servers.map((server) => userMcpServerToAcpFormat(server, cwd));
}

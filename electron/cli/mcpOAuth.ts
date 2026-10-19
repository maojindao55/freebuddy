import { shell, safeStorage } from "electron";
import { getDb } from "./db.js";
import { encryptSecret, decryptSecret, isSecretStorageAvailable } from "./store.js";
import { McpOAuthService, type McpOAuthServer, type McpOAuthStatus, type McpOAuthStoredState } from "./mcpOAuthService.js";
import { createMcpOAuthBroker } from "./mcpOAuthBroker.js";

// Refresh tokens stay in the main process. Without an OS key store they are
// session-only; the header store's encoding fallback is not used for OAuth.
const volatileCredentials = new Map<string, McpOAuthStoredState>();

function secureStorageAvailable(): boolean {
  if (!isSecretStorageAvailable()) return false;
  if (process.platform !== "linux") return true;
  // Electron's basic_text backend reports encryption available while using a
  // hardcoded password. OAuth grants must remain session-only in that case.
  try {
    const backend = safeStorage.getSelectedStorageBackend();
    return backend !== "basic_text" && backend !== "unknown" && backend !== undefined;
  } catch { return false; }
}

interface OAuthServerRow {
  id: string;
  url: string | null;
  transport: string;
  auth_type: string;
  enabled: number;
  oauth_client_id: string | null;
  oauth_scope: string | null;
  oauth_state_encrypted: string | null;
  oauth_revision: number;
}

function row(id: string): OAuthServerRow | undefined {
  return getDb().prepare("SELECT * FROM user_mcp_servers WHERE id = ?").get(id) as OAuthServerRow | undefined;
}

function serverFromRow(value: OAuthServerRow | undefined): McpOAuthServer {
  if (!value || value.transport === "stdio" || value.auth_type !== "oauth" || !value.url) {
    throw Object.assign(new Error("OAuth is not configured for this MCP server."), { code: "oauth_required" });
  }
  return {
    id: value.id, url: value.url,
    clientId: value.oauth_client_id || undefined,
    scope: value.oauth_scope || undefined
  };
}

const oauth = new McpOAuthService({
  read(id) {
    const value = row(id);
    if (!value || value.auth_type !== "oauth") return undefined;
    const inMemory = volatileCredentials.get(id);
    if (inMemory) return inMemory;
    if (!value.oauth_state_encrypted?.startsWith("safe:") || !secureStorageAvailable()) return undefined;
    try {
      const decoded = decryptSecret(value.oauth_state_encrypted);
      return decoded ? JSON.parse(decoded) as McpOAuthStoredState : undefined;
    } catch { return undefined; }
  },
  write(id, value) {
    if (!value) {
      volatileCredentials.delete(id);
      getDb().prepare("UPDATE user_mcp_servers SET oauth_state_encrypted = NULL WHERE id = ?").run(id);
      return;
    }
    const config = row(id);
    if (!config || config.auth_type !== "oauth" || config.url !== value.serverUrl ||
        (config.oauth_client_id || undefined) !== value.configuredClientId ||
        (config.oauth_scope || undefined) !== value.configuredScope) {
      throw new Error("MCP OAuth configuration changed.");
    }
    const encoded = secureStorageAvailable() ? encryptSecret(JSON.stringify(value)) : undefined;
    if (encoded?.startsWith("safe:")) {
      getDb().prepare("UPDATE user_mcp_servers SET oauth_state_encrypted = ? WHERE id = ?").run(encoded, id);
      volatileCredentials.delete(id);
    } else {
      volatileCredentials.set(id, value);
      getDb().prepare("UPDATE user_mcp_servers SET oauth_state_encrypted = NULL WHERE id = ?").run(id);
    }
  },
  openExternal: async (url) => { await shell.openExternal(url); }
});

const broker = createMcpOAuthBroker({
  async getAccessToken(id, forceRefresh, rejectedToken) {
    return oauth.accessToken(serverFromRow(row(id)), forceRefresh, rejectedToken);
  },
  isAllowed(id) {
    const value = row(id);
    return Boolean(value && value.enabled && value.transport !== "stdio" && value.auth_type === "oauth");
  }
});

export function getUserMcpOAuthStatus(id: string): McpOAuthStatus & { sessionOnly?: boolean } {
  const value = row(id);
  if (!value || value.transport === "stdio" || value.auth_type !== "oauth") return { state: "disconnected" };
  return { ...oauth.status(serverFromRow(value)), sessionOnly: volatileCredentials.has(id) || !secureStorageAvailable() };
}

export async function authorizeUserMcpServer(id: string): Promise<McpOAuthStatus> {
  await oauth.authorize(serverFromRow(row(id)));
  getDb().prepare("UPDATE user_mcp_servers SET oauth_revision = oauth_revision + 1 WHERE id = ?").run(id);
  return getUserMcpOAuthStatus(id);
}

export async function disconnectUserMcpServer(id: string): Promise<McpOAuthStatus> {
  const value = row(id);
  broker.revoke(id);
  getDb().prepare("UPDATE user_mcp_servers SET oauth_revision = oauth_revision + 1, last_check_status = NULL, last_check_error = NULL, last_check_tools = NULL, last_checked_at = NULL WHERE id = ?").run(id);
  if (value?.auth_type === "oauth" && value.transport !== "stdio" && value.url) {
    await oauth.disconnect(serverFromRow(value));
  } else {
    volatileCredentials.delete(id);
    getDb().prepare("UPDATE user_mcp_servers SET oauth_state_encrypted = NULL WHERE id = ?").run(id);
  }
  return getUserMcpOAuthStatus(id);
}

export function getUserMcpOAuthRevision(id: string): number {
  return row(id)?.oauth_revision ?? 0;
}

/** Called before changing connection identity or deleting the server. */
export function invalidateUserMcpOAuth(id: string): void {
  broker.revoke(id);
  void disconnectUserMcpServer(id).catch(() => {});
}

export async function getUserMcpOAuthBinding(id: string): Promise<{ endpoint: string; token: string }> {
  const server = serverFromRow(row(id));
  // Fail fast with an actionable auth error; never open browsers during a run.
  await oauth.accessToken(server);
  return broker.bind(id, server.url);
}

export async function shutdownMcpOAuth(): Promise<void> {
  await Promise.allSettled([oauth.dispose(), broker.dispose()]);
  volatileCredentials.clear();
}

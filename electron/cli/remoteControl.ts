import fs from "node:fs";

import { registerHandler } from "../invokeRegistry.js";
import { getSetting, setSetting } from "./settings.js";
import {
  listUsers,
  createUser,
  deleteUser,
  renameUser,
  resetUserPassword,
  setUserPassword,
  setUserDisabled,
  setUserStrictIsolation,
  ensureOwnerUser,
  getUserRoots,
  setUserRoots,
  getUserById,
  getOwnerUser,
  getUserDataFootprint,
  setSessionInvalidator,
  MIN_PASSWORD_LENGTH,
  type RemoteUser,
  type UserDataFootprint
} from "./users.js";
import { deleteUserOwnedData } from "./ownerCleanup.js";
import { applyOwnerBackfill } from "./ownerBackfill.js";
import { getCallerUserId } from "./callerContext.js";
import { recordAudit, listAudit, type RemoteAuditEntry } from "./remoteAudit.js";
import {
  restartWebUIServer,
  getWebUIStatus,
  getConnectedSessionHashes,
  type WebUIBindMode,
  type WebUIServerOptions,
  type WebUIStatus
} from "../webUIServer.js";
import {
  normalizeWebUIPort,
  WEBUI_DEFAULT_PORT
} from "../webUIConstants.js";
import {
  invalidateAllSessions,
  invalidateUserSessions,
  listSessionRecords,
  revokeSessionByHash
} from "../remoteAuth.js";

const PORT_SETTING_KEY = "remote.port";
const BIND_MODE_SETTING_KEY = "remote.bindMode";

let launchOptions: WebUIServerOptions = {};

export function isRemoteEnabledByConfig(): boolean {
  return getSetting("remote.enabled") === "1" || process.env.FB_REMOTE === "1";
}

export function getConfiguredPort(): number {
  return normalizeWebUIPort(getSetting(PORT_SETTING_KEY) ?? WEBUI_DEFAULT_PORT);
}

export function getConfiguredBindMode(): WebUIBindMode {
  return getSetting(BIND_MODE_SETTING_KEY) === "local" ? "local" : "lan";
}

export function resolveLaunchOptions(allowRemote: boolean): WebUIServerOptions {
  return {
    ...launchOptions,
    allowRemote,
    port: getConfiguredPort(),
    bindMode: getConfiguredBindMode()
  };
}

/** The desktop caller is the owner; remote callers never reach these handlers. */
function actor(): { id: string | null; name: string | null } {
  const id = getCallerUserId() ?? getOwnerUser()?.id ?? null;
  return { id, name: id ? getUserById(id)?.username ?? null : null };
}

export interface RemoteSessionInfo {
  tokenHash: string;
  userId: string;
  username: string | null;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  ip: string | null;
  userAgent: string | null;
  online: boolean;
  /** True for the session this desktop window itself is not using. */
  current: boolean;
}

function listSessionsWithUsers(): RemoteSessionInfo[] {
  const online = new Set(getConnectedSessionHashes());
  const usernames = new Map(listUsers().map((user) => [user.id, user.username]));
  return listSessionRecords().map((record) => ({
    tokenHash: record.tokenHash,
    userId: record.userId,
    username: usernames.get(record.userId) ?? null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastSeenAt: record.lastSeenAt,
    ip: record.ip,
    userAgent: record.userAgent,
    online: online.has(record.tokenHash),
    current: false
  }));
}

function registerRemoteIpc(): void {
  registerHandler("remote:whoami", async (): Promise<RemoteUser | null> => {
    // Desktop has no remote session; treat the host owner account as "me"
    // so the sidebar can show the same avatar + nickname as WebUI.
    const id = getCallerUserId() ?? getOwnerUser()?.id ?? null;
    return id ? getUserById(id) : null;
  });

  registerHandler("remote:getStatus", async (): Promise<WebUIStatus> => {
    return getWebUIStatus();
  });

  registerHandler(
    "remote:getServerConfig",
    async (): Promise<{ port: number; bindMode: WebUIBindMode; defaultPort: number }> => ({
      port: getConfiguredPort(),
      bindMode: getConfiguredBindMode(),
      defaultPort: WEBUI_DEFAULT_PORT
    })
  );

  registerHandler(
    "remote:setServerConfig",
    async (
      _event,
      input: { port?: number; bindMode?: WebUIBindMode }
    ): Promise<WebUIStatus> => {
      const changes: string[] = [];
      if (input.port !== undefined) {
        const port = normalizeWebUIPort(input.port);
        if (port !== getConfiguredPort()) changes.push(`port=${port}`);
        setSetting(PORT_SETTING_KEY, String(port));
      }
      if (input.bindMode === "local" || input.bindMode === "lan") {
        if (input.bindMode !== getConfiguredBindMode()) {
          changes.push(`bindMode=${input.bindMode}`);
        }
        setSetting(BIND_MODE_SETTING_KEY, input.bindMode);
      }
      const who = actor();
      if (changes.length > 0) {
        recordAudit({
          event: "server.config_changed",
          actorId: who.id,
          actorName: who.name,
          detail: changes.join(", ")
        });
      }
      return restartWebUIServer(resolveLaunchOptions(isRemoteEnabledByConfig()));
    }
  );

  registerHandler(
    "remote:setEnabled",
    async (_event, enabled: boolean): Promise<{ status: WebUIStatus; initialPassword: string | null }> => {
      setSetting("remote.enabled", enabled ? "1" : "0");
      let initialPassword: string | null = null;
      if (enabled) {
        const { user, password } = ensureOwnerUser();
        applyOwnerBackfill(user.id);
        if (password) initialPassword = password;
      } else {
        // Leaving the door open after the switch is flipped off would let
        // already-authenticated browsers keep working against a loopback port.
        invalidateAllSessions();
      }
      const who = actor();
      recordAudit({
        event: enabled ? "server.enabled" : "server.disabled",
        actorId: who.id,
        actorName: who.name
      });
      const status = await restartWebUIServer(resolveLaunchOptions(enabled));
      return { status, initialPassword };
    }
  );

  registerHandler("remote:listUsers", async (): Promise<RemoteUser[]> => listUsers());

  registerHandler(
    "remote:createUser",
    async (
      _event,
      input: { username: string; password?: string; strictIsolation?: boolean }
    ) => {
      const password = input.password?.trim() || undefined;
      if (password && password.length < MIN_PASSWORD_LENGTH) {
        throw new Error("password_too_short");
      }
      const created = createUser({
        username: input.username,
        password,
        strictIsolation: input.strictIsolation === true
      });
      const who = actor();
      recordAudit({
        event: "user.created",
        actorId: who.id,
        actorName: who.name,
        targetId: created.user.id,
        targetName: created.user.username
      });
      return created;
    }
  );

  registerHandler(
    "remote:renameUser",
    async (_event, input: { id: string; username: string }) => {
      const before = getUserById(input.id);
      const user = renameUser(input.id, input.username);
      const who = actor();
      if (user) {
        recordAudit({
          event: "user.renamed",
          actorId: who.id,
          actorName: who.name,
          targetId: user.id,
          targetName: user.username,
          detail: before ? `from ${before.username}` : null
        });
      }
      return user;
    }
  );

  registerHandler(
    "remote:setUserDisabled",
    async (_event, input: { id: string; disabled: boolean }) => {
      const user = setUserDisabled(input.id, input.disabled);
      const who = actor();
      if (user) {
        recordAudit({
          event: input.disabled ? "user.disabled" : "user.enabled",
          actorId: who.id,
          actorName: who.name,
          targetId: user.id,
          targetName: user.username
        });
      }
      return user;
    }
  );

  registerHandler(
    "remote:setUserStrictIsolation",
    async (_event, input: { id: string; strictIsolation: boolean }) => {
      const user = setUserStrictIsolation(input.id, input.strictIsolation);
      const who = actor();
      if (user) {
        recordAudit({
          event: input.strictIsolation ? "user.strict_isolation_enabled" : "user.strict_isolation_disabled",
          actorId: who.id,
          actorName: who.name,
          targetId: user.id,
          targetName: user.username
        });
      }
      return user;
    }
  );

  registerHandler("remote:resetUserPassword", async (_event, id: string) => {
    const result = resetUserPassword(id);
    const who = actor();
    if (result) {
      recordAudit({
        event: "user.password_reset",
        actorId: who.id,
        actorName: who.name,
        targetId: result.user.id,
        targetName: result.user.username
      });
    }
    return result;
  });

  registerHandler(
    "remote:setUserPassword",
    async (_event, input: { id: string; password: string }) => {
      const ok = setUserPassword(input.id, input.password);
      const who = actor();
      if (ok) {
        const target = getUserById(input.id);
        recordAudit({
          event: "user.password_set",
          actorId: who.id,
          actorName: who.name,
          targetId: input.id,
          targetName: target?.username ?? null
        });
      }
      return ok;
    }
  );

  registerHandler(
    "remote:getUserDataFootprint",
    async (_event, id: string): Promise<UserDataFootprint> => getUserDataFootprint(id)
  );

  registerHandler("remote:deleteUser", async (_event, id: string) => {
    const user = getUserById(id);
    if (!user) return false;
    const removed = deleteUserOwnedData(id);
    const deleted = deleteUser(id);
    const who = actor();
    if (deleted) {
      recordAudit({
        event: "user.deleted",
        actorId: who.id,
        actorName: who.name,
        targetId: id,
        targetName: user.username,
        detail: `conversations=${removed.conversations}, tasks=${removed.scheduledTasks}`
      });
    }
    return deleted;
  });

  registerHandler("remote:listUserRoots", async (_event, userId: string) =>
    getUserRoots(userId)
  );

  // Assigned directories rot: a project gets moved or an external drive is
  // unplugged, and the pill keeps claiming access that no longer resolves.
  registerHandler(
    "remote:checkRootsExist",
    async (_event, roots: string[]): Promise<Record<string, boolean>> => {
      const result: Record<string, boolean> = {};
      for (const root of Array.isArray(roots) ? roots : []) {
        if (typeof root !== "string") continue;
        try {
          result[root] = fs.statSync(root).isDirectory();
        } catch {
          result[root] = false;
        }
      }
      return result;
    }
  );

  registerHandler(
    "remote:setUserRoots",
    async (_event, args: { userId: string; roots: string[] }) => {
      setUserRoots(args.userId, args.roots);
      const who = actor();
      const target = getUserById(args.userId);
      recordAudit({
        event: "user.roots_changed",
        actorId: who.id,
        actorName: who.name,
        targetId: args.userId,
        targetName: target?.username ?? null,
        detail: `${args.roots.length} root(s)`
      });
      return getUserRoots(args.userId);
    }
  );

  registerHandler(
    "remote:listSessions",
    async (): Promise<RemoteSessionInfo[]> => listSessionsWithUsers()
  );

  registerHandler("remote:revokeSession", async (_event, tokenHash: string) => {
    const target = listSessionsWithUsers().find(
      (session) => session.tokenHash === tokenHash
    );
    const revoked = revokeSessionByHash(tokenHash);
    const who = actor();
    if (revoked) {
      recordAudit({
        event: "session.revoked",
        actorId: who.id,
        actorName: who.name,
        targetId: target?.userId ?? null,
        targetName: target?.username ?? null,
        ip: target?.ip ?? null
      });
    }
    return revoked;
  });

  registerHandler("remote:revokeUserSessions", async (_event, userId: string) => {
    invalidateUserSessions(userId);
    const who = actor();
    const target = getUserById(userId);
    recordAudit({
      event: "session.revoked",
      actorId: who.id,
      actorName: who.name,
      targetId: userId,
      targetName: target?.username ?? null,
      detail: "all devices"
    });
    return true;
  });

  registerHandler("remote:revokeAllSessions", async () => {
    invalidateAllSessions();
    const who = actor();
    recordAudit({
      event: "session.revoked_all",
      actorId: who.id,
      actorName: who.name
    });
    return true;
  });

  registerHandler(
    "remote:listAuditLog",
    async (_event, limit?: number): Promise<RemoteAuditEntry[]> =>
      listAudit(typeof limit === "number" ? limit : 200)
  );
}

export function initRemoteControl(options: WebUIServerOptions): void {
  launchOptions = options;
  // users.ts cannot import remoteAuth directly (remoteAuth reads the users
  // table), so the revocation path is injected here instead.
  setSessionInvalidator(invalidateUserSessions);
  registerRemoteIpc();
}

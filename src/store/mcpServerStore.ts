import { create } from "zustand";
import { cliClient } from "@/services/cli/client";
import type {
  McpOAuthStatus,
  UserMcpServer,
  UserMcpServerInput,
  UserMcpServerSelfCheckResult
} from "@/services/cli/types";

interface McpServerStoreState {
  servers: UserMcpServer[];
  secretStorageEncrypted: boolean;
  loaded: boolean;
  loading: boolean;
  checkingIds: string[];
  oauthAuthorizingIds: string[];
  oauthDisconnectingIds: string[];
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  create: (input: UserMcpServerInput) => Promise<UserMcpServer>;
  update: (
    id: string,
    input: Partial<UserMcpServerInput>
  ) => Promise<UserMcpServer | undefined>;
  remove: (id: string) => Promise<boolean>;
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  refreshOAuthStatus: (id: string) => Promise<McpOAuthStatus>;
  authorize: (id: string) => Promise<McpOAuthStatus>;
  disconnect: (id: string) => Promise<McpOAuthStatus>;
  selfCheck: (
    id: string,
    cwd?: string
  ) => Promise<UserMcpServerSelfCheckResult>;
  applySelfCheckResult: (
    id: string,
    result: UserMcpServerSelfCheckResult
  ) => void;
}

const selfCheckInflight = new Map<
  string,
  Promise<UserMcpServerSelfCheckResult>
>();

const oauthInflight = new Map<string, Promise<McpOAuthStatus>>();
const oauthGenerations = new Map<string, number>();
const oauthStatusRequests = new Map<string, number>();

export const useMcpServerStore = create<McpServerStoreState>((set, get) => ({
  servers: [],
  secretStorageEncrypted: true,
  loaded: false,
  loading: false,
  checkingIds: [],
  oauthAuthorizingIds: [],
  oauthDisconnectingIds: [],
  error: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const result = await cliClient.listUserMcpServers();
      set({
        servers: result.servers,
        secretStorageEncrypted: result.secretStorageEncrypted,
        loaded: true,
        loading: false
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to load MCP servers",
        loading: false
      });
    }
  },

  refresh: async () => {
    set({ error: null });
    try {
      const result = await cliClient.listUserMcpServers();
      set({
        servers: result.servers,
        secretStorageEncrypted: result.secretStorageEncrypted,
        loaded: true
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to refresh MCP servers"
      });
    }
  },

  create: async (input) => {
    const server = await cliClient.createUserMcpServer(input);
    set((state) => ({ servers: [...state.servers, server] }));
    return server;
  },

  update: async (id, input) => {
    const server = await cliClient.updateUserMcpServer(id, input);
    if (server) {
      set((state) => ({
        servers: state.servers.map((s) => (s.id === id ? server : s))
      }));
    }
    return server;
  },

  remove: async (id) => {
    const success = await cliClient.deleteUserMcpServer(id);
    if (success) {
      oauthGenerations.set(id, (oauthGenerations.get(id) ?? 0) + 1);
      oauthInflight.delete(id);
      set((state) => ({
        servers: state.servers.filter((s) => s.id !== id),
        oauthAuthorizingIds: state.oauthAuthorizingIds.filter((entry) => entry !== id),
        oauthDisconnectingIds: state.oauthDisconnectingIds.filter((entry) => entry !== id)
      }));
    }
    return success;
  },

  setEnabled: async (id, enabled) => {
    const success = await cliClient.setUserMcpServerEnabled(id, enabled);
    if (success) {
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === id ? { ...s, enabled } : s
        )
      }));
    }
    return success;
  },

  refreshOAuthStatus: async (id) => {
    const generation = oauthGenerations.get(id);
    const request = (oauthStatusRequests.get(id) ?? 0) + 1;
    oauthStatusRequests.set(id, request);
    const previous = get().servers.find((server) => server.id === id)?.oauthStatus;
    try {
      const status = await cliClient.getUserMcpOAuthStatus(id);
      if (generation !== oauthGenerations.get(id) || request !== oauthStatusRequests.get(id)) {
        return get().servers.find((server) => server.id === id)?.oauthStatus ?? { state: "disconnected" };
      }
      set((state) => ({
        servers: state.servers.map((server) => server.id === id ? { ...server, oauthStatus: status } : server)
      }));
      // Finish checks after a renderer reload while a browser login was pending.
      if (previous?.state === "authorizing" && status.state === "connected" &&
          !get().oauthAuthorizingIds.includes(id) && !get().oauthDisconnectingIds.includes(id) &&
          !get().checkingIds.includes(id)) {
        await get().selfCheck(id);
      }
      return status;
    } catch {
      // A status refresh must not erase a known connection on a transient IPC failure.
      return previous ?? { state: "disconnected" };
    }
  },

  authorize: async (id) => {
    const inflight = oauthInflight.get(id);
    if (inflight) return inflight;
    const generation = (oauthGenerations.get(id) ?? 0) + 1;
    oauthGenerations.set(id, generation);
    set((state) => ({
      oauthAuthorizingIds: [...state.oauthAuthorizingIds, id],
      servers: state.servers.map((server) => server.id === id
        ? { ...server, oauthStatus: { state: "authorizing" } } : server)
    }));
    let promise!: Promise<McpOAuthStatus>;
    promise = (async (): Promise<McpOAuthStatus> => {
      try {
        await Promise.resolve();
        const status = await cliClient.authorizeUserMcpServer(id);
        if (oauthGenerations.get(id) !== generation) {
          return get().servers.find((server) => server.id === id)?.oauthStatus ?? { state: "disconnected" };
        }
        oauthStatusRequests.set(id, (oauthStatusRequests.get(id) ?? 0) + 1);
        set((state) => ({
          oauthAuthorizingIds: state.oauthAuthorizingIds.filter((entry) => entry !== id),
          servers: state.servers.map((server) => server.id === id ? { ...server, oauthStatus: status } : server)
        }));
        if (status.state === "connected") {
          const refreshed = await get().refreshOAuthStatus(id);
          if (oauthGenerations.get(id) === generation && refreshed.state === "connected") {
            await get().selfCheck(id);
          }
          return refreshed;
        }
        return status;
      } catch {
        // Rejected IPC errors never carry raw OAuth details into the UI.
        const status: McpOAuthStatus = { state: "error" };
        if (oauthGenerations.get(id) === generation) {
          set((state) => ({
            servers: state.servers.map((server) => server.id === id ? { ...server, oauthStatus: status } : server)
          }));
        }
        return status;
      } finally {
        if (oauthInflight.get(id) === promise) {
          oauthInflight.delete(id);
          set((state) => ({ oauthAuthorizingIds: state.oauthAuthorizingIds.filter((entry) => entry !== id) }));
        }
      }
    })();
    oauthInflight.set(id, promise);
    return promise;
  },

  disconnect: async (id) => {
    oauthGenerations.set(id, (oauthGenerations.get(id) ?? 0) + 1);
    set((state) => ({ oauthDisconnectingIds: [...state.oauthDisconnectingIds, id] }));
    try {
      const status = await cliClient.disconnectUserMcpServer(id);
      // A poll started during cancellation may still report the old login.
      oauthStatusRequests.set(id, (oauthStatusRequests.get(id) ?? 0) + 1);
      oauthInflight.delete(id);
      set((state) => ({
        oauthAuthorizingIds: state.oauthAuthorizingIds.filter((entry) => entry !== id),
        servers: state.servers.map((server) => server.id === id ? {
          ...server, oauthStatus: status, lastCheckStatus: undefined,
          lastCheckError: undefined, lastCheckTools: undefined, lastCheckedAt: undefined
        } : server)
      }));
      return status;
    } catch {
      await get().refreshOAuthStatus(id);
      throw new Error("MCP OAuth disconnect failed");
    } finally {
      set((state) => ({ oauthDisconnectingIds: state.oauthDisconnectingIds.filter((entry) => entry !== id) }));
    }
  },

  selfCheck: async (id, cwd) => {
    const inflight = selfCheckInflight.get(id);
    if (inflight) return inflight;
    const generation = oauthGenerations.get(id);
    set((state) => ({ checkingIds: [...state.checkingIds, id] }));
    const promise = (async () => {
      try {
        await Promise.resolve();
        const result = await cliClient.selfCheckUserMcpServer(id, cwd);
        if (oauthGenerations.get(id) === generation) {
          get().applySelfCheckResult(id, result);
          // A rejected refresh changes the main process's authorization state.
          if (get().servers.find((server) => server.id === id)?.authType === "oauth") {
            await get().refreshOAuthStatus(id);
          }
        }
        return result;
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err))
          .replace(/^Error invoking remote method '[^']*':\s*/, "");
        const result: UserMcpServerSelfCheckResult = {
          status: "error",
          error: message || "Self-check failed"
        };
        if (oauthGenerations.get(id) === generation) {
          get().applySelfCheckResult(id, result);
          if (get().servers.find((server) => server.id === id)?.authType === "oauth") {
            await get().refreshOAuthStatus(id);
          }
        }
        return result;
      } finally {
        selfCheckInflight.delete(id);
        set((state) => ({
          checkingIds: state.checkingIds.filter((checkId) => checkId !== id)
        }));
      }
    })();
    selfCheckInflight.set(id, promise);
    return promise;
  },

  applySelfCheckResult: (id, result) => {
    set((state) => ({
      servers: state.servers.map((s) =>
        s.id === id
          ? {
              ...s,
              lastCheckStatus: result.status,
              lastCheckError: result.error,
              lastCheckTools: result.tools,
              lastCheckedAt: new Date().toISOString()
            }
          : s
      )
    }));
  }
}));

import { create } from "zustand";
import { cliClient } from "@/services/cli/client";
import type {
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

export const useMcpServerStore = create<McpServerStoreState>((set, get) => ({
  servers: [],
  secretStorageEncrypted: true,
  loaded: false,
  loading: false,
  checkingIds: [],
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
      set((state) => ({
        servers: state.servers.filter((s) => s.id !== id)
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

  selfCheck: async (id, cwd) => {
    const inflight = selfCheckInflight.get(id);
    if (inflight) return inflight;
    set((state) => ({ checkingIds: [...state.checkingIds, id] }));
    const promise = (async () => {
      try {
        await Promise.resolve();
        const result = await cliClient.selfCheckUserMcpServer(id, cwd);
        get().applySelfCheckResult(id, result);
        return result;
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err))
          .replace(/^Error invoking remote method '[^']*':\s*/, "");
        const result: UserMcpServerSelfCheckResult = {
          status: "error",
          error: message || "Self-check failed"
        };
        get().applySelfCheckResult(id, result);
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

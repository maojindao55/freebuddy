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

export const useMcpServerStore = create<McpServerStoreState>((set, get) => ({
  servers: [],
  secretStorageEncrypted: true,
  loaded: false,
  loading: false,
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
    const result = await cliClient.selfCheckUserMcpServer(id, cwd);
    get().applySelfCheckResult(id, result);
    return result;
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

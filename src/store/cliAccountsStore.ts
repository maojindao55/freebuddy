import { create } from "zustand";
import { cliClient } from "@/services/cli/client";
import type {
  CliAccountLoginInput,
  CliAccountMutationResult,
  CliAgentSystemAccountState
} from "@/services/cli/types";

function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    ""
  );
}

interface CliAccountsStoreState {
  byAdapter: Record<string, CliAgentSystemAccountState>;
  loadingByAdapter: Record<string, boolean>;
  busyByAdapter: Record<string, boolean>;
  errorByAdapter: Record<string, string | undefined>;

  load(adapter: string): Promise<CliAgentSystemAccountState | undefined>;
  importCurrent(
    adapter: string,
    label?: string
  ): Promise<CliAccountMutationResult | undefined>;
  switchAccount(
    adapter: string,
    accountId: string
  ): Promise<CliAccountMutationResult | undefined>;
  startLogin(
    input: CliAccountLoginInput
  ): Promise<CliAccountMutationResult | undefined>;
  refreshQuota(
    adapter: string,
    accountId?: string
  ): Promise<CliAgentSystemAccountState | undefined>;
  renameAccount(
    adapter: string,
    id: string,
    label: string
  ): Promise<CliAccountMutationResult | undefined>;
  deleteAccount(
    adapter: string,
    id: string
  ): Promise<CliAgentSystemAccountState | undefined>;
  clearError(adapter: string): void;
  activeAccountIdForAdapter(adapter: string): string | undefined;
}

let accountsChangedSubscribed = false;

export const useCliAccountsStore = create<CliAccountsStoreState>((set, get) => {
  const ensureSubscribed = () => {
    if (accountsChangedSubscribed || !cliClient.supportsCliAccounts()) return;
    accountsChangedSubscribed = true;
    cliClient.onAccountsChanged(({ adapter }) => {
      if (adapter) {
        void get().load(adapter);
      }
    });
  };

  return {
    byAdapter: {},
    loadingByAdapter: {},
    busyByAdapter: {},
    errorByAdapter: {},

    async load(adapter) {
      if (!cliClient.supportsCliAccounts()) return undefined;
      ensureSubscribed();
      set((s) => ({
        loadingByAdapter: { ...s.loadingByAdapter, [adapter]: true }
      }));
      try {
        const state = await cliClient.getAccountsState(adapter);
        set((s) => ({
          byAdapter: { ...s.byAdapter, [adapter]: state },
          loadingByAdapter: { ...s.loadingByAdapter, [adapter]: false }
        }));
        return state;
      } catch (error) {
        set((s) => ({
          loadingByAdapter: { ...s.loadingByAdapter, [adapter]: false },
          errorByAdapter: {
            ...s.errorByAdapter,
            [adapter]: cleanErrorMessage(error)
          }
        }));
        return undefined;
      }
    },

    async importCurrent(adapter, label) {
      if (!cliClient.supportsCliAccounts()) return undefined;
      ensureSubscribed();
      set((s) => ({
        busyByAdapter: { ...s.busyByAdapter, [adapter]: true },
        errorByAdapter: { ...s.errorByAdapter, [adapter]: undefined }
      }));
      try {
        const result = await cliClient.importCurrentAccount({ adapter, label });
        set((s) => ({
          byAdapter: { ...s.byAdapter, [adapter]: result.state },
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false }
        }));
        return result;
      } catch (error) {
        set((s) => ({
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false },
          errorByAdapter: {
            ...s.errorByAdapter,
            [adapter]: cleanErrorMessage(error)
          }
        }));
        return undefined;
      }
    },

    async switchAccount(adapter, accountId) {
      if (!cliClient.supportsCliAccounts()) return undefined;
      ensureSubscribed();
      set((s) => ({
        busyByAdapter: { ...s.busyByAdapter, [adapter]: true },
        errorByAdapter: { ...s.errorByAdapter, [adapter]: undefined }
      }));
      try {
        const result = await cliClient.switchAccount({ adapter, accountId });
        set((s) => ({
          byAdapter: { ...s.byAdapter, [adapter]: result.state },
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false }
        }));
        return result;
      } catch (error) {
        set((s) => ({
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false },
          errorByAdapter: {
            ...s.errorByAdapter,
            [adapter]: cleanErrorMessage(error)
          }
        }));
        return undefined;
      }
    },

    async startLogin(input) {
      if (!cliClient.supportsCliAccounts()) return undefined;
      ensureSubscribed();
      const { adapter } = input;
      set((s) => ({
        busyByAdapter: { ...s.busyByAdapter, [adapter]: true },
        errorByAdapter: { ...s.errorByAdapter, [adapter]: undefined }
      }));
      try {
        const result = await cliClient.startAccountLogin(input);
        set((s) => ({
          byAdapter: { ...s.byAdapter, [adapter]: result.state },
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false }
        }));
        return result;
      } catch (error) {
        set((s) => ({
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false },
          errorByAdapter: {
            ...s.errorByAdapter,
            [adapter]: cleanErrorMessage(error)
          }
        }));
        return undefined;
      }
    },

    async refreshQuota(adapter, accountId) {
      if (!cliClient.supportsCliAccounts()) return undefined;
      ensureSubscribed();
      set((s) => ({
        busyByAdapter: { ...s.busyByAdapter, [adapter]: true },
        errorByAdapter: { ...s.errorByAdapter, [adapter]: undefined }
      }));
      try {
        const state = await cliClient.refreshAccountQuota({
          adapter,
          accountId
        });
        set((s) => ({
          byAdapter: { ...s.byAdapter, [adapter]: state },
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false }
        }));
        return state;
      } catch (error) {
        set((s) => ({
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false },
          errorByAdapter: {
            ...s.errorByAdapter,
            [adapter]: cleanErrorMessage(error)
          }
        }));
        return undefined;
      }
    },

    async renameAccount(adapter, id, label) {
      if (!cliClient.supportsCliAccounts()) return undefined;
      ensureSubscribed();
      set((s) => ({
        busyByAdapter: { ...s.busyByAdapter, [adapter]: true },
        errorByAdapter: { ...s.errorByAdapter, [adapter]: undefined }
      }));
      try {
        const result = await cliClient.renameAccount({ id, label });
        set((s) => ({
          byAdapter: { ...s.byAdapter, [adapter]: result.state },
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false }
        }));
        return result;
      } catch (error) {
        set((s) => ({
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false },
          errorByAdapter: {
            ...s.errorByAdapter,
            [adapter]: cleanErrorMessage(error)
          }
        }));
        return undefined;
      }
    },

    async deleteAccount(adapter, id) {
      if (!cliClient.supportsCliAccounts()) return undefined;
      ensureSubscribed();
      set((s) => ({
        busyByAdapter: { ...s.busyByAdapter, [adapter]: true },
        errorByAdapter: { ...s.errorByAdapter, [adapter]: undefined }
      }));
      try {
        const state = await cliClient.deleteAccount(id);
        set((s) => ({
          byAdapter: { ...s.byAdapter, [adapter]: state },
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false }
        }));
        return state;
      } catch (error) {
        set((s) => ({
          busyByAdapter: { ...s.busyByAdapter, [adapter]: false },
          errorByAdapter: {
            ...s.errorByAdapter,
            [adapter]: cleanErrorMessage(error)
          }
        }));
        return undefined;
      }
    },

    clearError(adapter) {
      set((s) => ({
        errorByAdapter: { ...s.errorByAdapter, [adapter]: undefined }
      }));
    },

    activeAccountIdForAdapter(adapter) {
      return get().byAdapter[adapter]?.activeAccountId;
    }
  };
});

import { create } from "zustand";
import { businessWorkspacesClient } from "@/services/businessWorkspaces/client";
import type { BusinessWorkspace } from "@/services/businessWorkspaces/types";

interface State {
  loaded: boolean;
  workspaces: BusinessWorkspace[];
  errors: string[];
  load(): Promise<void>;
  refresh(): Promise<void>;
  create(input: Omit<BusinessWorkspace, "createdAt" | "updatedAt">): Promise<boolean>;
  update(id: string, patch: Partial<Omit<BusinessWorkspace, "id" | "createdAt" | "updatedAt">>): Promise<boolean>;
  remove(id: string): Promise<boolean>;
}

export const useBusinessWorkspaceStore = create<State>((set, get) => ({
  loaded: false,
  workspaces: [],
  errors: [],
  async load() {
    if (get().loaded) return;
    if (!businessWorkspacesClient.isAvailable()) {
      set({ loaded: true, workspaces: [] });
      return;
    }
    const workspaces = await businessWorkspacesClient.list();
    set({ loaded: true, workspaces, errors: [] });
  },
  async refresh() {
    if (!businessWorkspacesClient.isAvailable()) return;
    const workspaces = await businessWorkspacesClient.list();
    set({ workspaces, errors: [] });
  },
  async create(input) {
    const res = await businessWorkspacesClient.create(input);
    if (!res.ok) {
      set({ errors: res.errors });
      return false;
    }
    await get().refresh();
    return true;
  },
  async update(id, patch) {
    const res = await businessWorkspacesClient.update({ id, patch });
    if (!res.ok) {
      set({ errors: res.errors });
      return false;
    }
    await get().refresh();
    return true;
  },
  async remove(id) {
    const ok = await businessWorkspacesClient.delete(id);
    if (ok) await get().refresh();
    return ok;
  }
}));

import { create } from "zustand";

import { workflowTeamsClient } from "@/services/workflowTeams/client";
import type {
  WorkflowTeam,
  WorkflowTeamPolicy,
  WorkflowTeamPreview,
  WorkflowTeamRole,
  WorkflowTemplate2
} from "@/services/workflowTeams/types";

interface State {
  loaded: boolean;
  teams: WorkflowTeam[];
  pendingTeamPreview: WorkflowTeamPreview | null;
  pendingErrors: string[];

  load(): Promise<void>;
  refresh(): Promise<void>;
  getById(id: string): WorkflowTeam | undefined;

  create(input: {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    enabled: boolean;
    roles: WorkflowTeamRole[];
    template: WorkflowTemplate2;
    policy: WorkflowTeamPolicy;
  }): Promise<{ ok: boolean; errors?: string[]; team?: WorkflowTeam }>;

  update(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      enabled?: boolean;
      roles?: WorkflowTeamRole[];
      template?: WorkflowTemplate2;
      policy?: WorkflowTeamPolicy;
    }
  ): Promise<{ ok: boolean; errors?: string[]; team?: WorkflowTeam }>;

  remove(id: string): Promise<boolean>;

  previewTeam(input: {
    teamId: string;
    goal: string;
    cwd?: string;
    targetPaths?: string[];
  }): Promise<void>;

  clearPreview(): void;
}

export const useWorkflowTeamStore = create<State>((set, get) => ({
  loaded: false,
  teams: [],
  pendingTeamPreview: null,
  pendingErrors: [],

  async load() {
    if (get().loaded) return;
    if (!workflowTeamsClient.isAvailable()) {
      set({ loaded: true, teams: [] });
      return;
    }
    const teams = await workflowTeamsClient.list();
    set({ teams, loaded: true });
  },

  async refresh() {
    if (!workflowTeamsClient.isAvailable()) return;
    const teams = await workflowTeamsClient.list();
    set({ teams });
  },

  getById(id) {
    return get().teams.find((t) => t.id === id);
  },

  async create(input) {
    const res = await workflowTeamsClient.create(input);
    if (res.ok) {
      await get().refresh();
      return { ok: true, team: res.team };
    }
    return { ok: false, errors: res.errors };
  },

  async update(id, patch) {
    const res = await workflowTeamsClient.update({ id, patch });
    if (res.ok) {
      await get().refresh();
      return { ok: true, team: res.team };
    }
    return { ok: false, errors: res.errors };
  },

  async remove(id) {
    const ok = await workflowTeamsClient.delete(id);
    if (ok) await get().refresh();
    return ok;
  },

  async previewTeam(input) {
    const res = await workflowTeamsClient.previewTeamRun(input);
    if (res.ok) {
      set({ pendingTeamPreview: res.preview, pendingErrors: [] });
    } else {
      set({ pendingTeamPreview: null, pendingErrors: res.errors });
    }
  },

  clearPreview() {
    set({ pendingTeamPreview: null, pendingErrors: [] });
  }
}));

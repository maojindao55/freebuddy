import { create } from "zustand";

import {
  delegationClient,
  type UpsertDelegationTeamInput,
  type UpdateDelegationTeamPatch
} from "@/services/delegation/client";
import type { DelegationTeam } from "@/services/workflowTeams/types";

interface State {
  loaded: boolean;
  teams: DelegationTeam[];

  load(): Promise<void>;
  refresh(): Promise<void>;
  getById(id: string): DelegationTeam | undefined;
  create(input: UpsertDelegationTeamInput): Promise<DelegationTeam>;
  update(
    id: string,
    patch: UpdateDelegationTeamPatch
  ): Promise<DelegationTeam | undefined>;
  remove(id: string): Promise<boolean>;
}

export const useDelegationTeamStore = create<State>((set, get) => ({
  loaded: false,
  teams: [],

  async load() {
    if (get().loaded) return;
    if (!delegationClient.isAvailable()) {
      set({ loaded: true, teams: [] });
      return;
    }
    const teams = await delegationClient.list();
    set({ teams, loaded: true });
  },

  async refresh() {
    if (!delegationClient.isAvailable()) {
      set({ loaded: true, teams: [] });
      return;
    }
    const teams = await delegationClient.list();
    set({ teams, loaded: true });
  },

  getById(id) {
    return get().teams.find((t) => t.id === id);
  },

  async create(input) {
    const team = await delegationClient.create(input);
    await get().refresh();
    return team;
  },

  async update(id, patch) {
    const team = await delegationClient.update(id, patch);
    await get().refresh();
    return team;
  },

  async remove(id) {
    const ok = await delegationClient.delete(id);
    if (ok) await get().refresh();
    return ok;
  }
}));

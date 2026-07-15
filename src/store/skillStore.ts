import { create } from "zustand";

import { skillsClient } from "@/services/skills/client";
import type { SkillImportResult, SkillRecord } from "@/services/skills/types";

interface SkillState {
  skills: SkillRecord[];
  loaded: boolean;
  loading: boolean;
  error?: string;
  load(): Promise<void>;
  importDirectory(path: string): Promise<SkillImportResult>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  deleteSkill(id: string): Promise<boolean>;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  loaded: false,
  loading: false,
  error: undefined,
  async load() {
    set({ loading: true, error: undefined });
    try {
      set({ skills: await skillsClient.list(), loaded: true });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },
  async importDirectory(path) {
    const result = await skillsClient.import(path);
    await get().load();
    return result;
  },
  async setEnabled(id, enabled) {
    const skill = await skillsClient.setEnabled(id, enabled);
    if (!skill) return;
    set((state) => ({
      skills: state.skills.map((entry) => entry.id === id ? skill : entry)
    }));
  },
  async deleteSkill(id) {
    const deleted = await skillsClient.delete(id);
    if (deleted) {
      set((state) => ({ skills: state.skills.filter((skill) => skill.id !== id) }));
    }
    return deleted;
  }
}));

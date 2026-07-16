import type { SkillImportResult, SkillRecord } from "./types";

function api() {
  const skills = window.freebuddy?.skills;
  if (!skills) throw new Error("Skill API is unavailable");
  return skills;
}

export const skillsClient = {
  list: (): Promise<SkillRecord[]> => api().list(),
  import: (sourcePath: string): Promise<SkillImportResult> =>
    api().import(sourcePath),
  setEnabled: (id: string, enabled: boolean): Promise<SkillRecord | undefined> =>
    api().setEnabled(id, enabled),
  delete: (id: string): Promise<boolean> => api().delete(id),
  read: (id: string): Promise<string | undefined> => api().read(id),
  selectDirectory: (): Promise<string | null> => api().selectDirectory(),
  selectArchive: (): Promise<string | null> => api().selectArchive(),
  reveal: (id: string): Promise<boolean> => api().reveal(id)
};

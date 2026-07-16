export type SkillSource = "builtin" | "imported";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  rootPath: string;
  contentHash: string;
  enabled: boolean;
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillSnapshot {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  rootPath: string;
  contentHash: string;
}

export interface SkillImportResult {
  imported: SkillRecord[];
  errors: Array<{ path: string; message: string }>;
}

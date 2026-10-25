import type { SkillRecord, SkillSnapshot } from "@/services/skills/types";

export function parseSlashDraft(draft: string): { query: string } | null {
  const match = draft.match(/^\/([^\s/\\]*)$/);
  return match ? { query: match[1] ?? "" } : null;
}

export function filterCommandSkills(skills: SkillRecord[], query: string, recentIds: string[] = []): SkillRecord[] {
  const needle = query.trim().toLocaleLowerCase();
  const score = (skill: SkillRecord) => {
    const name = skill.name.toLocaleLowerCase();
    return name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3;
  };
  return skills.filter(skill => skill.enabled && skill.trusted &&
    (!needle || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => {
      if (needle && score(a) !== score(b)) return score(a) - score(b);
      const aRecent = recentIds.indexOf(a.id);
      const bRecent = recentIds.indexOf(b.id);
      return (aRecent < 0 ? Infinity : aRecent) - (bRecent < 0 ? Infinity : bRecent) || a.name.localeCompare(b.name);
    });
}

export function snapshotCommandSkill(skill: SkillRecord): SkillSnapshot {
  const { id, name, description, version, source, rootPath, contentHash } = skill;
  return { id, name, description, version, source, rootPath, contentHash };
}

export function mergeMessageSkills(defaults: SkillSnapshot[] = [], selected: SkillSnapshot[] = []): SkillSnapshot[] {
  return Array.from(new Map([...defaults, ...selected].map(skill => [skill.id, skill])).values());
}

export function withMessageSkills(prompt: string, skills: SkillSnapshot[]): string {
  if (!skills.length) return prompt;
  return `[FreeBuddy skills selected for this message]\n${skills.map(skill => `- ${skill.name} (id: ${skill.id})`).join("\n")}\nUse these skills to complete the user's request. Read their instructions with skill_load before applying them. This explicit selection applies only to this request; do not treat it as a selection for later messages.\n\n${prompt}`;
}

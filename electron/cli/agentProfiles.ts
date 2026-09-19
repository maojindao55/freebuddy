export const BUTLERBUDDY_AGENT_ID = "cli-butlerbuddy";
export const BUTLERBUDDY_SKILL_ID = "butlerbuddy";
export const ONBOARDING_GUIDE_AGENT_ID = "cli-onboarding-guide";
export const ONBOARDING_GUIDE_SKILL_ID = "onboarding-guide";

/** Core skills of official built-in members; cannot be disabled or untrusted. */
const PROTECTED_CORE_SKILL_IDS = new Set<string>([
  BUTLERBUDDY_SKILL_ID,
  ONBOARDING_GUIDE_SKILL_ID
]);

export function isProtectedCoreSkill(skillId: string): boolean {
  return PROTECTED_CORE_SKILL_IDS.has(skillId);
}

export function requiredSkillIdsForAgent(agentId: string): string[] {
  if (agentId === BUTLERBUDDY_AGENT_ID) return [BUTLERBUDDY_SKILL_ID];
  if (agentId === ONBOARDING_GUIDE_AGENT_ID) return [ONBOARDING_GUIDE_SKILL_ID];
  return [];
}

export function mergeRequiredSkillIds(
  agentId: string,
  selectedIds: readonly string[] | undefined
): string[] {
  return [
    ...new Set([...requiredSkillIdsForAgent(agentId), ...(selectedIds ?? [])])
  ];
}

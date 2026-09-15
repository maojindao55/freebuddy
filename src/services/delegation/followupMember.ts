/** Resolve live team bindings; never fall back to the conversation's old agent. */
export function resolveDelegationFollowupMember<T extends { id: string }>(
  team: { entryRoleId: string; roster: { id: string; agentId: string }[] } | undefined,
  members: readonly T[]
): T | undefined {
  const entry = team?.roster.find((role) => role.id === team.entryRoleId)
    ?? team?.roster[0];
  return members.find((member) => member.id === entry?.agentId);
}

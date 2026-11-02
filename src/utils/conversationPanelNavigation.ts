/** Automatic replacement after deletion is not an instruction to open chat. */
export function shouldFollowConversationSelection(
  previousId: string | undefined,
  nextId: string | undefined,
  visibleIds: readonly string[],
  preferredView: "list" | "panel"
): boolean {
  if (!nextId || previousId === nextId) return false;
  if (previousId) return visibleIds.includes(previousId);
  return preferredView === "list";
}

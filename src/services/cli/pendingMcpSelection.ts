const pendingMcpSelectionWrites = new Map<string, Promise<void>>();

/**
 * Serialize MCP selection writes for one conversation and remember the latest
 * in-flight write. `start` runs only after earlier writes settle, so a toggle
 * that loses the race cannot overwrite a later selection.
 */
export function trackMcpSelectionWrite(
  conversationId: string,
  start: () => Promise<void>
): Promise<void> {
  const previous = pendingMcpSelectionWrites.get(conversationId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(start);
  let tracked: Promise<void> = Promise.resolve();
  tracked = next.finally(() => {
    if (pendingMcpSelectionWrites.get(conversationId) === tracked) {
      pendingMcpSelectionWrites.delete(conversationId);
    }
  });
  pendingMcpSelectionWrites.set(conversationId, tracked);
  return next;
}

/** Resolves when the conversation's selection write has settled, including failures. */
export function awaitPendingMcpSelection(conversationId: string): Promise<void> {
  const pending = pendingMcpSelectionWrites.get(conversationId);
  return pending ? pending.catch(() => undefined) : Promise.resolve();
}

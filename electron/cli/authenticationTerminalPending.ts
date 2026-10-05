// Kept free of Electron and database imports so standalone PTY authentication
// can report pending input without initializing the application runtime.
const terminals = new Map<string, Set<string>>();

export function authenticationTerminalPendingCount(sessionId: string): number {
  return terminals.get(sessionId)?.size ?? 0;
}

export function authenticationTerminalPendingSessionIds(): IterableIterator<string> {
  return terminals.keys();
}

export function setAuthenticationTerminalPending(sessionId: string, requestId: string, pending: boolean): void {
  if (pending) {
    const bucket = terminals.get(sessionId) ?? new Set<string>();
    bucket.add(requestId);
    terminals.set(sessionId, bucket);
  } else {
    const bucket = terminals.get(sessionId);
    bucket?.delete(requestId);
    if (bucket?.size === 0) terminals.delete(sessionId);
  }
}

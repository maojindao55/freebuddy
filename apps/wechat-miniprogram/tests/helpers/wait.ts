/** Polls an in-memory condition until it holds, or fails with the caller's label. */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
  read: () => T | null | undefined,
  timeoutMs: number,
  label: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await delay(10);
  }
}

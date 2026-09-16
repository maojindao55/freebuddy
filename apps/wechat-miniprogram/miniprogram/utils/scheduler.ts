/**
 * Timer abstraction.
 *
 * WeChat, Node tests and the integration harness all provide timers, but only manual control
 * makes reconnect behaviour observable. Everything that schedules work therefore goes through
 * this seam so unit tests can advance time deterministically and assert that exactly one
 * reconnect timer exists at a time.
 */

export interface Scheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function createDefaultScheduler(): Scheduler {
  const scope = globalThis as unknown as {
    setTimeout(handler: () => void, ms?: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  return {
    setTimeout(handler, ms) {
      return scope.setTimeout(handler, ms);
    },
    clearTimeout(handle) {
      if (handle !== null && handle !== undefined) {
        scope.clearTimeout(handle);
      }
    }
  };
}

/** Id source for envelopes and nonces. Prefixes keep the kind visible in diagnostics. */
export type IdFactory = (prefix: string) => string;

let sequence = 0;

export function nextIdFactory(prefix: string): string {
  sequence += 1;
  return `${prefix}_${Date.now().toString(36)}${sequence.toString(36)}`;
}

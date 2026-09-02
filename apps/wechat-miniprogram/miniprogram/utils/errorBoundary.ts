/**
 * App-level error boundary.
 *
 * The mini program must degrade instead of white-screening: `app.ts` routes `onError`,
 * `onUnhandledRejection` and `onPageNotFound` here. Entries are always redacted and always
 * truncated, and the boundary itself never rethrows, so a failure in error handling cannot
 * take down the app.
 */

import { safeMessage } from "./redact";

export interface SafeErrorEntry {
  readonly scope: string;
  readonly message: string;
  readonly at: string;
}

export interface SafeLogEntry {
  readonly scope: string;
  readonly message: string;
  readonly at: string;
}

export interface ErrorBoundaryOptions {
  /** Sink for boundary entries. W1 has no remote reporting; tests inject a collector. */
  readonly report?: (entry: SafeErrorEntry) => void;
  /** Verbose console output. Must stay off for release builds. */
  readonly debug?: boolean;
}

export interface ErrorBoundary {
  handleError(scope: string, error: unknown): SafeErrorEntry;
  handleUnhandledRejection(reason: unknown): SafeErrorEntry;
  /** Runs `fn` and returns `fallback` if it throws, recording the failure. */
  run<T>(scope: string, fn: () => T, fallback: T): T;
}

function timestamp(at?: Date): string {
  return (at ?? new Date()).toISOString();
}

export function createErrorBoundary(options: ErrorBoundaryOptions = {}): ErrorBoundary {
  const report = options.report;

  const record = (scope: string, error: unknown): SafeErrorEntry => {
    const entry: SafeErrorEntry = {
      scope,
      message: safeMessage(error),
      at: timestamp()
    };
    try {
      if (options.debug) {
        console.warn(`[${entry.scope}] ${entry.message}`);
      }
      report?.(entry);
    } catch (ignored) {
      // Reporting must never break the caller.
    }
    return entry;
  };

  return {
    handleError(scope, error) {
      return record(scope, error);
    },
    handleUnhandledRejection(reason) {
      return record("unhandledRejection", reason);
    },
    run(scope, fn, fallback) {
      try {
        return fn();
      } catch (error) {
        record(scope, error);
        return fallback;
      }
    }
  };
}

/** Boundary used by `app.ts`. Debug logging is derived from the resolved environment. */
export function createAppErrorBoundary(debugLogging: boolean): ErrorBoundary {
  return createErrorBoundary({ debug: debugLogging });
}

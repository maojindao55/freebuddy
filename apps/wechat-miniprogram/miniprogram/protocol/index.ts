/**
 * Mini program entry point for the remote protocol.
 *
 * `./remote.generated` is produced by `npm run sync:protocol` from
 * `packages/protocol/src/remote.ts`, which is a binding of `protocol/remote/v1`. Nothing in
 * this directory may declare, rename or extend wire fields; on the next protocol change the
 * binding is regenerated and this file keeps the checks that guard the contract.
 */

import { FORBIDDEN_REMOTE_METHODS, REMOTE_PROTOCOL_VERSION, isForbiddenMethod } from "./remote.generated";

export * from "./remote.generated";

/** Major version this build speaks. Bump only together with the protocol package. */
export const EXPECTED_REMOTE_PROTOCOL_VERSION = 1;

/**
 * Fails fast when the generated binding drifts from what this build was written against.
 * Called once during app boot.
 */
export function assertProtocolBinding(): void {
  if (REMOTE_PROTOCOL_VERSION !== EXPECTED_REMOTE_PROTOCOL_VERSION) {
    throw new Error(
      `protocol binding is v${REMOTE_PROTOCOL_VERSION}, expected v${EXPECTED_REMOTE_PROTOCOL_VERSION}; run npm run sync:protocol`
    );
  }
  for (const method of FORBIDDEN_REMOTE_METHODS) {
    if (!isForbiddenMethod(method)) {
      throw new Error(`protocol binding no longer rejects forbidden method "${method}"`);
    }
  }
}

/**
 * Byte ceilings are a transport responsibility: `parseRemoteFrame` receives an already
 * parsed object, so the W2 socket layer must call `exceedsFrameLimit(rawFrame)` before
 * `JSON.parse` and `exceedsChunkLimit(text)` before accepting a chunk. Both are re-exported
 * from the binding; do not reimplement them here.
 */

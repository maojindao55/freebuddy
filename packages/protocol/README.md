# @freebuddy/protocol

Shared wire contracts for FreeBuddy.

## Remote admin v1

The language-independent authority is `protocol/remote/v1`. This package only exports TypeScript bindings:

```ts
import {
  parseRemoteFrame,
  parseHttpBody,
  parsePairingStartRequest,
  parsePairingClaimRequest,
  REMOTE_METHODS,
  getMethodSpec,
  buildHostAuthCanonicalPayload,
  buildPairingStartCanonicalPayload
} from "@freebuddy/protocol/remote";
```

The `./remote` entry is pure TypeScript (no `import`/`require`, no `node:fs` or Node-only globals). Schema/fixture contract tests live in `test/` (outside `src/`) so they can load `protocol/remote/v1` without putting Node filesystem APIs into the package-boundary scan of `packages/protocol/src/**`.

Electron should import `@freebuddy/protocol/remote`. WeChat developer tools cannot resolve files outside `miniprogramRoot`, so the endorsed mini-program path is a generated copy of `src/remote.ts`:

- Hash **this source file** (UTF-8 SHA-256). The generated copy prepends exactly four comment lines that are not part of the hash:

```
// GENERATED FILE - DO NOT EDIT.
// Source: packages/protocol/src/remote.ts (sha256 <hex>)
// Wire authority: protocol/remote/v1
// Regenerate with: npm run sync:protocol
```

  Authority and regenerate must be separate lines.
- Regenerate on install. Never hand-edit the copy or invent wire fields.
- Consume `parseRemoteFrame`, `parseHttpBody`, `parsePairingStartRequest`, `parsePairingClaimRequest`, `REMOTE_METHODS`, `getMethodSpec`, `REMOTE_METHOD_SPECS`, `RemoteMethodParamsMap`, `RemoteMethodResultMap`, `exceedsChunkLimit`, and `exceedsFrameLimit`.
- Size checks: `exceedsFrameLimit` on the raw WebSocket text **before** `JSON.parse`; `exceedsChunkLimit` on `ChunkText` fields. `parseRemoteFrame` does not enforce either limit.
- v1 does not export params/result runtime validators. Typed maps plus `getMethodSpec` are the RPC wrapper entry.
- HTTP companion bodies (`/v1/pairings/start`, `/v1/pairings/claim`, auth) are in `protocol/remote/v1/http.schema.json`. Start requires `secretHash` + Ed25519 `proof`; claim requires `pairingId` + high-entropy `secret`. Relay stores the hash, not the secret plaintext.
- Method kind follows `protocol/remote/v1/methods/registry.json`. `terminal.snapshot` is a write method, so `getMethodSpec("terminal.snapshot")` requires `idempotencyKey` and `expiresAt`.
- Signing goldens in `protocol/remote/v1/fixtures/signing/` use **`canonicalUtf8`** and **`canonicalHex`**, matching `signing/canonical.md` and `signing/pairing-start.md`. Do not look up `canonical.utf8` / `canonical.hex`.
- Write replay goldens are `protocol/remote/v1/fixtures/runtime/write-idempotency-replay.json` (listed in `manifest.runtime`). Duplicate writes return the original result or `duplicate_request` and must not execute again.
- HTTP pairing goldens are `protocol/remote/v1/fixtures/http/` (listed in `manifest.httpValid` / `manifest.httpInvalid`).

Run contract tests after build:

```bash
npm run test -w @freebuddy/protocol
```

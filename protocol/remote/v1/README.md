# FreeBuddy remote admin protocol v1

`protocol/remote/v1` is the **only** wire-contract authority for Relay, Electron, and the WeChat mini program. TypeScript and Go types are bindings. They must not invent fields.

## Versioning

- `v` is an integer. v1 frames send `v: 1`.
- Additive optional fields may be introduced in v1 only if they are marked extensible (`meta`, error `details`) or are ignored by older readers after a documented compatibility note. The current schemas **reject unknown envelope and payload fields**.
- Breaking changes (renamed fields, new required fields, new frame types that old clients must understand, semantic changes) require **v2**.
- Unknown major versions return `unsupported_version` and the connection is closed.

## Encoding

- UTF-8 JSON
- One WebSocket text frame = one envelope
- Field names are `camelCase`
- Time is UTC RFC3339, millisecond precision recommended
- IDs are opaque strings; newly minted IDs should be UUID v4 or equivalent high-entropy values
- Binary content is not carried in v1 JSON

### Size limits

| Limit | Value | What it covers | Who enforces it |
| --- | --- | --- | --- |
| Frame | **256 KiB** (`MAX_FRAME_BYTES` = 262144) | UTF-8 byte length of the **raw WebSocket text** before `JSON.parse` | Transport |
| Chunk | **32 KiB** (`MAX_CHUNK_BYTES` = 32768) | UTF-8 byte length of `ChunkText` fields | Transport / stream producer; JSON Schema `maxLength` is a coarse Unicode-code-point bound |

`parseRemoteFrame` receives an already-parsed object. It does **not** enforce either byte limit. `fixtures/invalid/oversized-chunk.json` is `reject: schema` because Ajv sees `ChunkText.maxLength`; a successful `parseRemoteFrame` on that object is expected.

`ChunkText` (must split if larger) is:

- `run.stream` items: `text` / `thinking` / `tool-result` / `command-output` `content`, and `file-edit.patch`
- `terminal.output.data`, `terminal.input.data`, `terminal.snapshot.output`
- `MessageSummary.content`, `TaskLogItem.text`

It is **not** every string on `RemoteStreamItem`. `tool-call.inputPreview` (4096), `command` (4096), `path` (1024), and `error.message` (`ErrorMessage`, 512) have their own caps.

`conversation.send` `content` and `delegation.start` `prompt` share the 32768 schema `maxLength` as one-shot RPC payloads. If they exceed the cap, reject with `invalid_request`; do not split a user message the way stream chunks are split.

## Envelope

Always required: `v`, `type`, `id`, `sentAt`, `payload`.

| Field | When required |
| --- | --- |
| `hostId` | After auth, on every host-directed RPC, event, snapshot, and resume |
| `expiresAt` | Every write RPC; recommended on reads |
| `idempotencyKey` | Every write RPC (≥128 bits entropy) |
| `seq` | `event` and `snapshot` only |
| `meta` | Optional extensible diagnostics. Never secrets or workspace contents |

## Frame types

| `type` | Direction | Purpose |
| --- | --- | --- |
| `challenge` | Relay → Host | One-time Ed25519 challenge |
| `host.auth` | Host → Relay | Host identity + signature |
| `admin.auth` | Admin → Relay | Access token |
| `auth.ok` | Relay → Client | Connection limits and server time |
| `error` | Bidirectional | Connection/protocol error |
| `rpc.request` | Admin → Host | Domain method |
| `rpc.response` | Host → Admin | Result or structured RPC error |
| `event` | Host → Admin | Ordered domain event |
| `resume` | Admin → Host | Replay from `resumeFrom` |
| `snapshot` | Host → Admin | Full sync with `baseSeq` |
| `ping` / `pong` | Bidirectional | Heartbeat |
| `server.draining` | Relay → Client | Close and reconnect with backoff |

## Methods

See [`methods/registry.json`](./methods/registry.json). Unregistered methods return `method_not_allowed`.

**Forbidden forever in this protocol:** `ipc.invoke`, `shell.exec`, `fs.*`, arbitrary Electron channels, arbitrary cwd/env/binary on terminal or run methods.

Read methods may omit `idempotencyKey`. Write methods must send `idempotencyKey` and `expiresAt`. Clients must not mint a new idempotency key merely because the transport dropped.

`terminal.snapshot` is a **write** method. Envelope schema requires `idempotencyKey` and `expiresAt` on `rpc.request` frames whose `payload.method` is in `WriteMethodName`, including `terminal.snapshot`.

Host write replay is keyed by authenticated admin identity (from the connection, not a wire field) plus `hostId` / `method` / `idempotencyKey`. A duplicate write must **not** execute again. The host returns either the original `rpc.response` result (`ok: true`, same `result`) or `ok: false` with `error.code: "duplicate_request"` and `retryable: false`. Both outcomes are frozen in [`fixtures/runtime/write-idempotency-replay.json`](./fixtures/runtime/write-idempotency-replay.json). A new `messageId` / `runId` (or any other mutated result) is a forbidden re-execution.

## Events and resume

- The host assigns a strictly increasing `seq` per admin event stream.
- `resume.payload.resumeFrom` is the last **fully applied** seq. The host replays `seq > resumeFrom`.
- If the cursor is too old, the host sends `snapshot` with `baseSeq`. Later events must have `seq > baseSeq`.
- Relay routes resume; it does not persist business events.
- RPC responses correlate with `payload.requestId`, not `seq`.

`run.stream` items are the constrained `RemoteStreamItem` union in [`stream-items.schema.json`](./stream-items.schema.json). They are a public subset of `CliStreamItem` and must not pass through raw internal objects, binary blobs, cwd, or env.

## Errors

See [`errors.json`](./errors.json). `message` is a UI/developer hint and must not include secrets, stacks, or raw internals.

## HTTP companion

[`http.schema.json`](./http.schema.json) freezes JSON bodies for `/v1/auth/wechat`, `/v1/auth/refresh`, `/v1/sessions/logout`, `/v1/pairings/start`, and `/v1/pairings/claim`. Path strings live in the Relay plan; bodies must not drift from these schemas. HTTP JSON bodies reject unknown fields (`additionalProperties: false`) except the shared extensible error `details` object.

Recommended HTTP JSON body limit is the same **256 KiB** UTF-8 cap as WebSocket frames.

### One-time pairing

Bootstrap must not allow “knowing `hostId` is enough to register a public key”, and a guessable short code must not bind a host.

1. The unpaired host generates an Ed25519 keypair and a high-entropy `secret` (`PairingSecret`: ≥32 random bytes, base64url without padding, 43–86 characters).
2. `POST /v1/pairings/start` sends `hostId`, `keyId`, `publicKey`, `displayName`, `secretHash`, and `proof`. It must **not** send `secret`.
   - `secretHash` is SHA-256 over the UTF-8 bytes of the `secret` wire string, encoded as base64url without padding (exactly 43 characters).
   - `proof` is an Ed25519 signature over the pairing-start canonical payload. See [`signing/pairing-start.md`](./signing/pairing-start.md).
3. Relay verifies `proof`, stores `secretHash` plus public key / display name / expiry, and returns `pairingId`, `displayCode`, and `expiresAt`. Default TTL is **5 minutes**.
4. The host builds the QR **locally** (Relay never receives `secret` on start and must not echo it):

```text
freebuddy-remote://pair/v1?pairingId=<pairingId>&secret=<secret>
```

5. `POST /v1/pairings/claim` (admin access token) **must** send `pairingId` + `secret`. Relay hashes `secret` with the same SHA-256 rule and compares it to the stored hash. Re-claim, expiry, and collision fail.
6. `displayCode` is a caption-only locator (`[A-Z0-9]{8,12}`). It is **not** a claim field and must not replace `secret`. Claim bodies that send `code` or `displayCode` are invalid.

Relay **must not** persist or log pairing secret plaintext, tokens, or AppSecret. After start, the durable pairing secret material is `secretHash`. `proof` is verified at start and must not be logged; keeping it in the pairing row is optional and not required for claim.

Golden HTTP bodies live in `fixtures/http/valid` and `fixtures/http/invalid` (listed as `httpValid` / `httpInvalid` in [`fixtures/manifest.json`](./fixtures/manifest.json)). Pairing-start hash/canonical/proof goldens are `fixtures/signing/pairing-start-canonical.json`.

## Signing

See [`signing/canonical.md`](./signing/canonical.md) for `host.auth` and [`signing/pairing-start.md`](./signing/pairing-start.md) for pairing `proof`. Golden files are in [`fixtures/signing/`](./fixtures/signing/). Canonical byte goldens use the camelCase fields **`canonicalUtf8`** and **`canonicalHex`**. Do not read or write `canonical.utf8` / `canonical.hex`.

## Fixtures

| Path | Meaning |
| --- | --- |
| `fixtures/valid/*.json` | Bare envelopes that must parse and schema-validate |
| `fixtures/invalid/*.json` | `{ "reason", "reject", "frame" }` objects that must fail |
| `fixtures/http/valid/*.json` | `{ "def", "body" }` HTTP companion bodies that must schema-validate and parse |
| `fixtures/http/invalid/*.json` | `{ "reason", "reject", "def", "body" }` HTTP bodies that must fail |
| `fixtures/signing/*` | Ed25519 canonical bytes (`canonicalUtf8` / `canonicalHex`) and verify/fail cases, including pairing-start |
| `fixtures/runtime/*` | Multi-frame host/runtime scenarios (write idempotency replay) |
| `fixtures/manifest.json` | File list for language-agnostic loaders |

`reject` is one of `schema`, `parse`, `runtime`, `signature`.

Expired writes live in `fixtures/invalid/expired-write.json` with `"reject": "runtime"`: the envelope is schema-valid and parseable, but the host must refuse execution with `request_expired`. Duplicate writes are **not** a single-frame reject; load `manifest.runtime` and apply the allowed outcomes in `fixtures/runtime/write-idempotency-replay.json`.

### Loading from Go

```go
root := filepath.Join("protocol", "remote", "v1")
manifest := mustReadJSON(filepath.Join(root, "fixtures", "manifest.json"))
// valid:       root/fixtures/valid/<file>
// invalid:     root/fixtures/invalid/<file>
// httpValid:   root/fixtures/http/valid/<file>     // {def, body}
// httpInvalid: root/fixtures/http/invalid/<file>   // {reason, reject, def, body}
// signing:     root/fixtures/signing/<file>
// runtime:     root/fixtures/runtime/<file>
// schemas:     root/schema-manifest.json lists every schema file
```

Validate valid envelopes against `envelope.schema.json` after loading every schema `$id` from `schema-manifest.json`. For invalid fixtures with `"reject": "schema"` or `"parse"`, the envelope must fail. For `"reject": "runtime"`, the envelope is schema-valid and the host/relay must still refuse it (expired writes). For `"reject": "signature"`, use the signing fixtures. For `manifest.runtime`, schema-validate every nested envelope; a replay must return one of `allowedOutcomes` (`original_result` or `duplicate_request`) and must not match `forbiddenOutcomes` (`re_execute`).

Validate `manifest.httpValid` bodies against `http.schema.json#/$defs/<def>`. For `manifest.httpInvalid` with `"reject": "schema"`, the body must fail that `$def`. Pairing-start goldens in `fixtures/signing/pairing-start-canonical.json` must produce the same `secretHash` / `canonicalUtf8` / `proof` in Go and TypeScript.

JSON Schema dialect is **2020-12**. Go may use any maintained 2020-12 validator. TypeScript tests use Ajv 8 (already in the monorepo).

## TypeScript binding

```ts
import {
  parseRemoteFrame,
  parseHttpBody,
  parsePairingStartRequest,
  parsePairingClaimRequest,
  REMOTE_METHODS,
  REMOTE_METHOD_SPECS,
  getMethodSpec,
  exceedsChunkLimit,
  exceedsFrameLimit,
  buildPairingStartCanonicalPayload,
  buildPairingQrPayload,
  type RemoteMethodParamsMap,
  type RemoteMethodResultMap
} from "@freebuddy/protocol/remote";
```

The binding is pure TypeScript: no `import`/`require`, no `node:fs`, no Node globals. Electron may import `@freebuddy/protocol/remote` from the workspace. The WeChat mini program **cannot** resolve files outside `miniprogramRoot`, so the endorsed consumption path is a **generated copy** of `packages/protocol/src/remote.ts`:

1. Copy the source file bytes. Do not rewrite types or add wire fields.
2. SHA-256 is of **`packages/protocol/src/remote.ts` UTF-8 bytes**, not of the generated file.
3. Prepend **exactly four** comment lines (consumer provenance, not part of the hash). Protocol tests never checksum the generated copy, so this header cannot break protocol-side validation:

```
// GENERATED FILE - DO NOT EDIT.
// Source: packages/protocol/src/remote.ts (sha256 <hex>)
// Wire authority: protocol/remote/v1
// Regenerate with: npm run sync:protocol
```

   Authority and regenerate must be separate lines. Combining them into one line is not this format.
4. Reject the copy if the source contains `import`/`require`.
5. Business code must import through a local adapter, never hand-copy field names.

There is no second official mini-program entry in this package. A generated copy is the entry.

Typed RPC wrappers should use `REMOTE_METHODS` / `getMethodSpec` / `REMOTE_METHOD_SPECS` plus `RemoteMethodParamsMap` / `RemoteMethodResultMap`. `parseRemoteFrame` checks envelope shape, method registry, write idempotency/`expiresAt`, and forbids `cwd`/`env`/`binary`/`channel`. It does **not** deep-validate params or results against each method schema. v1 does not export `parseRemoteMethodParams` / `parseRemoteMethodResult`; do not invent a parallel runtime schema. Hosts re-validate against `protocol/remote/v1` JSON Schema before execution.

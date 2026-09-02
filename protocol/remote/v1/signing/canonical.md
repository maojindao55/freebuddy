# Host authentication canonical payload (Ed25519)

This is the v1 signing contract for `host.auth`. Implementations in Go and TypeScript must produce identical UTF-8 bytes.

## Algorithm

- Signature scheme: **Ed25519**
- Encoding: UTF-8
- Line ending: a single `\n` (U+000A)
- No extra whitespace, no trailing spaces, no `\r`
- Field order is fixed and must not be reordered
- The payload **always ends with a trailing newline**

## Payload template

```text
freebuddy-remote-host-auth-v1\n
hostId:<hostId>\n
challenge:<base64url challenge>\n
connectionId:<connectionId>\n
issuedAt:<RFC3339 UTC>\n
```

Substitutions are literal. Do not quote values. Do not add spaces around `:`.

## Challenge

- At least 32 cryptographically random bytes
- Encoded as **base64url without padding**
- Single-use
- Default TTL: **60 seconds** from `issuedAt`
- Relay must reject reused, expired, or mismatched `connectionId` challenges

## Relay verification

1. Rebuild the canonical string from the challenge record, not from client-supplied copies of `issuedAt` unless it matches the record.
2. Check `issuedAt` skew against server time (recommended allowance: 30 seconds plus challenge TTL).
3. Verify Ed25519 signature over the canonical UTF-8 bytes using the registered host public key.
4. Mark the challenge consumed before accepting the connection.

## Test keys

Keys under `fixtures/signing/` are **fixture-only**. They must never be used in production, CVM, or real host credentials.

Go and TypeScript must assert:

- identical canonical UTF-8 bytes (see fixture fields `canonicalUtf8` / `canonicalHex`; these are camelCase JSON keys, not `canonical.utf8` / `canonical.hex`)
- a valid signature verifies
- tampered `hostId` or extra whitespace fails verification

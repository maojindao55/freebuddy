# Pairing-start canonical payload (Ed25519)

This is the v1 signing contract for `POST /v1/pairings/start` `proof`. Implementations in Go and TypeScript must produce identical UTF-8 bytes.

`proof` binds the host Ed25519 `publicKey` to `secretHash` so a third party cannot register a public key it does not own. It is **not** a substitute for the pairing secret. The secret itself is never sent on start.

## Algorithm

- Signature scheme: **Ed25519**, using the same host key that will later sign `host.auth`
- Encoding: UTF-8
- Line ending: a single `\n` (U+000A)
- No extra whitespace, no trailing spaces, no `\r`
- Field order is fixed and must not be reordered
- The payload **always ends with a trailing newline**
- `displayName` is **not** part of the canonical payload (it is not a security field and may contain Unicode)

## Payload template

```text
freebuddy-remote-pairing-start-v1\n
hostId:<hostId>\n
keyId:<keyId>\n
publicKey:<publicKey>\n
secretHash:<secretHash>\n
```

Substitutions are literal. Do not quote values. Do not add spaces around `:`.

`publicKey` and `secretHash` are the same base64url-without-padding strings sent in the JSON body.

## Pairing secret and hash

- The host generates at least **32 cryptographically random bytes** and encodes them as **base64url without padding**. That wire string is `secret` (`PairingSecret`).
- `secretHash = base64url(SHA-256(UTF-8(secret)))` with no padding. The SHA-256 digest is 32 bytes, so `secretHash` is exactly **43** characters (`PairingSecretHash`).
- Hash the UTF-8 bytes of the **wire string**, not a second decoding of the raw random bytes. This keeps Go/TS implementations identical.
- A guessable short display code is **not** a `PairingSecret` and must not be hashed in its place.

## Relay verification and storage

1. Reject unknown JSON fields.
2. Rebuild the canonical string from the request fields in the template order.
3. Verify Ed25519 `proof` over those UTF-8 bytes using `publicKey`.
4. Persist `secretHash`, `publicKey`, `displayName`, `pairingId`, and expiry. After verification, Relay **must not** persist or log `secret` (it is not in this request). Relay **must not** log `proof`. Keeping `proof` in the pairing row is optional and not required for claim.
5. Default pairing TTL is **5 minutes**. Claim after expiry, after a successful claim, or against a colliding `hostId` must fail.
6. On `POST /v1/pairings/claim`, require `pairingId` + `secret`. Hash the presented `secret` with the same SHA-256/UTF-8/base64url rule and compare to the stored `secretHash`. Do not accept `displayCode` or any short code as the secret.

## Host-local QR payload

Relay never sees `secret` on start and must not return it. The host builds the QR locally:

```text
freebuddy-remote://pair/v1?pairingId=<pairingId>&secret=<secret>
```

Query order is fixed: `pairingId` then `secret`. Both values use their schema character sets, so the payload is not percent-encoded. Clients must reject a different scheme, version, extra query parameters, or a missing `secret`.

## Test keys

Keys under `fixtures/signing/` are **fixture-only**. They must never be used in production, CVM, or real host credentials.

Go and TypeScript must assert:

- SHA-256 of the fixture `secret` UTF-8 bytes equals `secretHash`
- identical canonical UTF-8 bytes (see fixture fields `canonicalUtf8` / `canonicalHex`)
- a valid `proof` verifies with the fixture public key

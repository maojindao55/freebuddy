# Remote Host D3 POC

This directory contains the D3 desktop host POC. It does not dispatch RPCs,
persist remote payloads, or expose Electron IPC, shell, cwd, or environment
controls. The sole domain publication is the protocol-validated,
field-whitelisted `host.status.changed` event through `HostStatusPublisher`.

The application must keep remote control disabled unless a settings action
explicitly enables it. On that action, pass Electron's `safeStorage` and a
credential store to `createHostCredentials`; if keychain encryption is not
available, show the error and leave remote control disabled. Never use the
existing CLI secret helper because it intentionally has a compatibility
base64 fallback that is forbidden for host private keys.

For the current local Go Relay only, create `RelayClient` with a literal
loopback endpoint such as `ws://127.0.0.1:8080/v1/ws/host` and an explicit
development object containing the locally provisioned host token and the exact
`DEV_AUTH_HOST_ID`. The token is sent only as the existing Go handshake's
`Authorization` header and must not be written to logs, settings, or command
line arguments. `localhost`, LAN addresses, and non-loopback `ws://` URLs are
rejected. Production must use `wss://`; certificate validation remains enabled.

The current Go DEV Relay authenticates at HTTP upgrade time and therefore does
not issue a protocol `challenge`. For a future paired WSS Relay, pass
`createHostChallengeResponder(safeStorage, credentials)` as `onChallenge`.
`signHostChallenge` is tested against the v1 signing fixture.

## D4 read-only host

`ReadOnlyRemoteService` is the main-process-only explicit enable point and is
disabled until its `enable()` method is called by a local settings action. It
creates a fixed local owner/admin context, exposes exactly the 13 v1 read
methods, and rejects every write method (including `terminal.snapshot`). It
uses the existing local stores and never accepts a caller-provided user ID,
IPC channel, cwd, binary, or environment. `disable()` removes its EventHub
subscription and stops the socket.

The dispatcher revalidates method-specific parameter allowlists after the
envelope parser. Snapshots and paginated reads use field allowlists, redact
local paths and obvious secret assignments, and bound message/log text. Event
replay is local in-memory only (2048 events or ten minutes). An old resume
cursor receives a snapshot; oversized events are omitted so snapshot recovery
remains bounded.

The Go Relay already forwards `rpc.request`, `resume`, `snapshot`, and events;
no Relay or wire-contract changes were made. Headless turns, write methods,
pairing UI, and terminal controls remain later milestones.

### D4 runner evidence (2026-09-11)

The required Electron Node-mode runner is the reproducible D4 command:

```bash
npm run build:electron && node scripts/run-electron-node-test.mjs electron/remote/d4.integration.test.mjs
```

Its observed exit code is **1** before any D4 subtest starts. The exact
blocker is `dist-electron/debugLog.js:6`: `import { app } from "electron"`
fails because `ELECTRON_RUN_AS_NODE=1` exposes Electron's CommonJS facade,
which has no named `app` export. `debugLog.ts` and the root runner are outside
the `electron/remote` ownership boundary, so this directory does not mask,
skip, or replace that execution path. Once the owning component fixes that
interop boundary, rerun the command above; the D4 test exercises all 13 read
RPCs through a temporary SQLite domain store and Go Relay, validates every
response against the protocol v1 schema, checks resume snapshot fallback's
host-generated `serverTime`, and rejects every protocol-defined write method.

## Local Relay POC

Build the Electron output, then run the D3 integration test. It builds a
temporary Relay binary, starts it only on a random `127.0.0.1` port with a
temporary SQLite database, and supplies fresh dev tokens solely through that
child process environment:

```bash
npm run build:electron
node --test electron/remote/relay.integration.test.mjs
```

The test creates an Electron `RelayClient`, waits for authenticated `online`,
connects a simulated admin, and verifies it receives only the host-status
event. Its captured Relay output is checked to ensure neither generated token
appears in logs. No user Relay service or port 8080 is used.

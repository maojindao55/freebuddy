# FreeBuddy Remote Relay Service

Go-based cloud relay server for FreeBuddy remote administration.

## Current Scope

- Protocol v1 validation and bounded Admin/Host WSS routing.
- Native local Go startup & self-test entrypoints (`scripts/local-dev.sh` and `cmd/wss-smoke`).
- Public M2 CVM deployment is deferred (no Docker/Caddy needed for local self-contained operation).
- We remain strictly within Relay milestone boundaries and do not enter M3 desktop integration.
- Zero Business Data Retention: Chat messages, code, terminal input/output, workspace files, and raw secrets are **never** stored or logged.

Real WeChat `code2Session`, production administrator sessions, formal host pairing and terminal execution are deferred to subsequent milestones.

## Directory Structure

```text
services/remote-relay/
├── cmd/
│   ├── relay/
│   │   └── main.go              # Application entrypoint & signal handling
│   └── wss-smoke/
│       ├── main.go              # Loopback & TLS route/event verifier
│       └── main_test.go         # Loopback boundary, redirect prohibition & process tests
├── deploy/
│   ├── Caddyfile                # Caddy reverse proxy & TLS configuration (M2 deferred)
│   ├── compose.yaml             # Docker Compose for Relay + Caddy (M2 deferred)
│   ├── deploy_test.go           # Deployment artifact contract tests
│   ├── remote-relay.env.example # Example environment variables
│   ├── validate-artifacts.sh    # Pre-deployment compose/caddy config validator
│   └── verify-data-boundary.sh  # Post-smoke data boundary & zero-retention auditor
├── internal/
│   ├── audit/                   # Structured zero-retention audit logger
│   ├── config/                  # Configuration structure, environment loading, and validation
│   ├── httpapi/                 # HTTP server, middleware, /healthz, /readyz, WSS endpoints
│   ├── protocol/                # Protocol v1 envelope codecs, validation, and signing
│   ├── registry/                # In-memory device/session registry and pending RPC tracker
│   ├── router/                  # Bidirectional frame router and delivery dispatcher
│   ├── safeenv/                 # Secure env opener (O_NOFOLLOW/fstat/0400/0600) & non-executable parser
│   ├── store/                   # SQLite database lifecycle and schema migrations
│   │   └── migrations/          # Embedded SQL migration files
│   └── wsconn/                  # Low-level WebSocket connection wrapper and message pumps
├── scripts/
│   ├── local-dev.sh             # Local start/run/smoke/stop/status/self-test control script
│   └── test-local-dev.sh        # Security invariant & lifecycle test suite
├── .dockerignore
├── .gitignore                   # Ignores .local/, *.db*, *.log, binaries
├── DEPLOYMENT.md
├── Dockerfile
├── go.mod
├── go.sum
└── README.md
```

## Configuration

| Environment Variable | Default | Description |
| -------------------- | ------- | ----------- |
| `LISTEN_ADDR` | `:8080` (or `127.0.0.1:8080` in local script) | Server listen address |
| `PUBLIC_BASE_URL` | `""` | Public HTTPS/WSS URL of the relay |
| `SQLITE_PATH` | `:memory:` (or `.local/relay.db` in local script) | SQLite database file path |
| `WECHAT_APP_ID` | `""` | WeChat Mini Program AppID (Required in production) |
| `WECHAT_APP_SECRET` | `""` | WeChat Mini Program AppSecret (Required in production) |
| `ADMIN_OPENID` | `""` | Administrator WeChat OpenID (Required in production) |
| `TOKEN_HASH_PEPPER` | `""` | Server-side cryptographic salt pepper (min 16 chars) |
| `DEV_AUTH_MODE` | `false` | Enable local dev/mock authentication mode |
| `DEV_AUTH_ADMIN_TOKEN` | `""` | High-entropy dev administrator token (min 32 chars) |
| `DEV_AUTH_HOST_TOKEN` | `""` | High-entropy dev host token (min 32 chars) |
| `DEV_AUTH_HOST_ID` | `host_dev` | Dev host identifier |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `LOG_FORMAT` | `json` | Logging format (`json`, `text`) |
| `HTTP_READ_TIMEOUT` | `15s` | HTTP server read timeout |
| `HTTP_WRITE_TIMEOUT` | `30s` | HTTP server write timeout |
| `SHUTDOWN_GRACE_PERIOD` | `10s` | Maximum time allowed for graceful shutdown |
| `HEARTBEAT_INTERVAL` | `30s` | Native WebSocket ping interval |
| `HEARTBEAT_TIMEOUT` | `10s` | Native WebSocket pong timeout |

## Local Native Go Startup & Self-Test

You can run and test the Relay server natively without Docker or Caddy.

### Security Invariants for Local Dev

1. **Non-Executable Whitelist Parsing**: `dev.env` is **never** sourced or evaluated (`source` and `eval` are strictly forbidden). Variables are parsed line-by-line using non-executable whitelist matching, ensuring that shell command substitution `$(...)`, backticks, and redirection cannot be executed.
2. **Strict File Permissions & TOCTOU Protection**: All environment files strictly reject symbolic links, non-regular files, files not owned by the current user, and any group/world permissions. Permissions must be strictly `0400` or `0600`. File descriptors are opened with `O_NOFOLLOW` and verified via `fstat` to prevent TOCTOU replacement races.
3. **Loopback Binding Invariant**: Local Relay binding is strictly forced to `127.0.0.1`. Attempts to override `LISTEN_ADDR` to `0.0.0.0`, `:8080`, `localhost`, or non-loopback IPs via ambient environment or `dev.env` are strictly rejected.
4. **PID Identity Binding & Anti-Reuse**: Startup captures and records process identity (start timestamp `lstart` and command binary) alongside the PID. Prior to any signal in `stop`, process identity is re-verified to prevent killing unrelated processes during PID reuse. Forged or mismatched PID files are rejected without signalling.
5. **Deterministic Lifecycle Cleanup**: `self-test` failure, SIGINT, SIGTERM, or script exit guarantees clean termination of child processes spawned during that run only. Startup healthcheck timeout also cleans up failed child processes. Pre-existing Relay servers are detected, verified, and preserved untouched.
6. **Zero Secret Exposure**: Tokens are never printed in stdout/stderr, never passed in process argv (invisible in `ps`), and redacted as `[REDACTED]` in error messages.

### Reproducible Commands

From any directory (the script automatically resolves paths relative to repository structure):

```bash
# 1. Full lifecycle self-test (start -> smoke [1000 events + RPC] -> verify data boundary -> stop)
./services/remote-relay/scripts/local-dev.sh self-test

# 2. Run automated security invariant & lifecycle test suite (6 scenarios)
./services/remote-relay/scripts/test-local-dev.sh

# 3. Start Relay server in background (127.0.0.1:8080)
./services/remote-relay/scripts/local-dev.sh start

# 4. Check health and ready status
./services/remote-relay/scripts/local-dev.sh status

# 5. Run end-to-end smoke verification (healthz, readyz, RPC roundtrip, 1000 ordered events with sentinel)
./services/remote-relay/scripts/local-dev.sh smoke

# 6. Verify zero data retention in SQLite and logs
./services/remote-relay/scripts/local-dev.sh verify-data-boundary

# 7. Graceful shutdown (SIGTERM)
./services/remote-relay/scripts/local-dev.sh stop

# 8. Foreground long-running execution (Ctrl+C to stop)
./services/remote-relay/scripts/local-dev.sh run
```

## Unit & Integration Testing

Run all package tests:
```bash
go test -v ./...
```

Run race detector and vetting:
```bash
go test -race ./...
go vet ./...
```

## Public CVM Deployment (Deferred)

Public M2 CVM deployment is deferred. Pre-existing Docker Compose, Caddy configuration, and deployment documentation remain archived in [`DEPLOYMENT.md`](./DEPLOYMENT.md) and `deploy/` for future reference when public CVM rollout is resumed.

# FreeBuddy Remote Relay Service

Go-based cloud relay server for FreeBuddy remote administration.

## Responsibilities

- Admin authentication (WeChat login `code2Session` in production / token POC in development).
- Host device pairing and Ed25519 public key authentication.
- Bidirectional WebSocket message routing between WeChat Mini Program and FreeBuddy Desktop.
- Zero Business Data Retention: Chat messages, code, terminal input/output, workspace files, and raw secrets are **never** stored or logged.

## Directory Structure

```text
services/remote-relay/
├── cmd/
│   └── relay/
│       └── main.go              # Application entrypoint & signal handling
├── internal/
│   ├── config/                  # Configuration structure, environment loading, and validation
│   ├── httpapi/                 # HTTP server, middleware, /healthz, /readyz
│   └── store/                   # SQLite database lifecycle and schema migrations
│       └── migrations/          # Embedded SQL migration files
├── go.mod
├── go.sum
└── README.md
```

## Configuration

| Environment Variable | Default | Description |
| -------------------- | ------- | ----------- |
| `LISTEN_ADDR` | `:8080` | Server listen address |
| `PUBLIC_BASE_URL` | `""` | Public HTTPS/WSS URL of the relay |
| `SQLITE_PATH` | `:memory:` | SQLite database file path (or `:memory:`) |
| `WECHAT_APP_ID` | `""` | WeChat Mini Program AppID (Required in production) |
| `WECHAT_APP_SECRET` | `""` | WeChat Mini Program AppSecret (Required in production) |
| `ADMIN_OPENID` | `""` | Administrator WeChat OpenID (Required in production) |
| `TOKEN_HASH_PEPPER` | `""` | Server-side cryptographic salt pepper (min 16 chars) |
| `DEV_AUTH_MODE` | `false` | Enable local dev/mock authentication mode |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `LOG_FORMAT` | `json` | Logging format (`json`, `text`) |
| `HTTP_READ_TIMEOUT` | `15s` | HTTP server read timeout |
| `HTTP_WRITE_TIMEOUT` | `30s` | HTTP server write timeout |
| `SHUTDOWN_GRACE_PERIOD` | `10s` | Maximum time allowed for graceful shutdown |

## Development & Testing

Run all tests:
```bash
go test -v ./...
```

Run race detector and vetting:
```bash
go test -race ./...
go vet ./...
```

Run with dev mode locally:
```bash
DEV_AUTH_MODE=true SQLITE_PATH=./relay.db go run ./cmd/relay
```

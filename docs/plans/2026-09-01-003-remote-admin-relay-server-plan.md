---
title: FreeBuddy Go Remote Relay Server - Implementation Plan
type: feat
date: 2026-09-01
topic: remote-admin-relay-server
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
repository: freebuddy-monorepo
component: services/remote-relay
depends_on:
  - remote-admin-protocol-v1
---

# FreeBuddy Go 云中转服务——实施方案

## Goal Capsule

- **目标：** 在云主机（当前为百度智能云）上运行一个小型 Go 服务，完成唯一管理员微信身份验证、桌面主机配对/认证、双向 WSS 路由和最小审计。
- **数据边界：** 服务持久化身份、令牌哈希、主机公钥、配对状态和不含业务载荷的审计元数据；不持久化消息、代码、终端输入输出和事件内容。
- **部署边界：** 单实例优先，SQLite 持久化；Caddy 终止 TLS；Relay 监听容器内 `:8080`。
- **依赖：** 必须消费 [远程控制协议方案](./2026-09-01-002-remote-admin-protocol-plan.md) 的 schema/fixtures，不得另行设计 wire format。

## Ownership Boundary

Relay Agent 主要修改：

```text
services/remote-relay/**
deploy/remote-relay/**                 # 若仓库已有 deploy 约定则服从现有结构
docs/remote-relay-deployment.md        # 部署/运维说明
```

允许只读消费：

```text
protocol/remote/v1/**
```

协议有缺口时向协议 Agent 提 issue/小改动请求，不在 Go 目录中发明不兼容字段。不要修改 Electron 或小程序业务代码。

## Technology Decisions

- Go 使用仓库当前可支持的稳定版本，`services/remote-relay/go.mod` 独立管理，不加入 npm workspaces。
- HTTP 使用标准库 `net/http`，日志使用 `log/slog`。
- WebSocket 推荐 `github.com/coder/websocket`；若选择其他库，需说明维护状态、context/cancel 支持、大小限制和关闭语义。
- SQLite 驱动优先选无需 CGO 的实现，便于构建精简容器；若选 CGO 驱动需同步调整构建镜像和运维说明。
- 数据访问保持轻量 SQL/migration，不引入大型 ORM。
- 配置只来自环境变量/启动参数，生产秘密不写入仓库配置文件。

## Public Interfaces

### HTTP

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | 无 | 进程存活，不探测外部服务 |
| GET | `/readyz` | 无 | 数据库可用、服务可接收连接 |
| POST | `/v1/auth/wechat` | 微信 login code | 服务端 `code2Session` 并签发令牌 |
| POST | `/v1/auth/refresh` | refresh token | 轮换 access/refresh token |
| POST | `/v1/sessions/logout` | access token | 撤销当前管理员会话 |
| POST | `/v1/pairings/start` | 主机 bootstrap 证明 | 创建短时一次性配对 |
| POST | `/v1/pairings/claim` | 管理员 access token | 唯一管理员领取配对 |

具体字段以协议 schema 为准。所有 JSON endpoint 必须设置严格 body 大小、content type、超时和稳定错误结构。

### WebSocket

| Path | Client | Authentication |
| --- | --- | --- |
| `/v1/ws/admin` | 微信小程序 | `admin.auth` access token |
| `/v1/ws/host` | FreeBuddy 桌面端 | challenge + Ed25519 `host.auth` |

HTTP upgrade 后在短超时内完成应用层认证。未认证连接不能进入 registry 或接收业务帧。

## Configuration Contract

至少支持：

```text
LISTEN_ADDR=:8080
PUBLIC_BASE_URL=https://remote.example.com
SQLITE_PATH=/data/relay.db
WECHAT_APP_ID=...
WECHAT_APP_SECRET=...
ADMIN_OPENID=...
TOKEN_HASH_PEPPER=...
LOG_LEVEL=info
TRUST_PROXY=false
```

可配置项还包括 frame 大小、连接数、每连接 send queue、RPC timeout、配对 TTL、token TTL、微信 HTTP timeout、shutdown grace period 和速率限制。启动时校验配置；缺少生产必填项应 fail closed，不能自动使用弱默认秘密。

本地 POC 模式可显式启用测试令牌，例如 `DEV_AUTH_MODE=true`，但必须同时满足：

- 默认关闭；生产配置检测到它时拒绝启动或发出致命错误。
- 测试令牌不写死在仓库。
- 对外响应和日志清楚标记 dev mode。

## Authentication and Pairing

### 微信管理员登录

1. 小程序发送 `wx.login` 获得的一次性 code。
2. Relay 通过超时受控的 HTTPS 请求调用微信 `code2Session`。
3. 只接受 `openid == ADMIN_OPENID`；其他账号统一返回 `forbidden`，不得泄漏允许的 OpenID。
4. 生成高熵 opaque access/refresh token。
5. 数据库仅保存 token 哈希、到期时间、创建/最后使用/撤销时间和设备标签；响应后不再保留明文。
6. refresh 使用 rotation：成功后旧 refresh token 立即失效；检测重放时撤销令牌族。

不要从客户端接受可信 `openid`、`isAdmin` 或用户角色。不要用 AppSecret 签发给小程序直接调用微信接口。

### 主机身份

- 桌面端本地生成 `hostId` 和 Ed25519 密钥对。
- Relay 数据库保存 `hostId`、public key、配对管理员、状态元数据和撤销时间。
- 每次 WSS 建连先发 challenge，桌面按协议 canonical payload 签名。
- challenge 至少 32 随机字节、一次性、默认 60 秒失效，并绑定 connection ID。
- 验签成功才把连接注册为该 host；同一 host 新连接上线时确定性关闭旧连接。

### 首次配对

Bootstrap 方案必须避免“知道 hostId 就能注册公钥”。推荐流程：

1. 未配对桌面生成主机密钥和高熵 pairing secret。
2. `pairings/start` 提交 public key、host display name 和 secret 的哈希/证明，Relay 返回 pairing ID、短码/二维码内容和 5 分钟到期时间。
3. 已登录唯一管理员调用 `pairings/claim`，提交 pairing ID + secret。
4. 事务内创建/启用 host、标记 pairing 已领取并写最小审计。
5. pairing 再次领取、过期或碰撞必须失败；原 secret 不落日志。

如果协议 Agent 设计了更严格的 PAKE/签名 bootstrap，以协议方案为准，但不能降低一次性和高熵要求。

## Routing Model

### Connection Registry

- 内存维护 `hostId -> host connection` 和 `admin session -> admin connections`。
- 一期允许管理员多个小程序连接，但写请求仍需全局幂等；也可显式限制为一个 active admin connection，并在文档中固定行为。
- 每连接一个 reader loop、一个 writer loop，所有写入通过有界 send queue。
- reader 验证 frame 类型、大小、认证身份和方向；客户端不能伪装为另一个角色。
- writer 超时或队列满时返回/记录 `backpressure` 并关闭慢连接，不能阻塞全局 registry。

### RPC Correlation

- Relay 只为在线请求维护有界 pending map：`requestId -> adminConnection/hostId/deadline`。
- admin request 的 host 必须属于该管理员，host 在线才转发。
- host response 必须匹配 pending request、host 和未过期 deadline，否则丢弃并记录元数据审计。
- 超时向 admin 返回 `rpc_timeout`，清理 pending；断连时清理相关 pending。
- 不将 pending RPC、request payload 或 event payload 写 SQLite。

### Events and Resume

- Relay 验证 host event envelope 的结构和 frame 限制后转发。
- seq/ring buffer/snapshot 的业务权威在 desktop host，不在 Relay。
- Relay 断线不补存事件；管理员重连后把 resume 请求路由到 host。
- host 离线时返回 `host_offline`，不创建离线队列。

### Heartbeats and Lifecycle

- WebSocket ping/pong 检测死连接，周期和超时可配置。
- 收到 SIGTERM/SIGINT：停止接收新连接、发送 `server.draining`、等待短暂宽限、主动关闭全部 WS、完成 HTTP shutdown、关闭数据库。
- `http.Server.Shutdown` 不会自动关闭所有已升级连接，因此必须由 registry 显式关闭。

## Persistence Model

建议 migration：

```text
admin_sessions
  id, token_hash, refresh_hash, token_family_id,
  device_label, created_at, last_used_at, expires_at,
  refresh_expires_at, revoked_at

hosts
  id, public_key, display_name, paired_at,
  last_seen_at, revoked_at

pairings
  id, secret_hash, public_key, display_name,
  created_at, expires_at, claimed_at

audit_events
  id, occurred_at, actor_type, actor_id,
  action, target_type, target_id, outcome,
  request_id, remote_ip_hash
```

数据库禁止列：RPC params/result、event payload、消息正文、代码、命令、终端输入输出、令牌明文、AppSecret、主机私钥。

审计日志只记录“谁在何时对哪个抽象资源执行了何种动作及结果”。远端 IP 如确需保存，优先加盐哈希或短期保留，并写入隐私说明。

## Suggested Package Layout

```text
services/remote-relay/
├── cmd/relay/main.go
├── internal/
│   ├── audit/
│   ├── auth/
│   │   ├── tokens.go
│   │   └── wechat.go
│   ├── config/
│   ├── httpapi/
│   ├── pairing/
│   ├── protocol/
│   ├── registry/
│   ├── router/
│   ├── store/
│   │   ├── migrations/
│   │   └── sqlite.go
│   └── wsconn/
├── testdata/                         # 可引用根 protocol fixtures，避免复制
├── Dockerfile
├── go.mod
├── go.sum
└── README.md
```

避免把所有逻辑放进 `main.go`。`internal/protocol` 是 Go binding/validation，不是新的协议权威。

## Implementation Units

### R1：项目、配置、健康检查

- 建立 Go module、结构化日志、配置校验、HTTP server timeouts。
- 添加 `/healthz`、`/readyz` 和关闭流程。
- 添加 SQLite migration runner 和空库启动测试。

### R2：协议 binding 和 fixtures

- 为 envelope/frame 实现严格解码；拒绝未知版本和超限消息。
- Go 测试读取根 `protocol/remote/v1/fixtures`。
- 验证 signing golden fixtures。

### R3：本地 Token POC 路由

- 在显式 dev mode 下完成模拟 admin/host 鉴权。
- 实现 registry、pending RPC、event 路由、心跳和背压。
- 提供 Go 模拟器或测试客户端完成端到端闭环。

### R4：真实微信认证和会话

- 实现受超时/响应大小控制的 `code2Session` client。
- 实现 opaque token 哈希、rotation、撤销和速率限制。
- 添加微信错误映射，日志不得记录 code/session_key/token。

### R5：主机配对和 Ed25519 认证

- 实现 start/claim 的事务和 TTL。
- 实现 challenge 生命周期、签名验证和 host revocation。
- 对重复/并发 claim、challenge replay 和旧连接替换做测试。

### R6：生产部署

- 多阶段 Docker 构建、非 root 用户、只读 root filesystem（可行时）、`/data` volume。
- Caddy 反代 WSS，设置正确 forwarded header 信任边界。
- 文档化云侧安全组、域名/TLS、备份、升级、回滚和秘密轮换。

## Test Plan

### 单元和合同测试

- config 失败关闭、token 哈希/rotation、TTL、签名、错误映射。
- 所有 valid/invalid schema fixtures。
- registry 并发注册/撤销、pending timeout、未知 response。
- 审计输出明确断言不含 payload/secret。

### 集成测试

- `httptest.Server` + 两个真实 WebSocket client 完成 auth、RPC、response、event。
- 1000 个有序 event 不丢失、不乱序。
- host offline、admin disconnect、host replacement、RPC timeout。
- 慢消费者填满 send queue 后只断开对应连接。
- pairing 并发领取只有一个成功。
- SQLite 重启保留 host/session 元数据但没有业务 payload。

### 竞态和可靠性

```bash
go test ./...
go test -race ./...
go vet ./...
```

在 CI/本机允许时再加入 fuzz：严格 JSON decode、frame router、签名 canonical parser。

## Deployment Runbook Requirements

部署文档至少包含：

- DNS、域名备案、云侧安全组和 Caddy TLS 配置。
- 生产环境公网只开放 80/443，SSH 使用密钥并限制来源 IP；Relay 8080 不直接暴露。当前共享主机的 M2 DEV 例外及其发布前复审要求以[总控方案 M2](./2026-09-01-001-remote-admin-control-master-plan.md)为准，不得把 Relay 的端口边界等同于整机端口边界。
- 环境变量秘密的安全配置方式，禁止放在镜像层和 Git。
- `/data` 备份/恢复演练和 migration 回滚边界。
- 健康检查、日志轮转、磁盘水位、连接数、认证失败和背压告警。
- 紧急撤销管理员会话、撤销 host、关闭 Relay 的步骤。
- 日志脱敏验证方式。

## Acceptance Criteria

- 唯一管理员可登录，其他微信账号稳定被拒绝。
- 配对一次成功后不可重放；主机 challenge 不可重放。
- 在线 admin 与 host 可双向路由协议 v1 RPC/events；离线立即返回稳定错误。
- 业务载荷不会出现在 SQLite、结构化日志或审计表。
- 单个慢客户端和异常大 frame 不影响其他连接或耗尽内存。
- SIGTERM 能停止新请求并显式关闭 WebSocket，进程在 grace period 内退出。
- 云主机 Docker+Caddy 环境通过 WSS 真机/模拟器验证。

## Handoff Prompt

> 你负责 `services/remote-relay` Go 中转服务。先读取总控和协议方案，只消费 `protocol/remote/v1`，不要自行更改 wire contract。先用显式 dev token 和模拟器完成有界 WSS 路由，再接微信登录、配对和生产部署。Relay 只路由业务载荷，不得落库或日志记录内容。交付时附 `go test ./...`、`go test -race ./...` 结果，列出配置、migration、Docker/Caddy 操作和 payload 泄漏检查结果。

# Remote Relay M2 CVM Deployment Runbook

本手册仅覆盖 M2「CVM 可访问环境」。当前仍使用显式 `DEV_AUTH_MODE` 临时令牌，不包含真实微信 `code2Session`、正式主机配对、Electron 远程写操作、小程序业务页面或终端能力。

## DNS、备案与 TLS

部署前必须具备：

- 一台可运行 Docker Engine 与 Docker Compose plugin 的腾讯云 CVM。
- 一个解析到该 CVM 公网地址的专用域名，例如 `remote.example.com`。
- 若服务位于中国大陆，按腾讯云和适用监管要求完成域名实名认证、备案及接入确认；条件不满足时不得声称公网 TLS 已上线。
- 80/TCP 与 443/TCP 可从公网访问。若启用 HTTP/3，可额外开放 443/UDP。

Caddy 从 `RELAY_DOMAIN` 获取站点名并自动申请、续期 TLS 证书。Relay 本身只监听 Docker 内部网络的 `:8080`，不终止 TLS。Caddy access log 配置了 `format filter` 过滤，显式删除 `Authorization`、`X-Dev-Admin-Token`、`X-Dev-Host-Token` 与 `Cookie` 请求头，防止敏感凭据泄漏到访问日志中。

## 腾讯云安全组

应用公网入站规则只能包含：

| 协议 | 端口 | 来源 | 用途 |
| --- | --- | --- | --- |
| TCP | 80 | `0.0.0.0/0`、`::/0` | ACME 与 HTTPS 跳转 |
| TCP | 443 | `0.0.0.0/0`、`::/0` | HTTPS/WSS |
| UDP | 443 | `0.0.0.0/0`、`::/0` | 可选 HTTP/3 |

禁止为 `8080` 创建公网入站规则。SSH 不得对全网开放；仅允许固定管理 IP，或使用腾讯云带外登录/堡垒机。主机防火墙应与安全组保持相同边界。

验证监听面与服务声明：

```bash
sudo ss -lntup
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml config --quiet
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml config --services
```

注意：**禁止执行不带参数的 `compose config`**，否则会在终端或标准输出打印包含真实环境变量与 DEV token 明文的完整渲染配置。请使用 `--quiet` 仅做语法与配置校验，或使用 `--services` 仅确认服务声明。

Compose 只能发布 `80:80`、`443:443`，不得出现宿主 `8080` 映射。

## CVM 目录与权限

Relay 使用 UID/GID `10001`，Caddy 使用 UID/GID `10000`：

```bash
sudo install -d -m 0700 /etc/freebuddy
sudo install -d -m 0700 -o 10001 -g 10001 /var/lib/freebuddy/remote-relay
sudo install -d -m 0700 -o 10000 -g 10000 /var/lib/freebuddy/caddy-data
sudo install -d -m 0700 -o 10000 -g 10000 /var/lib/freebuddy/caddy-config
sudo install -d -m 0700 /var/backups/freebuddy
```

Relay 根文件系统以只读方式运行，仅 `/data` 和临时 `/tmp` 可写。SQLite 位于 `/data/relay.db`。

## 秘密配置

不要把 token、微信秘密或 pepper 写入 Git、镜像层、Compose 文件、shell profile 或命令行参数。创建 root-only 环境文件：

```bash
sudo install -m 0600 /dev/null /etc/freebuddy/remote-relay.env
sudoedit /etc/freebuddy/remote-relay.env
```

使用独立的 32 字节以上随机 base64url 值。下面的命令只生成随机值，不把值写入 shell 历史；分别执行两次并通过安全终端粘贴到文件：

```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
```

环境文件至少包含：

```dotenv
RELAY_ENV_FILE=/etc/freebuddy/remote-relay.env
RELAY_DOMAIN=remote.example.com
ACME_EMAIL=ops@example.com
RELAY_IMAGE=freebuddy/remote-relay:m2-YYYYMMDD
CADDY_IMAGE=caddy:2.10.2-alpine
RELAY_DATA_DIR=/var/lib/freebuddy/remote-relay
CADDY_DATA_DIR=/var/lib/freebuddy/caddy-data
CADDY_CONFIG_DIR=/var/lib/freebuddy/caddy-config

LISTEN_ADDR=:8080
PUBLIC_BASE_URL=https://remote.example.com
SQLITE_PATH=/data/relay.db
TRUST_PROXY=false
LOG_LEVEL=info
LOG_FORMAT=json
SHUTDOWN_GRACE_PERIOD=10s

DEV_AUTH_MODE=true
DEV_AUTH_ADMIN_TOKEN=<独立随机 base64url 值>
DEV_AUTH_HOST_TOKEN=<另一个独立随机 base64url 值>
DEV_AUTH_HOST_ID=host_dev
```

`deploy/remote-relay.env.example` 中的 `REPLACE_ME` 故意不能通过启动校验，不可直接用于部署。Caddy 只接收域名与 ACME 邮箱，不接收 Relay token。

## 首次部署

在已审核的源码版本中执行：

```bash
cd /opt/freebuddy
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml build --pull relay
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml up -d
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml ps
```

镜像中不得包含环境文件。Relay 镜像只声明 `8080`，宿主只由 Caddy 发布 80/443。

## 健康检查

容器内 `/readyz` healthcheck 同时验证进程和 SQLite 可用性。公网检查必须通过 Caddy：

```bash
curl --fail --silent --show-error https://remote.example.com/healthz
curl --fail --silent --show-error https://remote.example.com/readyz
```

`/healthz` 表示进程存活；`/readyz` 表示可接收请求。任何一个失败都不得继续外部 smoke。

## 外部 TLS/WSS 验证

在 CVM 外的受信任运维机上，从安全秘密存储加载 token，不在命令行中直接写 token：

```bash
set -a
. /secure/path/remote-relay-smoke.env
set +a
export RELAY_PUBLIC_BASE_URL=https://remote.example.com
export SMOKE_HOST_ID=host_dev
export SMOKE_PAYLOAD_SENTINEL=$(openssl rand -hex 24)
go run ./services/remote-relay/cmd/wss-smoke -events 1000
```

模拟器要求 `https://` 或 `wss://`，分别鉴权 Admin 与 Host，验证一轮 RPC 请求/响应，并严格检查 1000 条事件的 `seq`。它不打印 token 或 payload sentinel。

## 重启与持久性

部署后先确认数据库与 migration 记录存在：

```bash
sudo test -s /var/lib/freebuddy/remote-relay/relay.db
sudo sqlite3 /var/lib/freebuddy/remote-relay/relay.db \
  'SELECT version,name FROM schema_migrations ORDER BY version;'
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml restart relay
curl --fail --silent --show-error https://remote.example.com/readyz
sudo sqlite3 /var/lib/freebuddy/remote-relay/relay.db \
  'SELECT version,name FROM schema_migrations ORDER BY version;'
```

M2 只验证 `/data` 与 migration 元数据跨重启保留。正式管理员会话和配对记录要等后续真实认证/配对阶段实现后再验证，当前不得伪造该结论。

## 备份

SQLite 使用 WAL，运行中禁止只复制单个 `relay.db` 文件。优先使用 SQLite online backup：

```bash
backup=/var/backups/freebuddy/relay-$(date -u +%Y%m%dT%H%M%SZ).db
sudo sqlite3 /var/lib/freebuddy/remote-relay/relay.db ".backup '$backup'"
sudo chmod 0600 "$backup"
sudo sqlite3 "$backup" 'PRAGMA integrity_check;'
```

将备份加密后复制到独立故障域，并设置短期保留策略。备份可能包含身份、token hash、公钥和审计元数据，仍应视为敏感数据。

## 恢复演练

恢复必须在停止 Relay 后进行：

```bash
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml stop relay
sudo cp /var/lib/freebuddy/remote-relay/relay.db \
  /var/lib/freebuddy/remote-relay/relay.db.before-restore
sudo sqlite3 /var/backups/freebuddy/relay-YYYYMMDDTHHMMSSZ.db \
  ".backup '/var/lib/freebuddy/remote-relay/relay.db'"
sudo chown 10001:10001 /var/lib/freebuddy/remote-relay/relay.db
sudo chmod 0600 /var/lib/freebuddy/remote-relay/relay.db
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml start relay
curl --fail --silent --show-error https://remote.example.com/readyz
```

随后检查 `PRAGMA integrity_check`、migration 版本与外部 WSS smoke。恢复失败时停止服务并还原 `relay.db.before-restore`。

## 升级

每次升级前完成一致性备份，并保留当前镜像 tag：

```bash
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml build --pull relay
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml up -d --no-deps relay
curl --fail --silent --show-error https://remote.example.com/readyz
```

升级后运行外部 WSS smoke、数据边界检查和 migration 版本检查。SIGTERM 会触发 `server.draining`、关闭升级连接并在 grace period 内退出。

## 回滚

若新版本未执行新 migration，将 `RELAY_IMAGE` 改回已知良好 tag，再执行：

```bash
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml up -d --no-deps --no-build relay
```

若新 migration 已执行，禁止仅回滚二进制。应停止 Relay、恢复升级前备份，再启动旧镜像。migration 当前为前向事务式执行，没有自动 down migration。

## 秘密轮换

M2 DEV token 轮换步骤：

1. 生成两枚新的独立高熵 token。
2. 原子更新 `/etc/freebuddy/remote-relay.env`，保持 `0600`。
3. 重启 Relay；现有 WSS 连接会断开。
4. 更新运维机秘密存储并运行外部 smoke。
5. 检查日志与 SQLite 中不存在新旧 token 原文。

正式微信/AppSecret/token pepper 的轮换属于后续认证阶段，本轮不执行。

## 日志与 SQLite 数据边界

Compose 为 Relay/Caddy 配置了 Docker `json-file` 轮转。监控至少包括：容器重启、磁盘水位、`/readyz`、活动连接数、认证失败、RPC timeout、backpressure 和 heartbeat timeout。

完成 smoke 后执行：

```bash
export RELAY_ENV_FILE=/etc/freebuddy/remote-relay.env
export RELAY_DATA_DIR=/var/lib/freebuddy/remote-relay
set -a
. "$RELAY_ENV_FILE"
set +a
export SMOKE_PAYLOAD_SENTINEL=<本次 smoke 使用的值>
services/remote-relay/deploy/verify-data-boundary.sh
```

脚本只报告 pass/fail，不回显 token 或 sentinel；它通过管道将搜索模式传入标准输入（避免在 `ps aux` 进程参数列表中泄漏敏感凭证），严格检查 Relay 与 Caddy 的 Docker 容器日志，以及 SQLite 二进制数据库文件（包括 `relay.db`、`relay.db-wal` 和 `relay.db-shm`）中不存在这些原文。若失败，立即停止 Relay、隔离日志/备份并按安全事件处理，禁止继续部署。

## 紧急停机

```bash
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml stop relay
```

需要撤销 M2 DEV 访问时，同时移除安全组 80/443 入站、轮换 DEV token，并保留脱敏审计证据。正式管理员会话撤销和 host revocation 属于后续阶段。

## 外部验证阻塞

若缺少 CVM、域名解析、备案条件、80/443 入站或可信 TLS 证书，只能完成镜像、Compose、Caddy、静态检查和本地容器验证。此时 M2 的“外网 `wss://<domain>/v1/ws/...` 建连”出口明确为 **blocked**，不得把本地 `httptest`、自签名 TLS 或 Compose 启动冒充公网验证成功。

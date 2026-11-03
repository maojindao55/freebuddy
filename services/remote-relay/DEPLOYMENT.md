# Remote Relay M2 公网 DEV 部署手册

本手册覆盖 M2「公网 DEV 可访问环境」。当前仍使用显式 `DEV_AUTH_MODE` 临时令牌，不包含真实微信 `code2Session`、正式主机配对、Electron 远程写操作、小程序业务页面或终端能力。

## DNS、备案与 TLS

部署前必须具备：

- 一台可运行 Docker Engine 与 Docker Compose plugin 的云主机（当前部署目标为百度智能云 BCC 实例 106.13.104.125，规划兼容通用 Linux 云主机）。
- 一个解析到该云主机公网地址的专用域名，例如 `remote.example.com`。
- 若服务位于中国大陆，按云服务商和适用监管要求完成域名实名认证、备案及接入确认；条件不满足时不得声称公网 TLS 已上线。
- 80/TCP 与 443/TCP 可从公网访问。若启用 HTTP/3，可额外开放 443/UDP。

Caddy 从 `RELAY_DOMAIN` 获取站点名并自动申请、续期 TLS 证书。Relay 本身只监听 Docker 内部网络的 `:8080`，不终止 TLS。Caddy access log 配置了 `format filter` 过滤，显式删除 `Authorization`、`X-Dev-Admin-Token`、`X-Dev-Host-Token` 与 `Cookie` 请求头，防止敏感凭据泄漏到访问日志中。

## 云侧安全组

Relay 服务自身新增的公网入站规则只能包含：

| 协议 | 端口 | 来源 | 用途 |
| --- | --- | --- | --- |
| TCP | 80 | `0.0.0.0/0`、`::/0` | ACME 与 HTTPS 跳转 |
| TCP | 443 | `0.0.0.0/0`、`::/0` | HTTPS/WSS |
| UDP | 443 | `0.0.0.0/0`、`::/0` | 可选 HTTP/3 |

禁止为 Relay 的 `8080` 创建公网入站规则。SSH 不得对全网开放；仅允许固定管理 IP，或使用云服务商控制台带外登录/堡垒机。Relay 在容器网络内部仅向 Caddy 提供 8080，宿主机绝不直接发布 8080 端口。

### Relay 自身网络边界与共享主机 DEV 例外

1. **Relay 自身入口约束**：
   - Relay 容器仅在 `internal: true` 的 `relay_internal` Docker 桥接网络中通过 `expose: "8080"` 声明端口，不向宿主机发布任何端口。
   - 唯一对外发布端口的是边缘代理 Caddy（`80:80` 与 `443:443`）。Relay 自身绝不监听或暴露非 80/443 的公网入口。

2. **共享主机既存业务 DEV 例外（百度智能云 106.13.104.125）**：
   - 当前部署目标云主机上存在既有业务容器（监听并暴露 `3000`、`8791` 等端口）。
   - 用户已明确确认：共享主机既有 3000/8791 维持现状，批准作为 M2 公网 DEV 验收例外。不得把整台主机描述为“公网只开放 80/443”，也不得为 Relay 改动既有业务容器、云侧安全组或宿主机防火墙（iptables）；所有既有业务容器、网络与防火墙配置保持完全不动。
   - Relay 维护者严禁擅自修改或停止用户既有业务容器，严禁改动宿主机 iptables 或云安全组；必须恪守不改、不停既存业务原则。
   - 该例外仅适用于 M2 DEV 环境及后续只读开发验证，不是整机生产网络边界已合格的声明。

3. **生产环境隔离选项与 M8 复审要求（不造成当前 DEV 阻塞）**：
   - 当前 M2 DEV 验收不要求关闭 3000/8791 或变更既有业务配置。
   - 面向未来生产环境时，可将以下路径列为生产候选选项（供后续生产环境参考，不作为当前 DEV 阶段阻塞项）：
     - **独立专用云主机（推荐生产方案）**：为 Remote Relay 开通专用云主机（如独立百度智能云 BCC 实例），杜绝与旧业务同机混部，安全组收敛为仅 80/443 及管理 IP SSH。
     - **业务迁移**：将既有业务容器迁移至专用业务机，使 Relay 主机净化为专用网关。
     - **安全组/网络深度收敛**：在业务维护窗口由相关维护人员评估收敛规则或绑定至专用内网/回环地址。
   - **M8 发布前风险复审**：在 M8 正式发布前，必须针对共享主机的公网暴露与混部隔离风险重新进行安全审查，并单独作出生产风险决策；M2 DEV 阶段无需提前执行上述生产隔离变更。

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

## 云主机目录与权限

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

外部验证在云主机外的受信任运维机上执行。必须在检出的 FreeBuddy 仓库根目录执行下列自包含脚本。该脚本将外部 WSS smoke 验证与远端数据边界安全校验整合为单一、可复制且经过测试的执行流：

1. **环境与路径前提**：脚本由 `set -euo pipefail` 保护，确保任何步骤出错或管道命令失败立即非零退出；显式校验必须从 FreeBuddy 仓库检出根目录运行。
2. **凭据隔离与权限保障**：运维 token（`DEV_AUTH_ADMIN_TOKEN` 与 `DEV_AUTH_HOST_TOKEN`）必须由受信秘密管理器（如企业密钥库、Vault、无交互 CI 环境变量注入等）在启动验证子 shell 前以非执行方式直接注入进程环境变量，绝不得通过 `source` / `.` 执行本地 env 文件以消除代码注入路径；脚本开头显式拒绝 `SMOKE_ENV_FILE` 且严格校验两项必需 token 非空；sentinel 纯在内存中生成或由预设环境变量加载，绝不在本机磁盘落地临时文件，彻底消除文件载荷执行风险；token 与 sentinel 均通过环境变量与安全管道注入，绝不作为任何命令的命令行参数（argv）、日志或源码。
3. **主机公钥预验与 known_hosts 校验**：运维人员必须预先通过带外可信渠道（如云服务商控制台获取的主机指纹）核实云主机的 SSH 公钥指纹，并写入运维机的 `~/.ssh/known_hosts`。脚本执行时调用 `ssh-keygen -F remote.example.com` 校验 `known_hosts` 中是否存在该主机记录（防止非交互 `BatchMode=yes` 遇未收录公钥直接被阻断，或静默受到未知主机指纹威胁）。**安全语义说明**：`ssh-keygen -F` 检查仅验证 `known_hosts` 文件中存在匹配记录，该检查本身绝不证明公钥真实性或来源合法性；公钥指纹的真实权威来源必须在写入 `known_hosts` 前经带外通道确认。SSH 连接保持 `-o BatchMode=yes -o StrictHostKeyChecking=yes`。
4. **外部 WSS 路由验证**：在执行任何后续逻辑前，先对内存中的 sentinel 严格校验纯十六进制格式（`^[0-9a-fA-F]{32,64}$`），若预设异常或非纯 hex 立即阻断退出，杜绝任何命令注入与预设 payload 执行风险；随后进入 `services/remote-relay` 模块目录执行 `go run ./cmd/wss-smoke`，验证 TLS/WSS 建连、双向鉴权、RPC 回显与 1000 条事件序列号。
5. **单次 SSH 零磁盘残留管道校验**：通过单次 SSH 管道（`BatchMode=yes`、`StrictHostKeyChecking=yes`、`sudo -n bash -s`）将严格校验后的纯 hex sentinel 仅注入远端进程内存并执行数据边界校验，全程不在云端磁盘落地任何 sentinel 文件。
6. **双端信号退出契约与可靠清理**：本机与远端均注册 EXIT trap `unset` 敏感环境变量；捕捉到 SIGINT（退出码 130）与 SIGTERM（退出码 143）或发生任何故障（如 SSH 传输失败退出 255）时，均可靠释放内存变量并准确返回真实的非零退出状态码。

```bash
(
set -euo pipefail

# 必须在 FreeBuddy 仓库检出根目录执行（确保子模块与脚本路径有效）
if [ ! -f "services/remote-relay/cmd/wss-smoke/main.go" ]; then
  echo "安全校验失败：请在 FreeBuddy 仓库检出根目录执行此脚本" >&2
  exit 1
fi

cleanup_local_smoke() {
  local rc=$?
  unset DEV_AUTH_ADMIN_TOKEN DEV_AUTH_HOST_TOKEN SMOKE_ADMIN_TOKEN SMOKE_HOST_TOKEN SMOKE_PAYLOAD_SENTINEL ENCODED_ADMIN_TOKEN ENCODED_HOST_TOKEN
  exit "$rc"
}
trap cleanup_local_smoke EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 严禁使用 SMOKE_ENV_FILE 本地文件载入凭据（彻底消除 source 执行本地文件的命令注入路径）
if [ -n "${SMOKE_ENV_FILE:-}" ]; then
  echo "安全校验失败：禁止使用 SMOKE_ENV_FILE 本地文件载入凭据；DEV_AUTH_ADMIN_TOKEN 与 DEV_AUTH_HOST_TOKEN 必须由受信秘密管理器在启动子 shell 前以非执行方式直接注入环境变量" >&2
  exit 1
fi

# 严格校验必需的运维 token 环境变量（必须由受信秘密管理器非执行式注入，缺失立即阻断退出）
if [ -z "${DEV_AUTH_ADMIN_TOKEN:-}" ] || [ -z "${DEV_AUTH_HOST_TOKEN:-}" ]; then
  echo "安全校验失败：缺少必需的 DEV_AUTH_ADMIN_TOKEN 或 DEV_AUTH_HOST_TOKEN 环境变量（须由受信秘密管理器非执行式注入）" >&2
  exit 1
fi

# 纯内存环境变量生成或读取预设 sentinel（绝不在本机磁盘落地临时环境文件，彻底消除文件载荷执行风险）
: "${SMOKE_PAYLOAD_SENTINEL:=$(openssl rand -hex 32)}"

# 在执行任何后续逻辑前，先对内存中的 sentinel 严格校验纯 Hex 格式（防注入与异常预设；校验失败立即阻断退出）
if ! printf '%s' "$SMOKE_PAYLOAD_SENTINEL" | grep -Eq '^[0-9a-fA-F]{32,64}$'; then
  echo "安全校验失败：SMOKE_PAYLOAD_SENTINEL 必须为 32-64 位纯 Hex 字符串" >&2
  exit 1
fi
export SMOKE_PAYLOAD_SENTINEL

# 校验云主机公钥是否已记录在本地 known_hosts 中
# 语义说明：ssh-keygen -F 仅检查 known_hosts 文件中是否存在匹配记录，防止 BatchMode 因无交互提示直接拒绝；
# 该检查本身不证明公钥真实性或来源合法性，运维人员必须预先通过带外可信渠道核实公钥指纹并写入 known_hosts。
if ! ssh-keygen -F remote.example.com >/dev/null 2>&1; then
  echo "安全校验失败：未在 known_hosts 找到 remote.example.com 公钥记录，请预先通过可信渠道核实公钥并加入 known_hosts" >&2
  exit 1
fi

# 进入包含 go.mod 的 Relay 模块目录执行外部 WSS smoke
(
  cd services/remote-relay
  go run ./cmd/wss-smoke \
    -base-url https://remote.example.com \
    -host-id host_dev \
    -events 1000
)

# 对运维机内存中的两 token 进行安全编码，经单次 SSH stdin 管道传递到远端解码
# 绝不进入进程 argv/系统日志，任意原值均无法突破 shell 语法，远端绝不执行 RELAY_ENV_FILE
ENCODED_ADMIN_TOKEN="$(printf '%s' "$DEV_AUTH_ADMIN_TOKEN" | base64 | tr -d '\r\n')"
ENCODED_HOST_TOKEN="$(printf '%s' "$DEV_AUTH_HOST_TOKEN" | base64 | tr -d '\r\n')"

if ! printf '%s' "$ENCODED_ADMIN_TOKEN" | grep -Eq '^[A-Za-z0-9+/=]+$' || \
   ! printf '%s' "$ENCODED_HOST_TOKEN" | grep -Eq '^[A-Za-z0-9+/=]+$'; then
  echo "安全校验失败：token 编码格式异常" >&2
  exit 1
fi

# 单次 SSH 管道执行校验：全程零云端磁盘残留、无传输后空档、argv 无秘密
{
  printf 'export SMOKE_PAYLOAD_SENTINEL=%s\n' "$SMOKE_PAYLOAD_SENTINEL"
  printf 'ENCODED_ADMIN_TOKEN=%s\n' "$ENCODED_ADMIN_TOKEN"
  printf 'ENCODED_HOST_TOKEN=%s\n' "$ENCODED_HOST_TOKEN"
  cat <<'EOF'
set -euo pipefail

cleanup_cloud_verify() {
  local rc=$?
  unset DEV_AUTH_ADMIN_TOKEN DEV_AUTH_HOST_TOKEN SMOKE_ADMIN_TOKEN SMOKE_HOST_TOKEN SMOKE_PAYLOAD_SENTINEL ENCODED_ADMIN_TOKEN ENCODED_HOST_TOKEN
  exit "$rc"
}
trap cleanup_cloud_verify EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 经 stdin 数据流安全解码 token（无 argv 暴露，非执行式解析，绝不 source 远端 env 文件）
DEV_AUTH_ADMIN_TOKEN="$(printf '%s' "${ENCODED_ADMIN_TOKEN:-}" | { base64 -d 2>/dev/null || base64 -D; })"
DEV_AUTH_HOST_TOKEN="$(printf '%s' "${ENCODED_HOST_TOKEN:-}" | { base64 -d 2>/dev/null || base64 -D; })"
if [ -z "$DEV_AUTH_ADMIN_TOKEN" ] || [ -z "$DEV_AUTH_HOST_TOKEN" ]; then
  echo "安全校验失败：远端解码 token 失败或 token 为空" >&2
  exit 1
fi
export DEV_AUTH_ADMIN_TOKEN DEV_AUTH_HOST_TOKEN

RELAY_ENV_FILE="${RELAY_ENV_FILE:-/etc/freebuddy/remote-relay.env}"
RELAY_DATA_DIR="${RELAY_DATA_DIR:-/var/lib/freebuddy/remote-relay}"
FREEBUDDY_DIR="${FREEBUDDY_DIR:-/opt/freebuddy}"

validate_secure_file() {
  local target="$1"
  if [ ! -f "$target" ]; then
    echo "安全校验失败：文件不存在: $target" >&2
    return 1
  fi
  local owner
  owner="$(stat -c '%u' "$target" 2>/dev/null || stat -f '%u' "$target" 2>/dev/null)"
  if [ "$owner" != "0" ]; then
    echo "安全校验失败：$target 属主必须为 root (UID 0)，当前为 $owner" >&2
    return 1
  fi
  local mode
  mode="$(stat -c '%a' "$target" 2>/dev/null || stat -f '%Lp' "$target" 2>/dev/null)"
  if [ "$mode" != "600" ] && [ "$mode" != "400" ]; then
    echo "安全校验失败：$target 权限必须为 0600 或 0400，当前为 $mode" >&2
    return 1
  fi
  return 0
}

validate_secure_file "$RELAY_ENV_FILE"

# RELAY_ENV_FILE 仅作为 docker compose --env-file 的只读数据路径，绝不得执行（禁止 source/.）
export RELAY_ENV_FILE
export RELAY_DATA_DIR

cd "$FREEBUDDY_DIR"
services/remote-relay/deploy/verify-data-boundary.sh
EOF
} | ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ops@remote.example.com 'sudo -n bash -s'
)
```

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

M2 阶段在云主机（当前为百度智能云 106.13.104.125）上运行于 `DEV_AUTH_MODE=true` 临时令牌模式，未接入真实微信认证与主机配对流程，因此云主机数据库中的 `admin_sessions`、`hosts`、`pairings`、`audit_events` 四张业务表在 M2 为空属于正常预期。

**持久性边界与验收判定**：
1. **测试层验证**：在隔离的 Go 单测环境（`internal/store/TestStore_PersistenceAcrossRestart`）中，已通过文件级 SQLite 模拟完整的数据库关闭与重新打开，证明了 `admin_sessions` 会话记录的行级跨重启持久性（创建、检索、Touch、更新），以及其他三张元数据表（`hosts`、`pairings`、`audit_events`）的表结构存在与可查询性；该单测不用于证明 `hosts` 或 `pairings` 真实业务行的跨重启持久性。
2. **DEV 验收标准**：在 M2 公网 DEV 环境中，Relay 重启后 SQLite `schema_migrations`（版本 1）元数据保持、数据库就绪（`/readyz` 通过）且元数据表可查询，配合通过外部 WSS DEV smoke 测试，即满足 M2 公网 DEV 出口条件。严禁在 M2 伪造正式微信认证，严禁向数据库注入虚假记录，严禁越权提前实现 M3/M4/M5 逻辑。
3. **真实业务记录持久性推迟至 M4**：真实管理员会话与主机配对业务记录的跨重启持久性验证已明确推迟至 M4「小程序只读接入」阶段出口闭环；M2 DEV 验收不再以此为阻塞。

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

### 数据边界校验执行

外部 smoke 完成后，必须执行数据边界校验。校验通过[外部 TLS/WSS 验证](#外部-tlswss-验证)中运维机脚本的单次 SSH 标准输入安全管道（`BatchMode=yes`、`StrictHostKeyChecking=yes`、`sudo -n bash -s`）统一调度执行，将 sentinel 仅传入云端 root bash 内存环境变量中，全程零云端磁盘文件残留，杜绝传输中断残存文件与传输-校验时间差风险。

校验脚本会检查 Relay 和 Caddy 容器日志以及 SQLite 数据文件（含 WAL/SHM），确认没有记录敏感凭证与业务载荷。

### 操作路径、权限、清理与日志安全说明

1. **零持久化与云端无磁盘文件残留**：
   - sentinel 仅作为运维机与云端 root bash 进程内存中的临时环境变量存在，不向运维机或云端文件系统写入任何 sentinel 文件，杜绝中断残存及预置符号链接劫持风险。
2. **两阶段可靠清理与信号退出契约**：
   - 运维机与云端均由 EXIT trap 严格保障在命令成功、发生任何非零故障或收到中断信号时可靠 `unset` 敏感环境变量。
   - 捕捉到 SIGINT 时显式退出码 130，捕捉到 SIGTERM 时显式退出码 143，在退出前由 EXIT trap 完成变量释放，确保退出状态码真实反映中断状态。
3. **严格不落参数与日志**：
   - 生成、传递与加载全程使用标准输入管道或安全文件重定向，严禁将 sentinel 或 token 作为任何命令的命令行参数（`argv`），严禁使用 `echo "$SMOKE_PAYLOAD_SENTINEL"`。
   - 避免将 sentinel 明文写入 shell 历史（`HISTFILE`）、系统审计日志（auditd）或终端回显。
4. **服务边界与凭据防泄漏**：
   - 不得新增通用秘密存储服务或修改 Relay 自身服务代码；校验完全基于现有 root-only 临时环境文件与标准环境变量接口。

脚本只报告 pass/fail，不回显 token 或 sentinel；它通过管道将搜索模式传入标准输入（避免在 `ps aux` 进程参数列表中泄漏敏感凭证），严格检查 Relay 与 Caddy 的 Docker 容器日志，以及 SQLite 二进制数据库文件（包括 `relay.db`、`relay.db-wal` 和 `relay.db-shm`）中不存在这些原文。若失败，立即停止 Relay、隔离日志/备份并按安全事件处理，禁止继续部署。

## 紧急停机

```bash
sudo docker compose --env-file /etc/freebuddy/remote-relay.env \
  -f services/remote-relay/deploy/compose.yaml stop relay
```

需要撤销 M2 DEV 访问时，同时移除安全组 80/443 入站、轮换 DEV token，并保留脱敏审计证据。正式管理员会话撤销和 host revocation 属于后续阶段。

## 外部验证阻塞

若缺少云主机（当前部署目标为百度智能云 106.13.104.125）、未完成域名备案、公网 80/443 入站不通、未获取可信 CA 证书，或外部 WSS DEV smoke 验证失败，M2「公网 DEV 可访问环境」出口明确为 **blocked**（或 `needs_changes`），不得把本地 `httptest`、自签名 TLS 或单纯 Compose 启动冒充公网 DEV 验收通过。

**DEV 例外与后续阶段出口明确**：
1. **共享主机既存端口例外**：共用云主机上既有业务的 3000/8791 维持现状，是用户批准的 M2 公网 DEV 阶段例外，不作为当前 M2 DEV 验收的阻塞项。该例外不代表整机生产网络边界已合格；M8 发布前须重新审查共享主机的公网暴露与隔离风险，并单独作出生产风险决策。
2. **元数据持久性验收解耦**：DEV smoke 与 migration 元数据持久性可签 M2 DEV 出口。真实管理员会话与主机配对业务记录的跨重启持久性统一推迟至 M4 验收，不在 M2 造成阻塞。

---
title: FreeBuddy Remote Admin Control - Master Implementation Plan
type: feat
date: 2026-09-01
topic: remote-admin-control
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
repository: freebuddy-monorepo
component: cross-component
---

# FreeBuddy 远程管理员控制——总实施方案

## Goal Capsule

- **目标：** 让唯一管理员通过微信小程序，经云主机（当前为百度智能云）上的 Go 中转服务，远程查看并完整操作自己电脑上的 FreeBuddy。
- **一期定位：** 单管理员、单租户、允许绑定一台或少量自有主机；不是 SaaS 多用户系统。
- **控制范围：** FreeBuddy 应用内的会话、任务、Agent、工作流、授权决策和受约束终端；不开放任意 Electron IPC、任意本机命令或系统级远控。
- **数据原则：** 中转服务只鉴权和转发，不持久化聊天内容、代码、终端输出或工作区文件。
- **仓库策略：** 当前只有一个 `freebuddy` monorepo。各 Agent 在同一仓库内按目录分工，不再额外创建 Git 仓库。
- **开放阻塞项：** 上线前需要微信小程序 AppID/AppSecret、管理员 OpenID、已备案域名、云主机和 TLS；本地开发可使用测试令牌和模拟客户端，不受这些条件阻塞。

## 关联实施方案

以下文件分别交给对应 Agent。总控 Agent 负责协调依赖和最终集成，不应把五份计划合成一次大改动。

| Agent | 负责方案 | 主要目录 |
| --- | --- | --- |
| 协议 Agent | [远程控制协议方案](./2026-09-01-002-remote-admin-protocol-plan.md) | `protocol/remote/v1/`、`packages/protocol/` |
| Relay Agent | [Go 云中转服务方案](./2026-09-01-003-remote-admin-relay-server-plan.md) | `services/remote-relay/` |
| Desktop Agent | [FreeBuddy 桌面端方案](./2026-09-01-004-remote-admin-desktop-plan.md) | `electron/remote/` 及相关共享模块 |
| 小程序 Agent | [微信小程序方案](./2026-09-01-005-remote-admin-wechat-miniprogram-plan.md) | `apps/wechat-miniprogram/` |

## Product Contract

### 已确定的产品决策

- 使用云主机（当前为百度智能云）作为公网中转，不采用微信云开发作为核心链路。
- Relay 使用 Go；桌面端继续使用 TypeScript/Electron；微信小程序使用原生 TypeScript。
- 三端共享版本化 JSON 协议，不共享语言运行时。
- 管理员身份由服务端调用微信 `code2Session` 后比对 `ADMIN_OPENID` 决定；客户端自报 OpenID 无效。
- 桌面端主动建立出站 WSS 连接，因此用户电脑不需要开放公网端口。
- 管理员请求始终映射为桌面端本地 owner/admin，操作原工作区，不创建远程用户工作区克隆。
- Relay 不做离线命令队列。桌面端离线时，写请求立即返回 `host_offline`。
- 一期“完全接管”指 FreeBuddy 应用能力的完整管理员控制，不等于暴露 shell、文件系统或 Electron IPC 的通用后门。

### 一期能力范围

**只读能力**

- 查看主机在线状态、版本、当前运行任务和待处理决策。
- 查看项目、Agent、会话、消息、任务日志、工作流和委托执行状态。
- 获取断线后的增量事件；无法增量恢复时获取完整同步快照。

**写入能力**

- 创建、重命名、归档和删除会话。
- 发送消息、开始/停止 Agent 运行，并持续接收流式输出。
- 响应权限申请和认证申请。
- 启停允许远程操作的工作流、委托和任务动作。
- 在显式项目范围内创建受约束终端会话，输入、调整尺寸、查看输出和关闭。

**一期不做**

- 多管理员、组织、角色和计费。
- 微信云开发数据库或云函数承担主链路。
- Relay 保存聊天、代码、终端记录或工作区文件。
- 离线排队写操作，或客户端断线后盲目重试非幂等请求。
- 通用 `ipc.invoke(channel, args)`、任意二进制执行、任意 cwd/env 注入。
- 远程安装插件、升级 FreeBuddy、修改主机级安全设置。
- 桌面屏幕流、鼠标键盘系统级远控。

## Target Architecture

```text
微信小程序
  wx.login + WSS/RPC
          │
          ▼
云主机（当前为百度智能云）
  Caddy :443 ── Go Relay :8080 ── SQLite(仅身份/配对/审计元数据)
          ▲
          │ 双向 WSS；只路由，不落业务载荷
          │
FreeBuddy Electron
  RelayClient ─ Dispatcher ─ RemoteTurnCoordinator ─ 现有领域服务/CLI runtime
```

推荐 monorepo 布局：

```text
freebuddy/
├── apps/
│   └── wechat-miniprogram/
├── services/
│   └── remote-relay/          # 独立 go.mod，不加入 npm workspaces
├── protocol/
│   └── remote/v1/             # 与语言无关的 JSON Schema 和 fixtures
├── packages/
│   ├── protocol/              # TS 绑定，导出 @freebuddy/protocol/remote
│   └── cli-stream/            # 可被桌面 renderer/main 复用的流解析
└── electron/
    └── remote/
```

## Security Invariants

任何子方案都不得突破下列约束：

1. Relay 到桌面端只传领域方法名，不传原始 Electron IPC channel。
2. 桌面端只执行显式注册的方法，并再次校验参数、资源归属、当前状态和管理员身份。
3. Relay 提供的 `userId`、`isAdmin`、cwd、binary、env 等字段不具有信任力；身份在桌面端固定映射到 owner/admin。
4. 微信 AppSecret 只存在于 Relay 环境变量/密钥管理中，不进入小程序包、仓库、日志或响应。
5. 桌面主机私钥只保存在本机，并使用 Electron `safeStorage` 保护；Relay 只保存公钥。
6. 管理员令牌和刷新令牌使用高熵随机值；服务端只保存哈希，日志不输出原值。
7. 配对口令一次性、短时有效，默认 5 分钟；成功领取后立即作废。
8. 载荷有大小、时效、并发和速率限制；慢客户端不得拖垮 Relay 或桌面进程。
9. 原始聊天、代码和终端内容不写入 Relay 数据库或应用日志。
10. 桌面端必须提供远程控制状态指示、立即断开和撤销设备入口。

## Execution Sequence

### M0：协议冻结与本地脚手架

负责人：协议 Agent，其他 Agent 可同时准备目录但不得自行发明协议。

- 建立 `protocol/remote/v1` schema、fixtures、错误码和签名规范。
- 在 `packages/protocol` 导出 TS 类型。
- 为 Go/TS 建立共同 fixtures 的兼容性测试。

**出口条件：** 有效/无效消息、签名 canonical payload 和幂等场景都有 golden fixtures；协议 v1 被总控 Agent 接受。

### M1：Relay 最小闭环

负责人：Relay Agent。

- 使用临时 `ADMIN_TOKEN`/`HOST_TOKEN` 完成两个模拟客户端间的 WSS 请求、响应和事件转发。
- 验证 1000 个有序事件、超时、断连、慢消费者和优雅停机。
- 此阶段不等待微信资质，也不加入真实业务载荷。

**出口条件：** `go test ./...` 和 `go test -race ./...` 通过，模拟器能证明路由闭环。

### M2：公网 DEV 可访问环境

负责人：Relay Agent/运维。

- Docker 部署 Go Relay，Caddy 提供 WSS/TLS。
- Relay 新增的公网入口仅为 Caddy 的 80/443；Relay 的 8080 只在容器网络内开放。当前共用云主机上既有业务的 3000/8791 保持现状，作为本阶段已确认的 DEV 环境例外；不得把整台主机描述为“公网只开放 80/443”，也不得为 Relay 改动既有业务容器、云安全组或宿主机防火墙。
- 配置健康检查、结构化日志、备份和恢复说明。

**出口条件：** 外网通过可信 TLS 的 `wss://<domain>/v1/ws/...` 建连；使用显式 DEV 令牌的模拟管理员与主机完成 WSS 路由验证；Relay 重启后 SQLite migration 元数据保持、数据库可用；业务载荷未落盘。此出口只确认公网 DEV 环境，不证明正式微信身份、主机配对或其业务记录的跨重启持久性。

**阶段例外与发布边界：** 用户确认当前共享主机的既有 3000/8791 公网入口维持现状，此例外仅适用于 M2 DEV 环境及后续只读开发验证，不是整机生产网络边界已合格的声明。正式管理员会话及主机配对业务记录的跨重启验证移至 M4 出口；M8 发布前须重新审查共享主机的公网暴露与隔离风险，并单独作出生产风险决策。M2 不开启真实认证、远程写操作或终端能力。

### M3：桌面端只读接入

负责人：Desktop Agent。

- 先把单播 `eventBus` 改为多订阅，保证现有 WebUI 不回归。
- 实现主机凭证、配对、RelayClient 状态机和只读 dispatcher。
- 实现快照和断线恢复所需的事件缓冲。

**出口条件：** 桌面窗口隐藏时，模拟管理员仍能获取稳定快照和实时只读事件。

### M4：小程序只读接入

负责人：小程序 Agent。

- 完成微信登录、令牌刷新、单例 socket、RPC 客户端、主机状态与会话浏览。
- 完成前后台切换、弱网恢复和 snapshot fallback。

**出口条件：** 真机可登录唯一管理员并查看在线主机、会话和消息；非管理员被拒绝。真实管理员会话与主机配对业务记录在 Relay 重启后仍可恢复，且不向 Relay 持久化业务载荷。

### M5：无界面写入与 Agent 运行

负责人：Desktop Agent 为主，协议和小程序 Agent 配合。

- 提取/实现 main-process `RemoteTurnCoordinator`，使运行不依赖可见 renderer 或 `WebContents`。
- 支持发送消息、流式输出、停止运行、权限/认证决策和最终持久化。
- 小程序实现对应交互，写操作使用幂等键且不盲目重试。

**出口条件：** 桌面窗口隐藏、小程序中途断网的情况下，运行仍在桌面端正确完成并持久化；重连可恢复最终结果。

### M6：可靠性与恢复

负责人：三端共同完成。

- 实现 seq、resume、ring buffer、snapshot fallback、请求 TTL、RPC timeout 和背压。
- 做断网、切网、云主机重启、桌面休眠、重复请求和乱序响应测试。

**出口条件：** 所有写操作最多执行一次或返回可识别的重复结果；用户能理解主机离线、超时和恢复状态。

### M7：受约束终端

负责人：Desktop Agent 和小程序 Agent。

- 终端单独命名空间和会话生命周期，必须绑定项目 ID。
- 一期先支持纯文本/有限 ANSI、输入、Ctrl 快捷键、resize 和主动关闭。

**出口条件：** 终端无法逃逸项目约束或注入任意启动 binary/env；会话超时和远程总开关有效。

### M8：安全、运维与发布

负责人：总控 Agent。

- 威胁建模、秘密扫描、依赖审计、日志检查、限流与告警。
- 文档化部署、配对、撤销、故障恢复和紧急关闭。
- 完成微信合法域名、隐私说明、备案和真机回归。

**出口条件：** 安全清单和发布验收全部通过；没有 P0/P1 未解决问题。

## Parallel Work Rules

- M0 fixtures 冻结后，Relay、Desktop 和小程序 Agent 才能并行实现传输层。
- 每个 Agent 只修改自己方案列出的目录；需要跨边界时先在 PR 描述中列出接口变化。
- `packages/protocol` 和 `protocol/remote/v1` 由协议 Agent 所有，其他 Agent 只能消费；协议修改必须同步 Go/TS fixtures。
- Desktop Agent 独占 `electron/eventBus.ts` 和 main-process turn orchestration 的重构，避免多个 Agent 同时修改关键路径。
- 小程序 Agent 不应以 Relay 尚未完成为由硬编码 mock 数据到生产路径；mock transport 必须可替换。
- 每个里程碑用小 PR 合并；禁止一次 PR 同时实现协议、Relay、桌面端和小程序。

## Cross-Component Acceptance Scenarios

### A1：首次配对

1. 桌面端生成本地主机密钥并展示一次性二维码。
2. 唯一管理员在小程序登录并领取配对。
3. Relay 保存主机公钥与管理员绑定；桌面端通过 challenge 签名上线。
4. 配对口令再次使用必须失败；非管理员领取必须失败。

### A2：远程会话运行

1. 小程序选择已有会话并发送消息。
2. 桌面端将请求映射为 owner/admin，在原工作区中执行。
3. 流式文本、工具调用、命令输出和权限申请按序到达小程序。
4. 管理员批准或拒绝；最终消息由桌面 main process 持久化。
5. 整个过程中 Relay 不保存业务内容。

### A3：断网恢复

1. 小程序在运行期间进入后台或切换网络。
2. 桌面端继续运行并缓存有限事件。
3. 小程序恢复后带最后 seq 发起 resume；在窗口内补齐事件。
4. 若事件已被淘汰，则返回 snapshot 并继续从新游标订阅。
5. 原写请求不会因为自动重试而执行两次。

### A4：主机离线

1. 桌面端退出或失去网络。
2. Relay 立即将主机标记为离线。
3. 只读状态显示离线；写请求返回 `host_offline`，不进入离线队列。
4. 主机重连后重新认证并发布快照。

### A5：紧急撤销

1. 用户在桌面端关闭云中转或撤销管理员设备。
2. 当前 WSS 和终端会话立即关闭，Relay 会话失效。
3. 旧令牌、旧配对口令和旧连接不能重新取得控制权。

## Repository-Wide Verification

最终合并前至少运行：

```bash
npm run lint
npm run typecheck
npm test
npm run build
(cd services/remote-relay && go test ./...)
(cd services/remote-relay && go test -race ./...)
```

如根项目脚本名称发生变化，Agent 应使用仓库当时实际存在的等价命令，并在交付说明中记录。推送分支或创建/更新 PR 前，必须遵守仓库说明运行：

```bash
npm run github:preflight
```

## Definition of Done

- 五个实施方案涉及的功能和测试均已落地，没有通过通用 IPC 或通用 shell 绕过策略。
- 唯一管理员可在微信真机完成登录、配对、查看、运行、授权、停止和终端操作。
- 桌面窗口不可见时远程运行仍正确完成、持久化和恢复。
- 云主机重启、网络切换、桌面休眠和重复请求均有明确可验证行为。
- Relay 数据库和日志检查确认没有业务载荷、令牌原文和主机私钥。
- 桌面端有可见状态、断开、撤销和紧急关闭能力。
- 运维、故障排查、秘密轮换和恢复文档齐全。

## Handoff to Coordinating Agent

先分派协议 Agent 完成 M0；同时允许 Relay Agent 只搭建不含协议细节的 Go 目录和测试框架。协议 fixtures 获得确认后，再同时启动 Relay、Desktop 和小程序 Agent。总控 Agent 每次合并只验收一个里程碑，并用本文件的跨端场景做回归，不接受“单端测试通过但端到端未验证”作为完成。

---
title: FreeBuddy WeChat Mini Program Remote Admin - Implementation Plan
type: feat
date: 2026-09-01
topic: remote-admin-wechat-miniprogram
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
repository: freebuddy-monorepo
component: apps/wechat-miniprogram
depends_on:
  - remote-admin-protocol-v1
  - remote-admin-relay-server-poc
  - remote-admin-desktop-read-only
---

# FreeBuddy 微信小程序远程管理员——实施方案

## Goal Capsule

- **目标：** 建立原生 TypeScript 微信小程序，让唯一管理员安全登录、配对 FreeBuddy 主机、浏览数据、发起 Agent 运行、处理授权并使用受约束终端。
- **产品原则：** 面向一个 admin 的操作台，不建设注册、成员、角色、组织和多租户 UI。
- **可靠性原则：** 小程序可随时进入后台/被系统回收；写操作必须依赖幂等键和服务端状态恢复，不能断线后盲目重发。
- **安全原则：** AppSecret 不进入小程序；客户端自报 OpenID/管理员身份无效；生产只连接合法域名上的 HTTPS/WSS。
- **依赖：** 消费 [协议方案](./2026-09-01-002-remote-admin-protocol-plan.md)，先对接 Relay/Desktop 只读 POC，再启用写操作。

## Ownership Boundary

小程序 Agent 主要修改：

```text
apps/wechat-miniprogram/**
```

可只读消费：

```text
protocol/remote/v1/**
packages/protocol/**
```

如果微信构建环境无法直接消费 workspace package，应在小程序构建步骤中生成/复制纯 TS binding，或建立不依赖 Node API 的薄适配层；不能复制一份手工漂移的协议类型。不要修改 Relay、Electron 或协议 schema 来迁就临时 UI。

## Technology and Project Setup

- 原生微信小程序 + TypeScript，优先少依赖，避免一期引入跨端框架。
- 使用 `app.json`、页面分包和微信开发者工具可识别的 project config。
- 在 monorepo 中提供独立脚本用于 typecheck、unit test、build/prepare devtools。
- 根 `package.json` 是否把 `apps/*` 加入 workspaces，由现有包管理方案决定；不要让小程序构建污染桌面 Electron bundle。
- 协议/transport/store 使用纯 TypeScript；微信 API 通过小型 adapter 注入，便于 Node 环境单测。
- 环境配置至少区分 local/dev/prod Relay base URL；生产包禁止可随意切换到明文 WS。

## Information Architecture

一期建议页面：

```text
pages/
├── login/             # 微信登录、非管理员/配置错误提示
├── pairing/           # 扫码/输入短码、确认主机
├── home/              # 单主机状态、运行中任务、待处理决策
├── conversations/     # 会话列表与筛选
├── chat/              # 消息、流式运行、stop、权限卡片
├── tasks/             # 任务/工作流/委托摘要和日志
├── terminal/          # 受约束终端
└── settings/          # 连接状态、注销、撤销/诊断信息
```

一期只有一个主机时，登录后直接进入 home；如果协议已支持多个自有 host，可在 home 顶部提供简单 host selector，不为此引入组织概念。

## Authentication

### Login Flow

1. 页面调用 `wx.login` 获取短时 code。
2. `POST /v1/auth/wechat` 只提交 code 和非敏感设备标签/客户端版本。
3. Relay 调微信服务并校验 `ADMIN_OPENID`。
4. 成功后保存 opaque access/refresh token 及到期时间；不保存 `session_key`，也不要求客户端知道 OpenID。
5. access token 到期前按策略刷新；refresh rotation 成功后原子替换两个 token。
6. 收到 revoked/replay/forbidden 时清理本地 session，回到 login。

### Local Token Handling

- 使用 `wx.setStorageSync`/等价 API 保存会话；封装单一 `tokenStore`，业务页面不直接读取。
- 日志、埋点、错误上报、UI toast 不输出 token/login code。
- 提供显式 logout，先尽力调用服务端撤销，再清理本地状态；网络失败也必须清理本地。
- 小程序存储不等同硬件安全区，因此令牌 TTL 和服务端撤销能力是主要保护；不在客户端自制可逆“加密”。

## Transport Architecture

建议核心服务：

```text
src/services/
├── authClient.ts
├── tokenStore.ts
├── relaySocket.ts
├── rpcClient.ts
├── resumeManager.ts
└── protocolAdapter.ts

src/stores/
├── connectionStore.ts
├── hostStore.ts
├── conversationStore.ts
├── runStore.ts
├── decisionStore.ts
└── terminalStore.ts
```

### Singleton RelaySocket

- App 级单例管理唯一 socket，页面不能各自 `wx.connectSocket`。
- 状态至少包含 `signedOut/connecting/authenticating/online/backoff/offline/forbidden/incompatible`。
- `App.onShow` 触发有界重连和 resume；`onHide` 不假定 socket 继续存活。
- 指数退避 + jitter，认证/版本错误停止自动快速重试。
- 发送队列必须有界；未认证时不接受业务写请求。
- frame 大小、JSON parse、协议版本和消息方向均校验；未知业务事件可记录安全诊断并忽略，未知主版本必须停止。
- 网络状态变化通过微信 API 触发重新评估，但避免多个重连定时器并发。

### RpcClient

- 生成稳定 request ID，维护有界 pending map 和 timeout。
- 只提供 typed method wrappers，不提供 `call(method: string, any)` 给页面直接使用。
- 所有写 wrapper 在用户确认动作时创建 idempotency key，并把该 key 与本地 optimistic/pending state 绑定。
- socket 断开时：只读请求可在重连后重新读取；写请求进入 `unknown` 状态，先 resume/snapshot/按资源查询结果，不能自动换 key 重发。
- 收到 response 后先关联 request/host，再更新 store；晚到 response 不能覆盖新的状态。
- 错误码映射为可操作提示：登录、主机离线、请求过期、冲突、超时、版本不兼容、背压。

### ResumeManager

- 每个 host 持久记录最后完整应用的 `lastSeq`。
- 重新认证后先发送 resume，再允许依赖实时状态的写操作。
- event 必须严格按 seq 应用；重复 seq 幂等忽略，出现 gap 立即请求 snapshot。
- 收到 snapshot 时原子替换服务端权威实体和 `baseSeq`，再继续事件流。
- 页面卸载不影响 resume state；store 生命周期归 App，而非单页。

## Data Stores and UI State

- 服务端/desktop host 是权威；小程序 store 是可重建缓存。
- 每个实体保留 `updatedAt/version` 或协议提供的等价字段，防止旧响应覆盖新事件。
- 列表使用 cursor，不一次拉取全部消息/日志。
- 运行状态独立于聊天页面：用户离开 chat 后 run 仍能在 home 显示并继续接收事件。
- pending permission/authentication 是全局队列，home 提醒，chat 中展示上下文。
- optimistic update 只用于低风险 UI；delete/stop/decision 等以服务端确认作为最终状态。

## Conversation and Streaming UI

### Message Rendering

支持协议 v1 的公共流 item 子集：

- 文本增量和最终文本。
- thinking 默认折叠，仅显示状态/摘要。
- tool call / tool result 卡片。
- command 与有界 output。
- file edit 摘要（路径、操作、diff 摘要；不默认展示超大完整 diff）。
- usage、warning、error、done。
- permission/authentication request 卡片。

必须对 Markdown/富文本做安全渲染：不执行任意 HTML/JS，不自动打开未知 scheme，超长内容折叠或分页。复制和打开路径只作为信息展示，不能让小程序假装本地文件可直接访问。

### Send Flow

1. 用户选择已有 conversation 或创建新 conversation。
2. 输入文本并明确点击发送。
3. 生成本地 pending operation + idempotency key，调用 `conversation.send`。
4. 收到 run/message 事件后，用服务端 ID 替换 pending 状态。
5. 流式 item 按 run/seq 累积；离开页面仍继续。
6. stop 使用独立幂等写请求。
7. 断线时把未确认发送标记“状态确认中”，重连后从 snapshot/run/message 状态判定；不自动再次发送。

### Decisions

- Permission/authentication 卡片显示来源 Agent、项目/会话、请求摘要和允许的选择。
- 高风险决策要求明确点击，不使用默认倒计时自动批准。
- 响应按钮提交后进入 pending，防双击；重复事件按 decision ID 合并。
- 已在桌面端/其他连接处理的决策显示“已处理”，不能再提交。
- UI 不显示 Relay/desktop 未提供的额外权限承诺。

## Tasks, Workflows, and Delegation

- home 显示 active/failed/needs-attention 摘要。
- tasks 页面用 cursor 读取日志，增量事件只追加有界窗口。
- start/stop 动作只针对协议注册的方法，不提供任意命令字段。
- 展示 desktop 返回的状态机，不在小程序自行推断已完成。
- 一期不做复杂工作流编辑器；只查看和执行 FreeBuddy 已存在的允许动作。

## Terminal UX

### Phase 1 Scope

- 从明确项目中创建 terminal，页面显示项目名和远程控制警示。
- 纯文本/有限 ANSI 渲染；不因追求完整 xterm 而阻塞一期。
- 提供单行输入、发送、Ctrl+C/Ctrl+D/Tab/方向键等明确快捷按钮。
- 页面尺寸变化发送合理 rows/cols；输入法弹出时避免 resize 抖动。
- terminal output 以 seq 应用，支持截断提示和 snapshot 恢复。
- 离开页面不自动关闭，但 home/settings 显示 active session；用户可明确关闭。
- App logout、解除配对、desktop 紧急关闭后，终端 UI 立即失效。

### Deferred

- 基于 WebView 的完整 xterm.js、复杂 ANSI、鼠标模式、文件上传下载、多 tab 高级终端。
- 这些能力需单独安全/兼容方案，不能隐藏在一期 PR 中。

## Pairing UX

- 已登录管理员可以用 `wx.scanCode` 扫桌面二维码，也可输入短码+secret（具体由协议决定）。
- 扫码内容必须校验 scheme/version/长度，只把 pairing ID/secret 发送到已配置 Relay。
- 确认页显示主机名称和配对到期时间，不接受二维码指定任意 Relay endpoint 覆盖生产配置。
- claim 成功后清理扫码载荷并进入 host home。
- 过期、已领取、非管理员、网络失败都有明确重试路径，但不在 UI 回显 secret。

## Production WeChat Requirements

- 在微信公众平台配置 request 合法域名和 socket 合法域名，均为已备案 HTTPS/WSS 域名。
- 真机验证 TLS 证书链；不依赖开发者工具“不校验合法域名”选项。
- 配置隐私保护说明，说明微信标识、设备会话、主机配对和远程操作用途。
- 不申请与一期无关的用户信息、定位、通讯录等权限。
- AppID 放公开构建配置可接受；AppSecret 只在 Relay。
- release 包关闭 debug 日志、mock auth、自定义明文 endpoint 和测试管理员入口。

## Suggested Project Layout

```text
apps/wechat-miniprogram/
├── miniprogram/
│   ├── app.ts
│   ├── app.json
│   ├── app.wxss
│   ├── pages/
│   ├── components/
│   ├── services/
│   ├── stores/
│   ├── protocol/
│   └── utils/
├── tests/
├── typings/
├── project.config.json
├── tsconfig.json
├── package.json
└── README.md
```

不要提交开发者个人路径、private project config、secret 或真实 token。`project.private.config.json` 按微信工具约定忽略。

## Implementation Units

### W1：项目脚手架和纯 TS 基础层

- 建立 native TS 项目、环境配置、typecheck/test/build 脚本。
- 接入协议类型/fixtures，建立微信 API adapter。
- 添加登录占位和基础错误边界。

### W2：Auth + Transport POC

- 实现 wx.login、token store/refresh/logout。
- 实现 singleton RelaySocket、admin.auth、心跳、backoff。
- 用 Relay dev/真实 auth POC 显示连接和 host status。

### W3：Resume + Read-only Stores

- 实现 seq、resume、snapshot、gap 检测和本地游标。
- 实现 project/agent/conversation/message/task 读取和分页。
- 完成 home/conversations/chat read-only 页面。

### W4：Pairing

- 扫码/短码、校验、确认和 claim。
- 完成过期/重复/错误提示，不泄漏 secret。

### W5：Conversation Write + Streaming

- 实现 typed write wrappers、idempotency 和 unknown-outcome 状态。
- 实现 send/stop、stream item 渲染和后台继续更新。
- 实现 permission/authentication decision cards。

### W6：Tasks/Workflow/Delegation

- 查看摘要/日志，执行协议允许的 start/stop 动作。
- 对主机离线、冲突和已处理状态做明确 UI。

### W7：Terminal

- project-scoped create、input、resize、snapshot、close。
- 有界输出、截断提示、快捷键和 active session 管理。

### W8：真机、弱网和发布加固

- 合法域名、TLS、前后台/切网/进程回收、版本升级测试。
- debug/mock/secret 检查、隐私说明和发布 checklist。

## Test Plan

### Pure TypeScript Unit Tests

- protocol valid/invalid fixtures。
- RelaySocket 状态机、单重连 timer、退避、auth/forbidden/incompatible。
- RpcClient request correlation、timeout、late response、pending limit。
- 写请求 idempotency key 生命周期和断线 unknown 状态。
- resume：正常重放、重复 seq、gap、snapshot replacement。
- stores：旧响应不覆盖新 event、分页合并、run 跨页面存活。
- token rotation 原子替换，logout 始终清本地。

### Component/Page Tests

- login/非管理员/主机离线/版本错误状态。
- 会话流 item 的每种类型和超长内容折叠。
- decision 防双击、已在别处处理。
- terminal output 截断、快捷键、关闭确认。
- pairing QR 非法 scheme、过期、已领取。

### DevTools and Real Device Scenarios

- 冷启动登录、前后台切换、锁屏恢复。
- Wi-Fi ↔ 蜂窝切换、短断网、长断网、Relay 重启。
- run 中关闭 chat 页面和小程序，再打开后恢复。
- 发送响应未知时恢复，不重复创建消息/运行。
- desktop 退出/休眠/重连和解除配对。
- 大量 stream/terminal output 下页面仍可操作，内存有界。
- 真机 WSS 合法域名和证书验证。

## Acceptance Criteria

- 只有 Relay 确认的 `ADMIN_OPENID` 能进入；客户端无法伪造管理员身份。
- 登录后能查看主机在线状态、会话、消息、任务和 pending decisions。
- 可发送消息、接收流式输出、停止 run、响应权限/认证，并在后台/断线后恢复。
- 写请求断线后不会盲重试导致重复消息或重复任务。
- 能完成一次性扫码配对，二维码不能覆盖生产 Relay 地址。
- 终端绑定显式项目、有界输出、可关闭，desktop 紧急撤销后立即失效。
- release 构建不含 AppSecret、真实 token、mock auth 或忽略域名/TLS 的配置。

## Handoff Prompt

> 你负责 `apps/wechat-miniprogram` 原生 TypeScript 小程序。先读取总控和协议方案，先实现纯 TS 的 auth/transport/resume/store，再做页面。页面只能调用 typed RPC wrapper，不能自行传任意 method/channel。所有写操作绑定 idempotency key；断线后的未知结果必须先 resume/snapshot 确认，禁止盲目重发。AppSecret 永远不进小程序，生产只用备案 HTTPS/WSS 合法域名。交付时附协议 fixtures、状态机、断线恢复和真机 WSS 测试结果，并明确哪些终端 ANSI 能力被延期。

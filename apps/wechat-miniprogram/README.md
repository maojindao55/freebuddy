# FreeBuddy 远程管理员 · 微信小程序

原生 TypeScript 微信小程序，属于总控方案
[`docs/plans/2026-09-01-001-remote-admin-control-master-plan.md`](../../../docs/plans/2026-09-01-001-remote-admin-control-master-plan.md)
的 M4 方向（[小程序实施方案](../../../docs/plans/2026-09-01-005-remote-admin-wechat-miniprogram-plan.md)
的 W1/W2/W3 纯 TS 基础层 + 只读页面单元）。

**当前是只读阶段**：不发送消息、不停止运行、不响应决策、不开终端、不做真实微信登录。
它消费已冻结的 `protocol/remote/v1`，可以连本机 DEV Relay 读取主机快照、会话与消息。

## 当前范围（W1 + W2 transport + W3 resume/stores + W3 页面单元，仍为只读）

W1 已实现（脚手架与环境）：

- 微信开发者工具可识别的工程配置：`project.config.json`（`miniprogramRoot`、`useCompilerPlugins: typescript`、`urlCheck: true`）、`app.json`、`app.wxss`、`app.ts`。
- 环境配置与安全约束：`local` / `dev` / `prod` 三套命名环境，按 `wx.getAccountInfoSync().miniProgram.envVersion` 选择。
- 可注入的微信 API adapter：`login` / 存储 / `request` / `connectSocket` / 网络状态 / 客户端信息的薄层封装。
- App 级错误边界：统一处理 `onError`、`onUnhandledRejection`、`onPageNotFound`，输出前强制脱敏与截断。
- 登录占位视图：只展示状态，不调用 `wx.login`、不交换 code、不写存储、不持有令牌
  （`services/loginPlaceholder.ts`；连接页在 W3 第二单元把它扩展为同时渲染 DEV 入口）。
- Node 单测环境：`typecheck` / `test` / `emit:check` / `prepare:devtools` 脚本，覆盖配置约束、
  adapter、错误边界、占位页和协议 fixture。

W2 纯 TS transport 已实现并单测覆盖（**没有新增 page**）：

- `utils/scheduler.ts`：定时器 seam，使重连/心跳在单测中确定性可观测。
- `services/relaySocket.ts`：App 级**单例** socket，状态机
  `signedOut → connecting → authenticating → online`，另有 `backoff / offline / forbidden /
  incompatible`；generation guard 忽略旧 socket 回调、单重连定时器、指数退避 + jitter、
  认证失败停止自动重试、一次性 ping nonce 心跳、前后台与网络变化的边界处理。
- `protocol/frameRules.ts`：入站准入管道（帧上限 → JSON → schema → 方向 → 是否 pre-auth →
  主机身份），任何「不是发给 admin」的帧、错 host 的帧、未知方法都在进入 store 前被丢弃计数。
- `services/rpcClient.ts`：有界 pending map、`requestId` 关联（不用 seq）、按方法规格的超时、
  晚到响应记为 late 且不再应用、写方法与未注册方法在生成帧之前被拒绝。
- `services/adminConnection.ts`：App 级组合层——transport 掉线时立即以 `unknownOutcome`
  结束所有 pending 请求，并持有仅内存的操作令牌与显式 `hostId`。
- `config/devAccess.ts` + `services/adminSession.ts`：本地 DEV 直连闸门（仅 `local` 环境、
  仅字面 loopback 端点、仅 `develop`/`trial`、需显式开启），令牌只在内存，不写 WeChat 存储、
  不进 UI、不进日志。

W2 明确未做：

- **没有** `wx.login` / `code2Session` / 服务端颁发的 admin 会话：Relay 当前没有
  `POST /v1/auth/wechat`，因此不存在微信派生凭证；DEV 令牌是 Relay 的操作令牌，
  **不是管理员登录**，UI 必须照实标注。
- 没有 host 发现：Relay 没有 `/v1/hosts`，`hostId` 只能显式配置到 claim 结果产出为止。

W3 第一单元（resume + stores 接线，**仍然没有新增 page**）：

- `services/resumeManager.ts`：按 host 记录「最后完整应用」的 `lastSeq` 与快照基线 `baseSeq`。
  重复 seq 幂等忽略且不移动游标；缺口（seq > lastSeq + 1）立即停流并请求快照；
  seq 落到快照基线之前视为主机序号回退，同样请求快照；快照原子替换 `baseSeq`。
- **游标必须与可重建状态一致**：只有实体缓存还在（`materialized`）时 `resumeFrom` 才返回游标，
  因此冷启动、缓存被丢弃、切换主机之后都走完整 `sync.snapshot`，不会出现「只有游标没有实体
  却跳过初始快照」。持久化只写 `{hostId → {baseSeq, lastSeq}}`（`services/resumeCursorStorage.ts`），
  读入时按白名单清洗，不存任何实体、内容或令牌。
- `services/adminState.ts`：唯一的「线上数据意味着什么」决策点——`auth.ok` 后 resume 或取快照、
  事件按 seq 闸门放行、快照（帧与 RPC 两条入口）走同一条替换路径、有界分页读取。
  接受快照、切换主机与注销都会推进一个 generation 计数，因此「新快照帧 vs 在途
  `sync.snapshot`」「快照 vs 在途分页」「注销 vs 在途快照/分页」三类竞态里，被取代的一方
  一律丢弃，不会把已经作废的实体或游标写回缓存。
- `stores/*`（connection/host/conversation/message）接入并单测：快照整体替换、事件按
  `updatedAt`/`createdAt` 合并、分页 `fetchSeq` 与主机切换的双重丢弃、
  实体字段白名单（`stores/entityFields.ts`）不缓存未知字段与 token 形字段。
- `adminConnection` 只做接线：`auth.ok` / 事件 / 快照交给 `adminState`，`setHostId` 触发换主机
  清缓存与重建基线，前后台与关闭时 flush 游标，注销清空缓存、游标与持久化。

W3 第二单元（home / conversations / chat 只读页面 + App 单例接线）：

- `platform/pageRuntime.ts`：页面/导航 seam（`navigateTo` / `navigateBack` / `reLaunch` /
  标题 / toast / confirm / 停止下拉）。页面控制器因此可在 Node 里用记录型 double 单测，
  且**没有**「打开任意 URL」这类方法。
- `services/appSession.ts`：App 级单例——**唯一** `AdminConnection`（一个 socket、一个 RPC
  client、一个 resume manager）+ **唯一**网络状态监听（`start()` 幂等，`dispose()` 释放）。
  `app.ts` 在 `onLaunch` 注册监听、`onShow` 触发前台重连、`onHide` 先落游标再挂起。
- `services/devConnect.ts`：本地 DEV 直连的唯一入口与闸门。端点只来自环境表（local =
  `ws://127.0.0.1:8080`）并复用 `config/devAccess.ts` 的字面回路断言；令牌只进内存、
  不写存储、不进日志、不进页面数据（页面只见到固定掩码）；`signOut()` 同时清空令牌、
  主机标识、实体缓存与持久化游标。接口里**没有** `setEndpoint`，也没有任何主机发现调用。
- `services/pageViews.ts`：纯视图构建器——连接横幅（online/connecting/authenticating/backoff/
  offline/signedOut/forbidden/incompatible）、home/conversations/chat 三种视图、以及
  `renderMessageText`（纯文本：去控制字符、保留换行、限长 4000；不解析 HTML/Markdown/scheme）。
  `ChatView.canSend` 是字面量 `false`，类型层面就不存在发送口。
- `pages/index`（连接页）、`pages/home`、`pages/conversations`、`pages/chat`：每页一个
  controller（`pages/*/controller.ts`，纯逻辑、可单测）+ 一个极薄 `.ts` 适配 `Page({...})` 与
  `setData`。`onShow` 订阅、`onHide`/`onUnload` 退订；退订后任何晚到响应都不会写页面
  （缓存仍由 App 更新，因此重新进入代价很低）。
- 分页有界：会话 50/页、消息 50/页，store 上限 200（会话）与 200/线程 × 12 线程；离线、
  在途、`hasMore=false` 时 `loadMore` 直接拒绝。
- `adminConnection` 增加一处接线：把 socket 状态镜像进 `stores.connection`，页面只订阅一个
  连接状态源（状态/原因/limits + resync/诊断）。

W3 明确未做：

- **没有写方法**：不提供 `conversation.send` / `run.stop` / 决策响应 / 终端；chat 页面没有
  输入框、发送或停止按钮。
- **没有真实微信登录**：不调用 `wx.login`、不交换 code、不存服务端会话；连接页的微信按钮
  永久禁用，DEV 直连在页面上明确标注「不是微信管理员登录」。
- 增量 `run.*`、`permission.*`、`task.*`、`workflow.*`、`delegation.*`、`terminal.*` 实体尚无
  对应 store，快照会接收它们的数组但增量事件只记录为「已忽略」，等 W5–W7 各自的 store 落地。
- home 的待处理决策只做只读展示，没有响应按钮。

明确未实现（后续单元）：

- 配对扫码、会话流、任务、终端、业务页面（W4–W7）。
- 合法域名、TLS、隐私说明、真机与弱网回归、发布加固（W8）。

## 目录结构

```text
apps/wechat-miniprogram/
├── miniprogram/                 # miniprogramRoot，开发者工具只识别这里
│   ├── app.ts / app.json / app.wxss
│   ├── config/                  # 环境表与环境解析
│   ├── platform/                # wx adapter / 页面导航 seam 与注入点
│   ├── protocol/                # 协议消费入口（生成文件在此目录）
│   ├── services/                # 与页面解耦的纯逻辑（transport / RPC / 组合层 / 视图模型）
│   ├── stores/                  # 可重建缓存（W3 已接入并有单测）
│   ├── utils/                   # 错误边界、脱敏、定时器 seam、展示 helper
│   └── pages/                   # index（连接页）/ home / conversations / chat（只读）
│       └── <page>/              # <page>.ts 只是适配层，逻辑在同目录 controller.ts
├── tests/                       # Node 单测（永不进入小程序包）
│   └── helpers/                 # fake wx api / fake wx host / fake page runtime / 假 socket
├── scripts/                     # 协议同步、测试运行、emit 校验与开发者工具入口
├── project.config.json
├── tsconfig.json / tsconfig.test.json / tsconfig.emit.json
└── README.md
```

## 脚本与「构建」的确切含义

```bash
cd apps/wechat-miniprogram
npm install               # typescript / miniprogram-api-typings / @types/node；自动执行 prepare
npm run sync:protocol     # 由 packages/protocol/src/remote.ts 生成协议绑定
npm run typecheck         # tsc -p tsconfig.json --noEmit
npm test                  # 编译到 .tmp-test/ 后 node --test
npm run emit:check        # 真正把 miniprogram/** 输出成 JS 到 .tmp-js/，校验后删除
npm run prepare:devtools  # sync:protocol + 校验 app.json 声明的页面文件齐全 + typecheck
npm run devtools          # 用微信开发者工具 CLI 打开本目录
npm run build             # sync:protocol + typecheck + emit:check + test
```

**`npm run build` 不是小程序产物。** 它保证协议一致性、类型、JS 可输出性与单测；
真正被打包/预览/上传的 JS 由微信开发者工具的 `typescript` 编译插件生成。
`emit:check` 是两者之间的桥：它把同一批 `miniprogram/**` 源码 emit 到 `.tmp-js/`，
断言 `app.js` 注册了 `App(`、四个页面各自注册了 `Page(`，并断言 emit 出的每个相对 `require` 都指向
**显式文件**（按微信加载器只追加 `.js`、不做目录 `index` 回退的规则严格解析，因此
`import ... from "./protocol"` 这类目录导入会在这里失败），然后**删除**输出。
因此 `miniprogramRoot` 内永远不会出现手工构建的陈旧 JS。

首次克隆必须先 `npm run prepare:devtools`（或 `npm install`）：协议绑定
`miniprogram/protocol/remote.generated.ts` 是 git-ignored 的生成文件，缺失时开发者工具无法编译。

### 在微信开发者工具中打开

```bash
npm run prepare:devtools
npm run devtools          # 等价于 cli open --project <本目录>
```

`scripts/open-devtools.mjs` 依次寻找 `WECHAT_DEVTOOLS_CLI` 环境变量、macOS 的
`/Applications/wechatwebdevtools.app/Contents/MacOS/cli`、以及 Windows 的两个常见路径；
找不到时**不会**伪造成功，而是打印手动导入路径后以非 0 退出。

已知前置条件（未满足时命令行不会成功）：

1. 开发者工具需开启「设置 → 安全设置 → 服务端口」。CLI 会提示 `Enable IDE Service (y/N)`，
   是否开启由操作者决定，本仓库不会代为修改该安全设置。
2. `project.config.json` 的 `appid` 已由协调者填入用户授权的真实小程序 AppID
   `wx8bef453ebd05bdd5`（AppSecret 只在 Relay，永远不进小程序），因此工程可导入、可编译。
   `preview` / `upload` 属于 W8 的范围（合法域名、登录、发布加固），本轮不做。


## 协议消费方式

`protocol/remote/v1` 是唯一的跨端 wire 权威，`packages/protocol/src/remote.ts` 是它的 TS 绑定。
小程序**不复制、不发明任何 wire 字段**，也不自建第二套 schema。

1. `scripts/sync-protocol.mjs` 把 `packages/protocol/src/remote.ts` 复制为
   `miniprogram/protocol/remote.generated.ts`。微信开发者工具解析不了 `miniprogramRoot` 之外的
   包，因此「生成副本」就是协议负责人确认的官方消费方式，不会再有小程序专用入口。
2. 生成文件头部是**冻结的四行模板**（authority 与 regenerate 必须分行），sha256 始终针对
   `packages/protocol/src/remote.ts` 的 UTF-8 字节，而不是生成文件本身：

   ```text
   // GENERATED FILE - DO NOT EDIT.
   // Source: packages/protocol/src/remote.ts (sha256 <hex>)
   // Wire authority: protocol/remote/v1
   // Regenerate with: npm run sync:protocol
   ```

3. 生成文件被 `.gitignore` 忽略，只能通过脚本重新生成；脚本会拒绝带 import / require 的源文件，
   保证副本自包含，并断言头部恰为四行。
4. 业务代码只从 `miniprogram/protocol/index.ts` 导入，且**必须写成 `./protocol/index`，不能写成
   `./protocol`**：微信加载器只给相对路径追加 `.js`，不会像 Node 那样把目录回退到 `index.js`；
   写成 `./protocol` 会 emit 出 `require("./protocol")`，启动即报
   `module 'protocol.js' is not defined`。`npm run emit:check` 会拦住这类目录导入。
   该模块只做两件事：`export *` 转发绑定，
   以及 `assertProtocolBinding()`（版本 + 禁用方法校验，App 启动时调用）。
5. 升级协议时：协议负责人改 `protocol/remote/v1` 与 `packages/protocol`，小程序只重跑
   `npm run sync:protocol` 并修类型错误，不手工改生成文件。

**字节上限由传输层负责**（`parseRemoteFrame` 接收的是已解析对象，不检查大小）。绑定已导出官方助手，
直接消费，不要自己实现：

- `exceedsFrameLimit(rawFrame)`：W2 在 `JSON.parse` 之前校验原始 WebSocket 文本帧
  （`MAX_FRAME_BYTES` = 256 KiB）。
- `exceedsChunkLimit(text)` / `utf8ByteLength(text)`：约束 `ChunkText` 的 UTF-8 字节
  （`MAX_CHUNK_BYTES` = 32 KiB），适用于 `run.stream` 的 text / thinking / tool-result /
  command-output 的 `content`、`file-edit.patch`、`terminal.{output,input,snapshot}` 的
  data / output，以及 `MessageSummary.content`、`TaskLogItem.text`。
- 更短上限：`inputPreview` 4096、`command` 4096、`path` 1024、`error.message` 512。
- `conversation.send.content`、`delegation.start.prompt` 同为 32768，但属于一次性 RPC：超限应返回
  `invalid_request`，**不要**当流分片处理。

**W2 typed RPC 约定**（协议负责人确认）：

- 白名单与方法元数据：`REMOTE_METHODS`、`isRemoteMethod`、`isForbiddenMethod`、`getMethodSpec`、
  `REMOTE_METHOD_SPECS`（含读写 / 超时 / 幂等要求）。
- 类型：`RemoteMethodParamsMap`、`RemoteMethodResultMap`。
- 页面不得暴露 `call(method, any)`；主机执行前按 `protocol/remote/v1` 的 JSON Schema 校验 params。
- v1 不会导出 `parseRemoteMethodParams` / `parseRemoteMethodResult`（Ajv 不能进无 import 的绑定），
  因此小程序不自造运行时 params 校验。

**一次性配对 HTTP 约定**（协议负责人新增，W4 实现时消费）：

- 绑定已导出 `HTTP_BODY_KINDS`、`HttpBodyMap`、`parseHttpBody(kind, body)`、
  `PairingStartRequest/Response`、`PairingClaimRequest/Response` 类型和四个 `parsePairing*`
  快捷函数；小程序不自建 HTTP 请求/响应类型，也不自选正则校验 secret。
- 高熵 secret 规则由绑定决定：`PAIRING_SECRET_MIN_BYTES` = 32（base64url 至少 43 字符），
  展示用的 `displayCode` 永远不能当凭证提交（fixture `pairing-claim-code-only.json` 已冻结）。
- 二维码只承载 `freebuddy-remote://pair/v1?pairingId=…&secret=…`：`buildPairingQrPayload` /
  `parsePairingQrPayload` 是唯一入口，正则锚定，附加 `relay=` 或换成 http(s) scheme 一律解析
  失败，因此二维码无法覆盖生产 Relay 地址（与下面的环境覆盖白名单互为双保险）。
- `PairingStartRequest` 属于桌面端→Relay 的主机侧请求；小程序只消费 `PairingClaim*` 与
  `PairingStartResponse`（确认页展示主机与到期时间）。
- `buildPairingStartCanonicalPayload` 与签名 canonical 属于桌面端和 Relay，小程序不调用。

`tests/protocol-fixtures.test.ts` 直接用 `protocol/remote/v1/fixtures` 验证绑定与冻结 fixture
一致；`oversized-chunk.json` 这类字节上限 fixture 由传输层（W2）用
`MAX_FRAME_BYTES` / `MAX_CHUNK_BYTES` 在解析前拦截。

## 环境与安全约束

| 环境 | 选择方式 | HTTP | WS | 调试日志 |
| --- | --- | --- | --- | --- |
| `prod` | `release` 版本固定 | `https` | `wss` | 关闭 |
| `dev` | `develop` / `trial` 默认 | `https` | `wss` | 开启 |
| `local` | 仅 `develop` / `trial` 下显式覆盖 | `http` | `ws` | 开启 |

强制约束（由 `config/runtimeConfig.ts` 在启动时断言，并有单测覆盖）：

- 发布版本永远解析为 `prod`，且**忽略一切覆盖**；覆盖只能在 `develop` / `trial` 下生效。
- 覆盖只能在三套命名环境间切换，不接受任意 URL，因此二维码、深链、存储值都无法把发布包
  指向别的主机。
- `prod` 必须为 `https` / `wss`、禁止 `allowInsecureTransport`、禁止调试日志。
- 端点必须是 `<scheme>://<host>`，禁止用户信息、路径、查询串和 fragment。
- 环境表禁止出现 secret / token / password / session_key 一类字段；AppSecret 只在 Relay。
- `local` 的明文传输只在 `develop` / `trial` 可达。

存储覆盖键：`freebuddy.environment.override`（仅用于本地与 dev 调试）。

## 本地 DEV 直连入口（唯一的取凭证方式）

Relay 没有 `POST /v1/auth/wechat`，所以**不存在**微信派生的管理员凭证。当前唯一可用的凭证是
Relay 自己的 DEV 操作令牌。为了不让这件事被误当成登录，入口被限制得很窄（`config/devAccess.ts` +
`services/devConnect.ts`，两层都断言，逐条有单测）：

- 只在 `local` 命名环境 + `develop` / `trial` 构建出现；`release` 构建既不渲染入口，也不接受令牌，
  更不会建连。
- 端点不是输入项：取自环境表（`local` = `ws://127.0.0.1:8080`），并再次断言是**字面回路地址**
  （`127.0.0.1` / `[::1]`）。接口里没有 `setEndpoint`，页面也无法把连接指向别处。
- 令牌只进内存（`services/adminSession.ts`），不写 `wx.setStorageSync`、不进日志、不进页面数据；
  页面只渲染固定掩码 `••••••••`。输入框是 `password`，提交后立即清空。
- `hostId` 由操作员显式填写，因为 Relay 没有主机发现接口；`config/hostTarget.ts` 明确列出缺口，
  不臆造 `/v1/hosts`，也不发任何 HTTP 发现请求（有单测断言 fake `wx` 的 `request` 零调用）。
- 断开/退出会清空令牌、主机标识、实体缓存与持久化游标，并回到需要重新 `arm` 的状态。

生产构建排除 DEV 入口这一点是**构建期**属性：`devConnect` 的 `available` 对 `release` 恒为
`false`，`setToken` 直接拒绝，`connect()` 不触碰 transport。

## 微信开发者工具

1. 推荐用 CLI 打开（可复现）：`npm run prepare:devtools && npm run devtools`；
   也可手动「导入项目」打开 `apps/wechat-miniprogram`（即 `project.config.json` 所在目录）。
2. CLI 需要开发者工具开启「设置 → 安全设置 → 服务端口」；未开启时 CLI 会交互式询问是否开启，
   本仓库不代为修改该设置，会在 README/交付说明中如实记录。
3. `appid` 已是用户授权的真实小程序 AppID `wx8bef453ebd05bdd5`（由协调者写入 `project.config.json`）；
   AppSecret 只在 Relay 环境变量中，永不进小程序包。
4. `setting.urlCheck` 保持 `true`，不要依赖「不校验合法域名」。
5. `project.private.config.json` 属于个人配置，已在 `.gitignore` 中忽略。
6. TODO（W8）：在微信公众平台配置 request / socket 合法域名，并把 `config/environments.ts` 中
   `dev`、`prod` 的示例主机名替换为已备案域名。


## 本机运行与联调现状（2026-09-16 实测）

本节只记录**当场跑过**的事实与仍然阻塞的项；没有跑过的不会写成功。

**Relay（本机可用，已启动）**

```bash
sh services/remote-relay/scripts/local-dev.sh start    # 后台启动，绑定 127.0.0.1:8080
sh services/remote-relay/scripts/local-dev.sh status   # PID + /readyz 探针
sh services/remote-relay/scripts/local-dev.sh smoke    # 真实 WSS/RPC/1000 事件自检
sh services/remote-relay/scripts/local-dev.sh stop     # SIGTERM 优雅停止（校验 PID 身份后才发信号）
```

- 进程/文件归属：二进制 `services/remote-relay/.local/relay`，PID 文件 `.local/relay.pid`，
  日志 `.local/relay.log`，SQLite `.local/relay.db`（均在 git-ignored 的 `.local/`，权限 600/700）。
- 实测结果：`/healthz` 与 `/readyz` 返回 Relay 自身 JSON（`database: ok`），
  `smoke` 输出 `relay smoke passed: health=ok ready=ready rpc=1 events=1000`。
- **8080 端口共存**：本机另一个 nginx 以 `*:8080` 监听，但 Relay 绑定的是更具体的
  `127.0.0.1:8080`，loobpack 流量由 Relay 接管（实测 `/readyz` 返回 Relay JSON 而不是 nginx 404），
  因此**不需要**停掉 nginx，也不需要改 `config/environments.ts` 里的 local 端口。
- `stop` 只按 PID 文件里的 (PID, LSTART, BIN) 身份校验后发 SIGTERM，不会误杀 nginx 等无关进程。

**Desktop（隔离入口已由 Host 补齐；读数据仍被 Desktop 侧缺口挡住）**

Host 已新增 `npm run dev:readonly-remote`（`scripts/dev-readonly-remote-electron.mjs`）作为**产品形态**的
只读远程主机入口，不再需要手工拼环境变量。它从 `services/remote-relay/.local/dev.env` 读取
`DEV_AUTH_HOST_ID` / `DEV_AUTH_HOST_TOKEN` 与 `LISTEN_ADDR`（令牌只进子进程 env，不打印），
校验 Relay PID 身份后启动 Electron，并把 `userData` 隔离到
`.local/readonly-remote-desktop-user-data`（`electron/main.ts` 只在 `FB_REMOTE_READONLY_DEV=1` 且非打包时启用），
因此不会与另一工作副本（`/Users/hongbin9/www/freebuddy-main`）共用户数据或单实例锁，也不需要占用 5173。

2026-09-16 21:00–21:12 实测（本机）：

- 该入口启动成功（Electron PID 1647，`build/electron-dev/FreeBuddy.app` + `dist-electron/main.js`），
  Relay 审计日志出现 `host_connect` / `auth_success`（`host_dev`）。
- **Relay 的 ping-误判-spoofing 修复在真实进程上得到验证**：Relay 重启（PID 93608，20:55:27）之后
  `host attempted to send frame with spoofed hostId` 计数为 **0**，主机连续在线 11 分钟以上无重连。
  修复前同一主机每 **30.0 秒**被判 spoofing 断连一次（`duration≈30007xxxxx ns`），这正是心跳周期。
- 隔离 DB（`.local/readonly-remote-desktop-user-data/freebuddy/freebuddy.db`）确为空工作区：
  `conversations`/`conversation_messages`/`projects`/`cli_tasks`/`workflow_runs`/`delegation_events` 均为 0 行
  （只有内置 `skills` 6 行），符合「不含用户另一副本会话」。

**仍然阻塞（Desktop 侧，已回报 Host，小程序不越权修改）**

小程序用生产 `createAppSession` 连上后，所有读 RPC 都被 Desktop 拒绝：

```text
host.status → internal_error: "Local owner administrator is unavailable"
conversation.list → rpc_error（页面显示「主机内部错误」）
resume 基线 sync.snapshot 未 materialize
```

根因：`electron/remote/adminDispatcher.ts:22` 在每次请求前调用 `getOwnerUser()`
（`electron/cli/users.ts:85`，`SELECT ... FROM remote_users WHERE is_owner = 1`），
而隔离 DB 的 `remote_users` 为 0 行且 `app_settings['remote.password']` 不存在，
因此 `bootstrapOwnerFromLegacyPassword()` 也不会创建 owner → 请求在到达 `SnapshotService` 之前就被拒。
即：**传输层通了，数据层因为「本地 owner 管理员不存在」整体不可用**。
需要 Desktop 负责人在隔离只读实例下提供/引导 owner（或让 dispatcher 对空 DB 有明确降级），
这属于 `electron/remote/` 范围。

**小程序**

- `npm run prepare:devtools`：实测通过（协议绑定生成 + 页面文件齐全 + typecheck，
  4 个页面 `pages/index|home|conversations|chat`）。
- 生产 `createAppSession` 对真实 Relay 实测（2026-09-16 21:09–21:11，探针在 `/tmp`，不落仓库）：
  `setHostId`/`setToken`/`connect` 均受理，状态 `online`、`violations=0`、
  limits `maxFrameBytes=262144`；**持续 75 030 ms（≥2 个 30 s 心跳周期，15 次采样）状态恒为 `online`**，
  `heartbeatMissed` 最大 0，无重连；报告序列化后不含令牌原文（`containedToken=false`）。
  也就是说 transport / 心跳 / 关联 / 准入在这条链路上是好的，**失败点不在小程序**。
- 由于上面的 Desktop owner 缺口，本次 snapshot 未 materialize，因此页面呈现的是
  「连接在线 + 无主机卡 / 无会话」，属于**诚实的空/错误态**，没有伪造任何历史数据。
- （2026-09-16 当天）开发者工具 GUI 未能完成导入：当时开发者工具数据目录内检索不到
  `freebuddy` 或本工程路径。两条独立阻塞（均为操作者环境，本仓库不代为更改）：
  1. **屏幕处于锁定状态**（`ioreg` 实测 `CGSSessionScreenIsLocked=True`、`IOConsoleLocked=True`，
     锁定于 20:51:42），`screencapture` 只能得到全黑图，因此无法进行任何 GUI 点击；
  2. **工具「服务端口」处于关闭**：`cli open --project` 输出
     `IDE service port disabled ... ? Enable IDE Service (y/N)` 并等待输入。
     该开关属工具安全设置，本仓库不代为开启（`npm run devtools` 仍会如实失败）。
- （2026-09-16 当天）未跑：开发者工具内的导入/编译/页面操作。另注：本机 `osascript` 的
  `UI elements enabled = false`（无辅助功能授权），但 `screencapture` 本身可用——**当时 GUI 受阻的
  直接原因是屏幕锁定与服务端口关闭，不是「所有 UI 工具都不可用」**。

### 2026-09-23：真实开发者工具已导入，暴露并修复一个模块解析缺陷

两条 09-16 阻塞均已解除：服务端口已开启，`project.config.json` 的 `appid` 已由协调者填入用户授权的
真实 AppID `wx8bef453ebd05bdd5`。`npm run prepare:devtools` 实测通过（协议绑定生成 + 4 个页面文件齐全 +
typecheck），`npm run devtools`（`cli open --project`）返回成功，开发者工具里出现真实工程窗口
`freebuddy-remote-admin`。

该窗口的控制台报出**真实运行期失败**——这正是 Node 端 `npm test` / `emit:check` 过去没能发现的部分：

```text
module 'protocol.js' is not defined, require args is './protocol'
app.js 加载失败
Page pages/index/index has not been registered yet
```

**根因：** `miniprogram/app.ts` 原本写 `import ... from "./protocol"`（`protocol` 是含 `index.ts` 的
目录）。tsc 按 `moduleResolution: node` 把它 emit 成 `require("./protocol")`；Node 会把该目录解析到
`protocol/index.js`，**但微信加载器只追加 `.js`、不做目录→`index.js` 回退**，于是只找 `protocol.js`
并失败，`app.js` 停止执行、所有页面都未注册。这是小程序自身的缺陷：README 之前把「Node 侧测试通过」
当成了「开发者工具可编译」，属于过度断言。

**修复（只改 `apps/wechat-miniprogram/`，协议 binding 未动）：**

1. `miniprogram/app.ts`：`"./protocol"` → `"./protocol/index"`。这是生产目录导入的最小修根因；
   全量扫描确认这是生产代码里**唯一**一处目录导入，其余相对 require 都指向显式文件。
2. `scripts/check-ts-emit.mjs`：新增构建回归——用 TypeScript parser 读取 emit 出的每个 `.js`，
   对所有相对 `require` / import specifier 按「`<dir>/<spec>.js` 必须存在」**严格解析（不使用 Node
   的隐式 index 解析）**，出现目录导入即失败并给出 `./protocol/index` 式提示。
   回归验证：把 `app.ts` 改回 `./protocol` 时 `emit:check` 退出码 1 并精确指向
   `app.js requires "./protocol" but protocol.js does not exist`；改回 `./protocol/index` 后通过
   （回归经 AST 分析，不受注释/字符串里出现的 `require(...)` 文本干扰）。

**仍未做的诚实边界：** 本轮没有点过开发者工具 GUI、没有 preview/upload、没有真机验证，也未改真实
认证 / TLS / 合法域名设置。上面的证据仅是 Node/脚本侧的 typecheck / emit / 单测结论；
**真实 GUI 复验由协调者随后进行——不能把 Node 通过当成 GUI 通过**。

## 测试

`npm test` 当前为 **317 个测试 / 61 个 suite**。覆盖内容：

- 协议帧：21 个 valid fixture 全部解析通过；12 个 invalid fixture 按 `schema` / `parse` /
  `runtime` 分类断言（10 个被 `parseRemoteFrame` 拒绝、1 个由主机在运行时拒绝、
  1 个字节上限由 `exceedsChunkLimit` / `exceedsFrameLimit` 覆盖）；禁用方法不可路由。
- 一次性配对 HTTP：4 个 valid / 8 个 invalid fixture 由 `parseHttpBody` 按 `def` 驱动校验，
  另外覆盖 PairingStart/Claim 类型与运行时解析一致、32 字节高熵 secret 下限、
  二维码往返与「二维码不能夹带 Relay 端点」。
- 生成绑定：头部四行模板与源文件 sha256 契约、生成文件等于「头部 + 未改动源文件」
  （篡改生成文件会直接失败）、绑定版本与冻结 README 一致。
- 环境：发布包固定 prod 且忽略覆盖、覆盖白名单、prod 传输与调试约束、端点注入防护、
  环境表无 secret 字段、`getActiveEnvironment` 记忆化与覆盖读取范围。
- transport（`tests/relay-socket.test.ts`、`tests/rpc-client.test.ts`、`tests/frame-rules.test.ts`、
  `tests/admin-connection.test.ts`）： DEV 握手与 `admin.auth` 字段、role=admin 校验、
  认证失败/版本不兼容停止重试、单例 socket、一次性 nonce 心跳与心跳超时、前后台切换不叠加定时器、
  单重连定时器与退避上限、`server.draining`、非法入站与错 host 丢弃、pending 关联/超时/晚到响应、
  有界 pending、掉线后 `unknownOutcome` 清理、Relay `error` 帧按 `requestId` 结算（`host_offline`
  立即返回，而不是等到本地 15s 超时；Relay 的 `rpc_timeout` 才算 unknown）。
- DEV 闸门与令牌（`tests/dev-access.test.ts`）：release / 非 local / 非字面 loopback / 未开启
  全部拒绝；令牌只进内存（exploding fake wx api 零调用）、setToken 结果不含原值、注销后不可复用。
- adapter：login / 存储 / request / connectSocket / 网络监听的成败路径、脱敏错误、
  注入与重置、无 `wx` 时显式报错。
- 错误边界：绝不二次抛出、脱敏、截断、丢弃堆栈、sink 异常不影响调用方。
- 登录占位：按钮禁用、视图无凭据、构造过程完全不触碰微信 API（注入即抛的 fake）。
- resume 序列闸门（`tests/resume-manager.test.ts`）：连续应用、重复幂等且不移动游标、
  缺口后停流直到快照、基线之前的 stale、无基线 unprimed、非法 seq、dematerialize 后不得 resume、
  持久化与清洗、按 host 隔离、reset 与注销清理。
- resume/stores 接线（`tests/admin-state.test.ts`，fake transport + 真实帧/准入/关联）：
  冷启动取快照且不发 resume、快照原子替换并点亮游标、缺口→`sync.snapshot`、
  序号回退与「未来游标」以主机快照为准、快照清理已删除会话的消息线程、重连发 `resume`
  （携带 `lastSeq`）、前后台 flush、注销清空、分页合并与游标、
  晚分页不覆盖 live 事件（会话按 `updatedAt`、消息按 `createdAt`）、过期分页与换主机后分页丢弃、
  白名单不缓存 token 形字段。
  竞态回归：快照帧取代在途 `sync.snapshot`（游标不回退）、快照取代在途分页（结果丢弃）、
  注销后到达的快照不得重建缓存与游标。
- 只读页面视图模型（`tests/page-views.test.ts`）：连接横幅八种状态各自的 tone/是否可重连/
  是否需要凭证/是否终态；home 的主机卡与计数、无快照时不臆造主机、DEV 会话必须标注为非微信登录；
  会话列表的 loading/empty/offline/truncated/error 与 `loadMoreEnabled` 门控（离线、在途、
  无游标三种拒绝）；chat 的角色标签、空态文案随连接变化、`canSend` 恒为 `false`、
  `renderMessageText` 去控制字符/保留换行/限长 4000/HTML 与 scheme 保持惰性纯文本；
  路由常量与 `chatRoute`/`readConversationId` 的编码与越界拒绝。
- 页面控制器（`tests/page-controllers.test.ts`，production connection + fake page runtime）：
  连接页微信按钮永久禁用且无副作用、release 构建隐藏 DEV 入口并拒绝令牌、arm→hostId→token
  后才可连接且页面数据与 toast 都不含令牌原文、`openHome`/`openConversations`/`openConversation`
  导航到固定路由（会话语义用编码 id）、`signOut` 先确认再清凭证（取消确认不清）；
  home 在线后刷新 `host.status`、`reconnect` 发起新连接、`logout` 清凭证并 `reLaunch` 回连接页；
  会话页首屏 50/页并保留游标、`loadMore` 按游标取第二页并合并、离线时拒绝分页、
  `refresh` 收下拉动画、断线重连后重新读取；chat 首屏纯文本渲染、`loadOlder` 按游标追加；
  **卸载后晚到响应不写页面但 App 缓存仍更新**、**换主机后旧主机分页被丢弃**、
  **实时事件只驱动挂载中的页面**、只读控制器不提供任何写方法。
- App 单例与生命周期（`tests/app-session.test.ts`，production adapter + 记录型 fake `wx`）：
  admin socket URL 由环境表决定、无凭证不建连、网络监听只注册一次且 `dispose` 释放、
  `onShow` 不并发建连、`onHide` 挂起、断网→退避、网络恢复→重新建连、
  DEV 会话不写 token 到存储、不调用 `wx.request`、不调用 `wx.login`、注销后不复用旧凭证、
  `getAppSession` 单例与 `resetAppSession` 重建。
- 静态边界扫描（`tests/page-template-safety.test.ts`）：`app.json` 声明的页面文件齐全、
  启动页是连接页；模板不含 `rich-text`/`web-view`/`href=`/`srcdoc` 等 HTML 或跳转逃逸；
  chat 模板没有 input/textarea/发送/停止且只有一个「加载更早消息」按钮；
  整个 `miniprogram/`（除生成绑定）不出现 `wx.login(` / `wx.request(` / `wx.connectSocket(`；
  页面面上不出现写方法名、不直接 import `rpcClient`/`readRpc`、不出现 `ipc`。

## 真实 Go Relay 联调（`W2`）

`tests/relay-integration.test.ts` 用**真实** `services/remote-relay` 校验上面所有 transport 断言，
而不是用 fake transport 自证（需要本机可用的 `go`）：

- 临时目录里 `go build ./cmd/relay`，随机 loopback 端口、临时 SQLite 文件、
  `crypto.randomBytes` 生成的 DEV admin/host 令牌；令牌只存在于测试进程内存与子进程 env，
  不落盘、不进 fixture、不进仓库。测试结束删除二进制、SQLite 与临时目录。
- 客户端是生产 `createAdminConnection`；只把 `WechatApi.connectSocket` 这条缝从
  `wx.connectSocket` 换成真实 WebSocket（`tests/helpers/realSocket.ts`），
  transport / admission / correlation 一行未改。
- 模拟主机（`tests/helpers/fakeRelayHost.ts`）只做协议最小动作：走真实 `/v1/ws/host` 用
  DEV 令牌认证，按 `requestId` 回 `rpc.response`，并可发出自己编号的 `event` / `snapshot` 帧、
  接收转发过来的 `resume` 帧；业务数据仍然全部经由真实 Relay。

已确认的真实语义（不修改 Go 与协议）：

- admin 的 `auth.ok` 是 `role=admin` 且**不带** `hostId`（`AuthOkPayload.hostId` 为 `omitempty`），
  因此客户端不得要求 admin 的 `hostId`；主机身份只能由操作员显式配置 / W4 配对获得。
- `ping` → `pong` 原样回声 `nonce`，并带 `serverTime`。
- 主机不在线时 Relay 用 `error` 帧回答请求（envelope `id` 即 `requestId`，
  `hostId` 为目标主机，`payload.code=host_offline`），不是 `rpc.response`。

覆盖场景：认证上线、`ping/pong`、只读 RPC 经模拟主机应答（乱序应答仍按 `requestId`/`hostId`
关联）、主机离线 `host_offline`、无效令牌 `forbidden` 且不再自动重试、Relay 进程被 SIGKILL 后
pending 立即以 `unknownOutcome` 清理、注销后凭证不可复用、临时进程与目录彻底清理，
并断言 Relay 日志与客户端文案/诊断中都不出现令牌原文。

`tests/relay-resume.integration.test.ts` 用同一套真实 Relay + 模拟主机联调 W3 语义
（`go` 可用时）：冷启动 `sync.snapshot` 点亮游标后事件按序应用、重复 seq 端到端幂等、
缺口不落缓存并触发新的 `sync.snapshot`、主机 `snapshot` 帧（序号回退）以快照为准重置游标、
断线重连后发出携带 `lastSeq` 的 `resume` 且不再取初始快照、消息实体入缓存且诊断与 Relay
日志都不含令牌。

`tests/remote-desktop.integration.test.ts` 是**三端只读验收**：小程序生产 `createAppSession`
→ 真实 Go Relay → 临时 Electron Node 进程里的真实 `ReadOnlyRemoteService`（读真实文件型
SQLite），并断言操作员看到的 home/conversations/chat 数据就是 Desktop 数据库里的数据、
分页由 Desktop 的 `AdminDispatcher` 提供、实时事件与 resume/snapshot 回退走完整条链路。
它需要 `dist-electron/`、本地 `electron` 包和 `go`，缺任一项时整组 skip（不会静默降低断言）。
**它不是开发者工具或真机 GUI 验收**：`wx.login`/`code2Session` 管理员会话与已备案域名仍属未验证项。

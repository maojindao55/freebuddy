# FreeBuddy 远程管理员 · 微信小程序

原生 TypeScript 微信小程序脚手架，属于总控方案
[`docs/plans/2026-09-01-001-remote-admin-control-master-plan.md`](../../../docs/plans/2026-09-01-001-remote-admin-control-master-plan.md)
的 W1 部分（[小程序实施方案](../../../docs/plans/2026-09-01-005-remote-admin-wechat-miniprogram-plan.md)）。

## 当前范围（W1）

已实现：

- 微信开发者工具可识别的工程配置：`project.config.json`（`miniprogramRoot`、`useCompilerPlugins: typescript`、`urlCheck: true`）、`app.json`、`app.wxss`、`app.ts`。
- 环境配置与安全约束：`local` / `dev` / `prod` 三套命名环境，按 `wx.getAccountInfoSync().miniProgram.envVersion` 选择。
- 可注入的微信 API adapter：`login` / 存储 / `request` / `connectSocket` / 网络状态 / 客户端信息的薄层封装。
- App 级错误边界：统一处理 `onError`、`onUnhandledRejection`、`onPageNotFound`，输出前强制脱敏与截断。
- 登录占位页：只展示状态，不调用 `wx.login`、不交换 code、不写存储、不持有令牌。
- Node 单测环境：`typecheck` / `test` / `build` 脚本，覆盖配置约束、adapter、错误边界、占位页和协议 fixture。

明确未实现（后续单元）：

- 真实认证、`tokenStore`、刷新与注销（W2）。
- Singleton socket、RPC 客户端、心跳、退避（W2）。
- seq / resume / snapshot / gap 检测（W3）。
- 配对扫码、会话流、任务、终端、业务页面（W4–W7）。
- 合法域名、TLS、隐私说明、真机与弱网回归、发布加固（W8）。

## 目录结构

```text
apps/wechat-miniprogram/
├── miniprogram/                 # miniprogramRoot，开发者工具只识别这里
│   ├── app.ts / app.json / app.wxss
│   ├── config/                  # 环境表与环境解析
│   ├── platform/                # wx adapter 与注入点
│   ├── protocol/                # 协议消费入口（生成文件在此目录）
│   ├── services/                # 与页面解耦的纯逻辑
│   ├── utils/                   # 错误边界与脱敏
│   └── pages/index/             # 登录占位页
├── tests/                       # Node 单测（永不进入小程序包）
├── scripts/                     # 协议同步与测试运行
├── project.config.json
├── tsconfig.json / tsconfig.test.json
└── README.md
```

## 脚本

```bash
cd apps/wechat-miniprogram
npm install              # typescript / miniprogram-api-typings / @types/node
npm run sync:protocol    # 由 packages/protocol/src/remote.ts 生成协议绑定
npm run typecheck        # tsc -p tsconfig.json --noEmit
npm test                 # 编译到 .tmp-test/ 后 node --test
npm run build            # sync:protocol + typecheck + test
```

`npm install` 会自动执行 `prepare`（等价 `sync:protocol`）。开发者工具负责真正的小程序打包，
`npm run build` 保证提交前的类型、协议一致性和单测。

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
4. 业务代码只从 `miniprogram/protocol`（`index.ts`）导入。该模块只做两件事：`export *` 转发绑定，
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

## 微信开发者工具

1. 用开发者工具「导入项目」打开 `apps/wechat-miniprogram`，目录即 `project.config.json` 所在目录。
2. `appid` 当前为 `touristappid` 占位，需替换为真实小程序 AppID；AppSecret 只在 Relay 环境变量中。
3. `setting.urlCheck` 保持 `true`，不要依赖「不校验合法域名」。
4. `project.private.config.json` 属于个人配置，已在 `.gitignore` 中忽略。
5. TODO（W8）：在微信公众平台配置 request / socket 合法域名，并把 `config/environments.ts` 中
   `dev`、`prod` 的示例主机名替换为已备案域名。

## 测试

`npm test` 覆盖：

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
- adapter：login / 存储 / request / connectSocket / 网络监听的成败路径、脱敏错误、
  注入与重置、无 `wx` 时显式报错。
- 错误边界：绝不二次抛出、脱敏、截断、丢弃堆栈、sink 异常不影响调用方。
- 登录占位：按钮禁用、视图无凭据、构造过程完全不触碰微信 API（注入即抛的 fake）。

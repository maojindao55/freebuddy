# 调试日志导出功能设计

- 日期：2026-07-30（同日修订：纳入已有 agent 会话日志）
- 状态：已批准（用户逐节确认）
- 分支：`feat/debug-logs`

## 背景与目标

FreeBuddy 是开源桌面客户端（Electron + React + Vite + TS）。用户反馈问题时报障信息不足，开发者常需自己复现，成本高。目标：让用户在遇到问题时可一键导出诊断日志包发给开发者，开发者据此直接定位问题。

典型目标场景（来自真实用户反馈，设计必须能覆盖）：

1. **会话上下文/内存溢出**：单 agent 或团队模式下，稍复杂的任务中 agent 因会话上下文限制无法继续，用户只能关窗口。日志需回答：溢出前 agent 收发了什么、token 用量增长曲线、是 agent 侧限制还是渲染进程 OOM
2. **长会话高频报错**：`Compacting failed: aborted`、`Prompt is too long` 等来自 agent CLI 本体的错误。日志需回答：错误经 ACP 协议还是 stderr 传回、发生时的会话状态与重试历史

成功标准：

- 用户遇到 agent 运行失败 / 应用级问题时，3 次点击内导出诊断包
- 开发者拿到包后能回答：用户环境是什么、问题发生时刻主进程/渲染端/agent 各自在做什么、报错堆栈是什么
- 默认导出物不含消息正文、真实路径、任何密钥明文

## 现状（设计时调查结论）

- **应用级日志无落盘**：主进程约 45 处裸 `console.*`，无 logger 封装，main/renderer 日志均不落盘
- **agent 会话日志已存在**：`runtime.ts:154` 每次 agent 运行写 `userData/freebuddy/cli-logs/<sessionId>.jsonl`（stdin/stdout/stderr/system 四类，单行 64KB 截断，`runtimeShared.ts` 的 `appendLog` 被 acpRuntime/legacyRuntime/runtime 共用）。但**无清理策略**（磁盘只增不减）、**无用户可见入口**、未纳入任何导出——`Compacting failed`/`Prompt is too long` 这类 agent CLI 报错今天已落盘却到不了开发者手里
- PostHog 遥测（`electron/telemetry.ts`）只收事件、明确排除内容与路径；`electron/telemetryPrivacy.ts` 有既有隐私承诺，本设计与其对齐
- IPC 统一走 `electron/invokeRegistry.ts` 的 `registerHandler`，业务 channel 集中在 `electron/cli/ipc.ts` 注册，preload（`electron/preload.ts`）按域暴露
- 对话主组件 `src/components/CLI/ChatView.tsx`；错误以 i18n 文案 + `{kind:"error"}` 消息块展示
- 已有 `adm-zip` 依赖；无 `dialog.showSaveDialog` 使用先例
- i18n 资源仅 `src/locales/en.json` + `zh-CN.json`，有 key 一致性测试
- 测试：node:test；纯逻辑真单测 + 源码契约测试（如 `tests/telemetry.test.mjs`）

## 总体架构

自建轻量 logger（不引入 electron-log 等新依赖）。三入口共用一个导出对话框，导出 zip 诊断包。

```
渲染端 log ──批量(500ms)──> IPC "debugLog:write" ──> 主进程 logger ──> userData/freebuddy/logs/renderer-YYYY-MM-DD.log
主进程各模块 log ─────────────────────────────────> 主进程 logger ──> logs/main-YYYY-MM-DD.log
                                                       （每行 JSONL：{ts, level, scope, msg, data?}）
导出：UI 选模式+预览 → IPC "debugLogs:export" → 收集 logs/ + cli-logs 会话日志 → 过滤 + environment.json + zip → showSaveDialog → 返回路径
```

### 关键取舍

- **JSONL 而非纯文本**：standard 模式导出需可靠识别并剥离内容字段，JSON 字段级过滤比正则猜文本可靠；开发者 grep/jq 均方便
- **落盘保留消息正文与真实路径**（对话本就存在本地 SQLite，不引入新暴露面），脱敏在导出时按模式执行；密钥类信息例外，写入时即打码
- **无用户可见的日志级别开关**（YAGNI）：恒定采集 info 及以上 + agent 运行期 debug 事件，靠轮转控制体积

## 模块划分

### 新增

| 模块 | 职责 |
|---|---|
| `electron/debugLog.ts` | 主进程 logger 核心：`log.info/warn/error/debug(scope, msg, data?)`；JSONL 落盘；按天分文件、保留 7 天、单文件 10MB 轮转；写入时密钥打码；接管主进程 `console.*`、`uncaughtException`、`unhandledRejection`；记录 `render-process-gone` |
| `electron/debugLogExport.ts` | 导出编排：收集 logs 目录 + 近 7 天 cli-logs 会话日志 → 按模式过滤 → 生成 `environment.json` + `README.txt` → adm-zip 打包 → `dialog.showSaveDialog`（默认文件名 `freebuddy-debug-<时间戳>.zip`） |
| `electron/shared/logSanitize.ts` | 纯函数：密钥正则打码、内容字段剥离、路径掩码（最长优先替换）。写入与导出共用 |
| `src/services/debugLogClient.ts` | 渲染端 logger：同名 API；500ms 批量缓冲后经 `debugLog:write` 转发主进程；挂 `window.onerror` / `unhandledrejection` |
| `src/components/Settings/ExportDebugLogsDialog.tsx` | 导出对话框（见 UI 节） |

### 改动（仅插入 log 调用 / 挂载 UI，不改既有逻辑）

- `electron/main.ts`：app ready、窗口创建、更新器事件、`render-process-gone`
- `electron/cli/acpRuntime.ts`、`electron/cli/runtime.ts`：agent 启动（参数脱敏后）、协议握手、错误退出码
- `electron/cli/db.ts`：`cli-logs/` 增加 7 天保留清理（在 `getLogDir` 旁实现，启动时执行；现状无清理，磁盘只增不减）
- `electron/cli/runtimeShared.ts`：`appendLog` 增加写入时密钥打码（与第 1 层对齐；现有历史文件由导出时补打，见下）
- `src/store/conversationStore.ts`：发送失败、错误消息块写入
- `electron/cli/ipc.ts`：注册 `debugLog:write`、`debugLogs:export`、`debugLogs:preview`
- `electron/preload.ts`：按域暴露上述三个方法
- `src/components/Settings/AboutTab.tsx`：「诊断」区块按钮
- `src/components/CLI/MessageBubble.tsx`：error 消息块加「导出调试日志」链接按钮
- `src/components/CLI/ChatView.tsx`：右上角 "..." 菜单加常驻项
- `src/locales/en.json`、`zh-CN.json`：新增文案

## 日志格式与保留策略

每行一个 JSON 对象：

```json
{"ts":"2026-07-30T12:34:56.789Z","level":"info","scope":"acp","msg":"agent process started","data":{"adapter":"codex"}}
```

- `scope` 取值约定：`main`、`window`、`updater`、`ipc`、`acp`、`runtime`、`renderer`、`crash`
- 文件：`userData/freebuddy/logs/{main|renderer}-YYYY-MM-DD.log`
- 保留：7 天自动清理；单文件超 10MB 轮转（追加 `.1` 序号后缀，同日最多 3 份）
- logger 写盘失败：静默丢弃 + 内存计数 `droppedLines`，导出时写入 environment.json

## 三层脱敏模型

### 第 1 层 · 写入时（永远生效）

密钥类正则集匹配即打码，保留前 6 位便于识别厂商：

- `sk-...`（OpenAI/Anthropic 等）→ `sk-ant-…<redacted>`
- `Bearer <token>`、`api_key=...`、`token=...`、`Authorization: ...` 头部值

原始 key 对定位无价值，不值得承担落盘风险。

### 第 2 层 · 导出时（按模式过滤）

| | standard（默认） | full |
|---|---|---|
| `data` 内容字段（约定键名 `content`/`prompt`/`messageText`/`output`） | `<redacted: N chars>`（保留长度） | 原样 |
| 已知路径（home / workspace roots / userData，最长优先字符串替换） | `<home>` / `<workspace>` / `<appdata>` | 原样 |
| 密钥 | 已被第 1 层打码 | 已被第 1 层打码 |

agent stderr 在 standard 模式下**保留**（仅做路径掩码）：它是 CLI/ACP 失败最有价值的线索，且不属于用户对话内容。

**会话日志（cli-logs `<sessionId>.jsonl`）的过滤规则**：每行 `{ts, type, content}`。standard 模式下——
- `type=system`（start/exit 等）：整行保留（含 adapter、cwd——cwd 做路径掩码）
- `type=stderr`：保留，路径掩码
- `type=stdin/stdout`（协议载荷，含 prompt 与消息正文）：尝试解析 content JSON，**仅保留结构性字段**（事件类型、方法名、错误码与错误消息文本、数值型元数据如 token 用量/耗时——不敏感，且是目标场景 1「用量增长曲线」的依据）+ 原行长度标记 `<redacted: N chars>`；解析失败则整行替换为长度标记。错误消息文本保留的理由：`Compacting failed: aborted`、`Prompt is too long` 这类字符串正是定位目标场景 2 的关键。**已接受的残余风险**：保留的错误消息文本理论上可能引用用户内容片段（如 `Compacting failed for prompt "..."`），由单行 64KB 截断 + 路径/密钥掩码缓解，不做内容剥离
- full 模式：内容原样，但**导出时对每行补做密钥正则打码**（历史 cli-logs 写入时未打码，可能含密钥明文；新文件经 `appendLog` 打码后此处为幂等操作）

### 第 3 层 · environment.json

本身不含敏感信息：

```json
{
  "app": {"version": "0.6.8", "platform": "darwin", "arch": "arm64", "osRelease": "...", "locale": "zh-CN"},
  "runtime": {"electron": "...", "chrome": "...", "node": "..."},
  "telemetry": {"enabled": true},
  "adapters": [{"id": "codex", "label": "Codex"}],
  "counts": {"conversations": 12},
  "logHealth": {"droppedLines": 0},
  "exportedAt": "...", "exportMode": "standard"
}
```

不含 workspace 路径、用户名、消息内容。适配器列表来自静态定义（id/label），可用性探测不在本期范围（YAGNI），adapter 运行状况从会话日志的启动/退出记录推断。

## 导出物结构

```
freebuddy-debug-2026-07-30T12-30-45.zip
├── environment.json
├── README.txt        # 一句话说明：诊断包、导出模式、日志格式说明
├── logs/
│   ├── main-2026-07-30.log
│   ├── main-2026-07-29.log   # 最多 7 天
│   └── renderer-2026-07-30.log
└── sessions/                 # 近 7 天 agent 会话日志（cli-logs），定位上下文溢出/Compacting 失败的主战场
    ├── <sessionId-a>.jsonl
    └── <sessionId-b>.jsonl
```

会话日志体积控制：每个会话文件只收**尾部最多 2MB**（溢出/报错发生在会话末尾，尾部价值最高），超出时文件头标注截断；standard 模式过滤后体积通常远小于此。

不做独立 crashes 目录：崩溃堆栈在 main.log 中带 `crash` scope（YAGNI）。

## UI 交互

`ExportDebugLogsDialog`（Modal，三入口共用）：

1. 模式选择 radio：「标准模式（推荐，已脱敏）」/「完整模式（含对话内容，仅供私下发送）」，完整模式带警示文案
2. 预览区：显示所选模式过滤后的 environment.json + 各日志末尾约 200 行（所见即所导出）
3. 「导出」→ save dialog → 成功 toast（含保存路径）

入口：About tab 诊断区块（主入口）/ 错误气泡链接按钮 / 对话右上角 "..." 菜单常驻项。

## 错误处理原则

日志系统自身永远不能搞挂 app：

- 写盘全部 try/catch；磁盘满/权限错 → 静默丢弃 + 计数
- 渲染端 IPC 转发失败 → 缓冲丢弃，不重试风暴
- logger 初始化失败 → 整体降级 no-op
- 导出失败 → i18n 错误 toast

## 测试方案

| 测试 | 类型 |
|---|---|
| `tests/log-sanitize.test.mjs` | 真实单测：密钥正则（含 `appendLog` 写入时打码）、内容字段剥离、路径掩码（最长优先）、**会话日志行过滤**（stdin/stdout 结构保留 + 数值元数据保留 + 错误消息保留 + 解析失败兜底）、边界情况 |
| `tests/debug-log-rotation.test.mjs` | 真实单测：tmp 目录验证按天分文件、7 天清理、10MB 轮转、**cli-logs 7 天清理** |
| `tests/debug-log-export.test.mjs` | 契约测试（仿 `tests/telemetry.test.mjs`）：IPC 注册、preload 暴露、三处 UI 挂载、隐私断言（standard 过滤路径存在、密钥正则被调用） |
| i18n key 一致性 | 现有 `tests/i18n-strings.test.mjs` 自动覆盖 |

## 明确不做（YAGNI）

- 日志级别用户开关
- 远程自动上传日志（导出是用户主动行为，与遥测隐私承诺一致）
- 独立 crashes 目录
- electron-log 等第三方 logger 依赖

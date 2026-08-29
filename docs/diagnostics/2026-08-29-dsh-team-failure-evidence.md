# DSH 团队模式失败诊断与日志证据链

## 1. 问题描述

用户反馈：普通团队和自组织团队使用 `dsh-acp` 时会“崩”，单聊模式正常。

本报告分析以下调试日志包：

- 导出目录：`freebuddy-debug-2026-08-29T10-29-19-416`（本机路径已脱敏）
- 导出时间：`2026-08-29T10:29:19.416+08:00`
- 应用版本：FreeBuddy `0.9.5`
- 系统：Windows 10 x64，`10.0.19045`
- Electron / Node：`43.4.1` / `24.18.1`
- DSH Agent：`deepseek-harness-acp 0.1.27`

> 日志包声明 `sessions/` 仅包含导出时的当前会话。因此，本报告可以完整分析当天主进程事件，但不能还原所有失败团队会话的逐条 ACP transcript。

## 2. 结论摘要

本次样本中已记录的 DSH 团队失败，直接原因是 DeepSeek 服务端的请求频率或配额限制，不是 Windows 原生进程崩溃：

1. 团队入口 Agent 成功启动并完成 ACP 初始化。
2. 约 44 秒后，服务端明确返回“1 分钟内最多请求 5 次”。
3. FreeBuddy 将该次 turn 标记为失败，使用内部逻辑失败值 `exitCode: -1`。
4. 等待约 40 秒后，同一自组织团队的后续 turn 正常初始化并以 `exitCode: 0` 完成。
5. 单聊诊断会话也出现过 `Allocated quota exceeded`，稍后重试成功。因此“单聊始终正常”不被这份日志完全支持。

日志中没有发现 `0xC0000005`、`3221225477`、`STATUS_ACCESS_VIOLATION` 等 Windows 原生崩溃证据，也没有发现故障时间段内 FreeBuddy 主进程重启。

另有一项独立异常：隔离团队 runtime 的 `runtime.hello` 握手超时。当前代码会回退到主进程内执行，因此它造成额外延迟并削弱进程隔离，但不是这次 DSH turn 失败的直接原因。

## 3. 核心证据链

### E1：团队 runtime 握手超时，但已触发回退

来源：`logs/main-2026-08-29.log:864-865`

```json
{"ts":"2026-08-29T10:12:58.193+08:00","level":"warn","scope":"runtime-process","msg":"delegation falling back in-process","data":{"method":"delegation.prepareRun","error":"rpc timeout: runtime.hello"}}
{"ts":"2026-08-29T10:13:06.201+08:00","level":"warn","scope":"runtime-process","msg":"delegation falling back in-process","data":{"method":"delegation.runEntry","error":"rpc timeout: runtime.hello"}}
```

解释：隔离 runtime 未在 8 秒内完成握手，但系统明确执行了 `falling back in-process`。后续 DSH Agent 仍被启动，证明该异常没有直接终止团队任务。

### E2：团队 DSH Agent 正常启动并完成 ACP 初始化

来源：`logs/main-2026-08-29.log:866-867`

```json
{"ts":"2026-08-29T10:13:06.206+08:00","level":"info","scope":"runtime","msg":"agent run start","data":{"adapter":"dsh-acp","sessionId":"del-<redacted>-entry-1","approvalMode":"auto"}}
{"ts":"2026-08-29T10:13:06.945+08:00","level":"info","scope":"acp","msg":"agent initialized","data":{"adapter":"dsh-acp","sessionId":"del-<redacted>-entry-1","agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
```

解释：`sessionId` 以 `del-` 开头，属于自组织团队委派 turn。Agent 进程和 ACP `initialize` 阶段均正常。

### E3：服务端明确返回每分钟请求次数限制

来源：`logs/main-2026-08-29.log:868`

```json
{"ts":"2026-08-29T10:13:50.954+08:00","level":"error","scope":"acp","msg":"agent run failed","data":{"adapter":"dsh-acp","sessionId":"del-<redacted>-entry-1","exitCode":-1,"errorMessage":"Internal error: turn failed: 您已达到总请求数限制：1分钟内最多请求5次，包括失败次数，请检查您的请求是否正确 (request id: <redacted>)","agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
```

解释：这是服务端返回的明确业务错误。`exitCode: -1` 是 FreeBuddy 对未成功完成 turn 的内部标记，不是 Windows 进程退出码。

### E4：限流窗口后，同一团队后续 turn 成功

来源：`logs/main-2026-08-29.log:872-874,938`

```json
{"ts":"2026-08-29T10:14:31.681+08:00","level":"warn","scope":"runtime-process","msg":"delegation falling back in-process","data":{"method":"delegation.followUp","error":"rpc timeout: runtime.hello"}}
{"ts":"2026-08-29T10:14:31.684+08:00","level":"info","scope":"runtime","msg":"agent run start","data":{"adapter":"dsh-acp","sessionId":"del-<redacted>-entry-2","approvalMode":"auto"}}
{"ts":"2026-08-29T10:14:32.455+08:00","level":"info","scope":"acp","msg":"agent initialized","data":{"adapter":"dsh-acp","sessionId":"del-<redacted>-entry-2","agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
{"ts":"2026-08-29T10:15:21.258+08:00","level":"info","scope":"acp","msg":"agent run done","data":{"adapter":"dsh-acp","sessionId":"del-<redacted>-entry-2","exitCode":0,"agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
```

解释：第一次失败后约 40.7 秒重新开始，随后正常完成。若是稳定可复现的二进制崩溃，通常不会仅因等待限流窗口而恢复。

### E5：单聊模式也出现过配额错误，并在稍后恢复

来源：`logs/main-2026-08-29.log:951-958`

```json
{"ts":"2026-08-29T10:19:50.810+08:00","level":"info","scope":"runtime","msg":"agent run start","data":{"adapter":"dsh-acp","sessionId":"<redacted-single-session-1>","approvalMode":"auto"}}
{"ts":"2026-08-29T10:19:51.536+08:00","level":"info","scope":"acp","msg":"agent initialized","data":{"adapter":"dsh-acp","sessionId":"<redacted-single-session-1>","agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
{"ts":"2026-08-29T10:20:36.295+08:00","level":"error","scope":"acp","msg":"agent run failed","data":{"adapter":"dsh-acp","sessionId":"<redacted-single-session-1>","exitCode":-1,"errorMessage":"Internal error: turn failed: Allocated quota exceeded, please increase your quota limit.","agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
{"ts":"2026-08-29T10:21:16.084+08:00","level":"info","scope":"runtime","msg":"agent run start","data":{"adapter":"dsh-acp","sessionId":"<redacted-single-session-2>","approvalMode":"auto"}}
{"ts":"2026-08-29T10:21:16.809+08:00","level":"info","scope":"acp","msg":"agent initialized","data":{"adapter":"dsh-acp","sessionId":"<redacted-single-session-2>","agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
{"ts":"2026-08-29T10:21:23.601+08:00","level":"info","scope":"acp","msg":"agent run done","data":{"adapter":"dsh-acp","sessionId":"<redacted-single-session-2>","exitCode":0,"agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
```

解释：无 `del-` 前缀的普通 DSH turn 同样可能受到配额影响。失败后约 39.8 秒再次启动，随后成功。

### E6：后续团队委派继续成功

来源：`logs/main-2026-08-29.log:963-966`

```json
{"ts":"2026-08-29T10:21:58.409+08:00","level":"warn","scope":"runtime-process","msg":"delegation falling back in-process","data":{"method":"delegation.followUp","error":"rpc timeout: runtime.hello"}}
{"ts":"2026-08-29T10:21:58.412+08:00","level":"info","scope":"runtime","msg":"agent run start","data":{"adapter":"dsh-acp","sessionId":"del-<redacted>-entry-3","approvalMode":"auto"}}
{"ts":"2026-08-29T10:21:59.135+08:00","level":"info","scope":"acp","msg":"agent initialized","data":{"adapter":"dsh-acp","sessionId":"del-<redacted>-entry-3","agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
{"ts":"2026-08-29T10:22:50.713+08:00","level":"info","scope":"acp","msg":"agent run done","data":{"adapter":"dsh-acp","sessionId":"del-<redacted>-entry-3","exitCode":0,"agentName":"deepseek-harness-acp","agentVersion":"0.1.27"}}
```

解释：隔离 runtime 握手仍然失败，但回退后的团队 DSH turn 成功。这进一步说明 `runtime.hello` 超时与 DSH 请求失败是两个独立问题。

### E7：未发现此前 Windows Koffi 崩溃的直接证据

来源：`dsh-acp-runtime.json:2-16`

```json
{
  "runtimePresent": true,
  "overlayDirPresent": true,
  "jsonlCopyCount": 1,
  "jsonlKoffiCopyCount": 0,
  "windowsAclPresent": true,
  "windowsAclUsesKoffi": true,
  "persistenceCompressionNone": true,
  "sandboxDisabledOnWin32": false,
  "koffiGuardPresent": true,
  "koffiGuardOnArgv": false,
  "jsonlRelatives": [
    {
      "path": "node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js",
      "usesKoffi": false
    }
  ]
}
```

解释：

- JSONL persistence 覆盖已存在，且该副本没有使用 Koffi。
- `windowsAclPresent` / `windowsAclUsesKoffi` 只说明相关包仍安装在依赖树中，不能单独证明本次运行加载了它。
- `sandboxDisabledOnWin32: false` 和 `koffiGuardOnArgv: false` 也不能单独证明原生沙箱已启用；Windows composition 可以通过完全不挂载原生 sandbox 的方式避开 Koffi。
- 本次日志没有出现 Windows 访问冲突对应的退出码或错误文本。

## 4. 因果链判断

```text
团队任务/工具循环产生多次模型请求
                │
                ▼
DeepSeek 账户或网关达到每分钟请求数/分配配额
                │
                ▼
DSH ACP 返回 turn failed（明确限流或 quota 文本）
                │
                ▼
FreeBuddy 将该 Agent turn 标记为 failed（exitCode: -1）
                │
                ▼
团队编排停止或显示失败，用户感知为“团队崩了”
```

其中，服务端限流、ACP turn 失败和 FreeBuddy 标记失败都有直接日志支持；“团队/工具循环更容易消耗请求额度”是基于团队执行形态与故障集中出现方式的合理推断，当前日志未记录每次底层 HTTP 请求，不能将具体请求次数作为已确认事实。

## 5. 已确认事实与未确认项

### 已确认事实

- 故障样本运行于 Windows x64、FreeBuddy `0.9.5`、DSH `0.1.27`。
- DSH ACP 初始化成功后才发生失败。
- 至少一次团队失败明确由“1 分钟最多 5 次请求”触发。
- 至少一次普通 DSH turn 明确出现 `Allocated quota exceeded`。
- 等待一段时间后，普通 DSH turn 和团队 DSH turn 均有成功记录。
- 隔离 runtime 多次发生 `runtime.hello` 超时，并回退到主进程内执行。
- 当前样本没有 Windows `0xC0000005` 原生崩溃证据。

### 尚未确认

- “普通团队”失败的完整 ACP 事件链：导出的 `sessions/` 仅包含当前会话。
- 限流来自 DeepSeek 官方端点、用户自定义网关，还是其上游账户策略。
- 单个 DSH 工具循环实际发出了多少次底层模型请求。
- `runtime.hello` 超时的具体根因：日志没有包含隔离 runtime 子进程的启动命令、stderr 或退出原因。
- 用户所说的“崩”是否意味着团队卡片失败，还是整个 FreeBuddy 窗口关闭。现有日志只支持前者，没有主应用崩溃证据。

## 6. 修复建议

### P0：正确展示上游限流错误

- 团队步骤失败时保留并展示原始 `errorMessage`。
- 将以下错误识别为“服务端限流/配额”，不要展示成泛化的 Agent 崩溃：
  - `1分钟内最多请求5次`
  - `request limit`
  - `rate limit`
  - `Allocated quota exceeded`
- 在团队卡片中提供明确提示和可重试时间。

### P1：限制团队中的 DSH 并发

- 对使用同一 DSH 凭据的 Agent 设置全局并发上限，默认 `1`。
- 普通 workflow 中不要通过 `Promise.all` 同时启动多个 DSH step。
- 自组织团队中将 DSH 子 Agent 排队，避免入口 Agent 与多个子 Agent 同时消耗同一请求桶。

并发限制可以降低团队突发请求，但不能完全解决单个 Agent 在连续工具调用中超过 5 次请求的问题。

### P1：实现安全的限流重试

- 仅对明确可恢复的限流错误启用冷却重试。
- 建议首次等待 `60～65` 秒并加入少量抖动，最多自动重试一次。
- 如果失败 turn 已执行写操作，不应静默重跑，以免产生重复副作用；应提示用户确认后重试。
- 优先让 DSH Harness 在内部遵循服务端的 `Retry-After`，因为 FreeBuddy 无法准确观察一个 ACP turn 内部的所有模型请求。

### P2：单独修复 runtime 握手超时

- 记录隔离 runtime 的实际 entry path、PID、启动参数、stderr 和退出码。
- 区分“未启动”“启动后无 IPC”“协议不匹配”“启动超过 8 秒”四类失败。
- 保留回退作为容灾，但应避免每次团队调用都重复等待 8 秒。

## 7. 验收标准

1. DSH 返回每分钟请求限制时，团队界面显示“DeepSeek 请求受限”，并保留原始错误，而不是显示“崩溃”。
2. 同一凭据下的多个 DSH 团队成员不会并发启动模型 turn。
3. 无写入副作用的限流 turn 在冷却窗口后最多自动重试一次。
4. 单聊模式行为不回退，正常响应仍以 `exitCode: 0` 完成。
5. Windows 上不出现 `0xC0000005` / `3221225477`。
6. 隔离 runtime 握手失败时，日志能给出子进程级根因；回退不重复产生固定 8 秒等待。

## 8. 建议补充材料

如果用户所说的“崩”是整个 FreeBuddy 窗口关闭，还需要补充：

- 失败团队会话本身的 full-scope session transcript。
- Windows 事件查看器中对应时间的 Application Error。
- `%LOCALAPPDATA%\\CrashDumps` 或 Electron crash dump。
- 复现时使用的团队定义、成员数量、各成员是否共用同一 DSH Key。
- DSH 的 `baseURL` 类型（官方端点或自定义网关，不需要提交密钥）。

## 9. 最终判定

| 项目 | 判定 | 置信度 |
| --- | --- | --- |
| 本次已记录团队失败的直接原因 | DeepSeek 请求频率限制 | 高 |
| DSH 二进制/Windows 原生崩溃 | 当前样本不支持 | 高 |
| 团队模式更容易触发限制 | 很可能 | 中高 |
| 单聊完全不受影响 | 日志不支持 | 高 |
| `runtime.hello` 超时导致本次 DSH turn 失败 | 否；已成功回退 | 高 |
| `runtime.hello` 超时需要独立修复 | 是 | 高 |

# Composer 定时发送设计

> 状态：已实现（v1，内存态；不跨应用重启）。

## 目标

Agent（如 Codex / Claude）常有 5 小时滚动额度，对话中途会因为额度耗尽而中断。
用户希望在 composer 里把下一条消息**定时**到额度恢复的时刻自动发送，让对话在无人值守时自动继续。

## 非目标

- 跨应用重启持久化定时（v1 不做；应用关闭即丢失，UI 上明示）
- 自动探测「额度耗尽」并自动重试（v1 只做用户显式设置时间）
- 新任务首页（`NewTaskHome`）的定时（v1 只覆盖已有对话的 composer）
- 与侧栏「定时任务（Scheduled Tasks）」合并——那是 cron 式创建新对话的产品面，本功能是当前对话的一次性延迟发送

## 行为

### 设置

composer 尾部（模型选择器与发送按钮之间）新增时钟按钮。按钮**始终可点**（仅在回放 / 附件处理中 / 发送锁定时禁用，
agent 运行中则隐藏）。点击弹出面板：

消息内容始终在 composer 输入框里编辑，面板只负责选时间；草稿和附件都为空时，
时间选项禁用并提示先输入消息。

1. **快捷延时**：15 分钟 / 30 分钟 / 1 小时 / 2 小时 / 5 小时
2. **额度重置时**：仅 Codex 系 adapter（`codex`、`codex-acp`）显示。面板打开时调用
   `cliClient.codexUsage()`，从各窗口里挑选目标重置时间（见「Codex 重置时间选择」），
   在重置时刻上再加 60 秒余量。读取失败或无窗口时显示不可用。
3. **自定义时间**：`datetime-local` 输入 + 确认按钮；必须晚于当前时间。

确认后：

- 快照当前 `draft` + `pendingAttachments`，写入 `scheduledSendStore`（每个对话最多一条，重复设置覆盖）
- 清空 composer 输入框和附件托盘（附件用 `protectManagedAttachments` 保护托管临时文件，避免被清理）
- 消息以**用户气泡**形式出现在对话末尾（虚线边框，与已发送消息区分），气泡下方一行小字显示倒计时

### 气泡倒计时行

「将于 HH:mm 自动发送 · 倒计时」+ 操作：

- **立即发送**：把 `fireAt` 置为现在，由 runner 在下一拍发出
- **改回草稿**：取消定时，把 prompt / 附件恢复到 composer
- **取消（×）**：丢弃定时和消息（不恢复到草稿；需要保留内容时用「改回草稿」）

状态：

- `pending`：倒计时
- `waiting`：到点但该对话的 agent 仍在运行，等它结束后自动发送
- `sending`：正在发送
- `failed`：发送出错，显示错误，可「重试 / 改回草稿 / 取消」

### 触发（runner）

`startScheduledSendRunner()` 在 `App` 挂载时启动一个 1s `setInterval`（不用 `setTimeout`
是为了在系统休眠/时钟跳变后仍能按 `Date.now() >= fireAt` 正确触发）。每拍：

1. 更新 store 的 `now`（驱动倒计时 UI）
2. 对每条到点的 `pending`/`waiting` 记录：
   - 对话不存在 → 删除记录并通知
   - `conversationStore.isRunning(id)` → 置 `waiting`
   - 否则置 `sending`，走发送：
     - 若是 delegation 对话（`delegationClient.hasRunForConversation`）→ `delegationClient.followUp`
     - 否则 → `conversationStore.sendMessage({ approvalModeOverride: conv.approvalMode })`
   - 成功 → 删除记录、`notify`；失败 → 置 `failed` 并记录错误

runner 与 `ChatView` 解耦：用户切到设置页 / 其他对话时 `ChatView` 会卸载，定时仍然有效。

### Codex 重置时间选择

`pickCodexUsageResetAt(windows, now)`：

1. 过滤掉 `resetAt` 无效或已过期的窗口
2. 优先取 `leftPercent <= 0`（已耗尽）的窗口中最早的 `resetAt`
3. 否则取所有窗口中最早的 `resetAt`
4. `resetAt` 兼容秒 / 毫秒两种单位（与 `WorkspacePanel` 一致）

## 代码位置

| 文件 | 职责 |
|------|------|
| `src/utils/scheduledSend.ts` | 纯函数：预设、Codex 重置时间选择、时间/倒计时格式化、`datetime-local` 转换 |
| `src/store/scheduledSendStore.ts` | Zustand：每对话一条记录、状态迁移、`now` |
| `src/services/scheduledSend/runner.ts` | 1s 心跳 + 到点发送逻辑 |
| `src/components/CLI/ScheduledSendControl.tsx` | 时钟按钮 + 面板；气泡下方的倒计时行（`ScheduledSendMeta`） |
| `src/components/CLI/ChatView.tsx` | 接入：快照草稿、恢复草稿、在消息列表末尾渲染定时气泡 |
| `src/App.tsx` | 挂载 runner |
| `tests/scheduled-send.test.mjs` | 纯函数单测 + 源码结构断言 |

## 边界

- 应用重启后定时丢失（倒计时行 hover 有提示文案）
- 定时发送不走 `preflightMember`（CLI 安装检查）；若 CLI 不可用，`sendMessage` 会在对话里落一条错误项，气泡进入 `failed`
- 若到点时用户正在同一对话里手动发送，runner 会因 `isRunning` 进入 `waiting`，等待完成后再发，不会并发

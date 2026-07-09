# 主对话模型选择器设计

## 目标

在主对话输入框旁提供模型及相关配置选择器，让用户可以按消息粘性选择模型 ID，并在后续发送时通过 ACP 正式协议生效。

用户心智：

> 首轮对话后，输入框旁出现当前 Agent 支持的模型列表。我选一个模型（以及可选的 model_config / thought_level），之后这个会话里发消息都用它，直到我再改。

## 非目标

- 不做常驻 ACP 进程，也不做发送前即时 `set_config_option`。
- 不实现 / 不调用已移除的 `session/set_model`。
- 新功能路径不依赖、不维护 legacy `result.models`；现有兼容解析可保留，但不为本功能扩展。
- 第一版不做 `mode` 选择器（除非后续单独需求）。
- 不与 Settings 里 `--model` / BYOK 做双向同步。
- 不把 model 提升为 `conversation_messages` 的一等字段。

## 已确认决策

| 决策 | 选择 |
|------|------|
| 作用粒度 | 按消息可选，会话内粘性 |
| 列表来源 | ACP `configOptions`（稳定路径） |
| 冷启动 | 无列表时隐藏；首轮回流后再显示 |
| 切换方式 | `session/set_config_option` |
| 生效时机 | 下次发送时，在 `session/prompt` 前应用 |
| 选择器范围 | `model` + `model_config` + `thought_level` |
| 实现路径 | 发送时应用（对齐现有 spawn 生命周期） |

## 背景

FreeBuddy 通过本地 CLI Agent（ACP）驱动主对话，不直连云端 LLM HTTP API。

当前：

- Settings → Coding Agents 可通过 `--model` / env 配置默认模型。
- ACP Session Setup 回流的 `configOptions` 已解析为 stream item `config-options`，WorkspacePanel 只读展示。
- **没有**聊天内选择器，也**没有** `session/set_config_option` 调用。

ACP 稳定协议（Session Config Options）：

1. **发现**：`session/new|load|resume` 的 `result.configOptions` 中，`category: "model"`（或 `id: "model"`）提供可选值与 `currentValue`。
2. **切换**：`session/set_config_option`，params 为 `{ sessionId, configId, value }`；返回完整 `configOptions`。
3. **推送**：Agent 可通过 `session/update` → `config_option_update` 通知完整配置状态。

## 架构概览

```
ChatView 选择器
  → conversationStore 更新 configOptionOverrides（粘性）
  → SQLite conversations.config_option_overrides
  → sendMessage 把 overrides 放入 CliRunArgs
  → acpRuntime: establishSession
  → 对每个 override: session/set_config_option
  → 回流 config-options items
  → session/prompt
```

## UI 与交互

**位置：** 主对话 `chat-composer-actions`，靠近现有 permission 选择器。

**数据过滤：**

- 从 `mergeSessionMetaItems` / 最新 `config-options` 中筛：
  - `category` ∈ `model` | `model_config` | `thought_level`
  - 或 `id === "model"`（缺 category 时兜底）
- 按 ACP 返回顺序展示；`model_config` / `thought_level` 靠近 model。

**行为：**

- 冷启动无上述 options → 不渲染选择器。
- 有数据后显示当前 model 标签；点击弹出面板切换。
- 展示值 = `overrides[configId] ?? option.currentValue`。
- 用户改动立刻写入该 conversation 的 sticky overrides；不立刻打 ACP。
- streaming 中选择器禁用；本地改动可保存，本轮结束后用于下次发送。
- 无 ACP / 无相关 options 的 Agent → 不显示。

**与 Agent 回流同步：**

- 无本地 override 时，UI 跟随 `currentValue`。
- 有 override 时以用户选择为准。
- 若 Agent 回流值与某 override 相同，可清除该 override（已对齐）。

## 数据模型

### Conversation 粘性偏好

在 `conversations` 表新增：

- `config_option_overrides`：JSON 文本，形状为 `Record<string, string>`（`configId → value`）

类型：

```ts
// Conversation
configOptionOverrides?: Record<string, string>;

// CliRunArgs
configOptionOverrides?: Record<string, string>;
```

持久化与读写对齐现有 `approvalMode`：

- `cliClient.setConversationConfigOptionOverrides(id, overrides)`
- 主进程 `conversations.ts` 更新列并回读

### 列表来源（只读）

继续复用：

- `electron/cli/acp.ts`：`normalizeConfigOptions` → `config-options` items
- `src/store/sessionMetaUtils.ts`：从 messages / live items 取最新 options

新功能**只消费**稳定 `configOptions` 归一化结果，不新增对 legacy `models` 的依赖或测试。

## 发送时序

1. 现有路径：`session/new` 或 `session/load` / `session/resume`
2. 若 `configOptionOverrides` 非空：
   - 丢弃当前回流 options 中已不存在的 `configId`
   - 对剩余项逐个 `session/set_config_option`
   - 每次成功用返回的完整 `configOptions` 发 `items`（`kind: "config-options"`）
3. `session/prompt`

## ACP / IPC 变更

**新增：**

- `buildSessionSetConfigOptionRequest(id, sessionId, configId, value)`
- `acpRuntime` 在 prompt 前应用 overrides
- `CliRunArgs.configOptionOverrides`
- conversation CRUD 读写 overrides
- preload / `cliClient` 暴露更新方法

**明确不做：**

- `session/set_model`
- 扩展 legacy `models` 解析维护

## 错误处理

- 单个 `set_config_option` 失败：记 log，**不阻断**本次 prompt；该 override 保留，UI 可轻提示。
- 全部失败：仍继续 prompt，使用 Agent 默认模型。
- 目的：避免因个别 Agent 未实现 config options 而导致无法发消息。

## 边界情况

| 场景 | 行为 |
|------|------|
| 新会话首轮前 | 无选择器 |
| 首轮后有 model options | 显示选择器 |
| resume 后 options 变化 | 以最新回流为准；无效 override key 发送前丢弃 |
| 切换 conversation | overrides 按会话隔离 |
| streaming | 选择器禁用 |
| legacy-only / 无 configOptions | 不显示选择器 |

## 测试计划

优先单测：

1. `buildSessionSetConfigOptionRequest` 请求形状正确。
2. prompt 前按序应用 overrides；成功后刷新 `config-options` items。
3. UI 过滤只保留 `model` / `model_config` / `thought_level`。
4. 冷启动无 options → 不渲染；有 options → 渲染 sticky 值。
5. 无效 configId 在发送前被丢弃。
6. **不**新增 legacy `models` 相关测试或维护任务。

## 验收标准

1. 首轮发送前无选择器；首轮回流后出现。
2. 选择 model（及附属 config）后，后续发送先 `set_config_option` 再 `prompt`。
3. 重启应用后 sticky overrides 仍在。
4. Agent 不支持 `set_config_option` 时仍能正常发消息。
5. 新功能代码路径不依赖 legacy `result.models`。

## 实现落点（参考）

| 区域 | 主要文件 |
|------|----------|
| UI | `src/components/CLI/ChatView.tsx`（及可能的小组件） |
| Store | `src/store/conversationStore.ts`, `sessionMetaUtils.ts` |
| Types / client | `src/services/cli/types.ts`, `client.ts`, `freebuddy.d.ts` |
| DB | `electron/cli/db.ts`, `conversations.ts` |
| ACP | `electron/cli/acp.ts`, `acpRuntime.ts` |
| IPC | `electron/cli/ipc.ts`, `electron/preload.ts` |
| Tests | `tests/acp.test.mjs` 等 |

# 会话标题优先采用 Agent 总结设计

## 目标

让主对话侧边栏标题在首轮结束后优先使用 ACP 回流的 `session.title`（Agent 总结），而不是长期停留在「截取用户输入」。

用户心智：

> 我发完第一轮后，会话标题会变成 Agent 总结的短标题。如果这个 Agent 不提供标题，就继续用我输入内容的截取版。我手动改过标题后，系统不再自动改。

## 非目标

- 不额外向 Agent 发隐藏「请总结标题」请求。
- 不在每轮结束后反复改标题。
- 不引入独立小模型/本地 LLM 做标题。
- 不改变 Feed/Draft 等已 `preserveConversationTitle` 的场景。
- 不把标题做成消息级字段。

## 已确认决策

| 决策 | 选择 |
|------|------|
| 更新时机 | 仅首轮：从临时标题升级到 Agent 标题后锁定 |
| 标题来源优先级 | ACP `session.title` 优先；没有则保留用户输入截取 |
| 无 Agent title 时 | 继续用现有 `buildConversationTitle` 截取，不再二次请求 |
| 实现路径 | 强化现有 ACP 标题回流 + `titleSource` 状态机 |

## 背景

当前行为：

1. 新建会话：`defaultTitleFor` → `Agent名` 或 `Agent名 · 目录`
2. 首发/新建任务：`buildConversationTitle` 截取用户 prompt（最多约 80 字）写入标题
3. 部分 Agent 通过 ACP `session` / `session_info_update` 回流 `title`
4. `shouldApplyAgentSessionTitle` 仅在「当前标题仍是默认 Agent 名」时才采用 Agent title

问题：首发很快把标题改成用户输入截取后，Agent 回流的总结标题通常进不来。

已有能力可复用：

- `electron/cli/acp.ts` 已解析 `result.title` / `session_info_update.title` 到 `kind: "session"` item
- `conversationHandlers.sessionTitleFromItems` 已能从 stream items 取 title
- `shouldApplyAgentSessionTitle` / `renameConversation` 已有覆盖路径

## 标题来源状态机

`conversations.title_source`：

| 值 | 含义 |
|----|------|
| `default` | 新建时的 Agent 默认标题 |
| `prompt` | 首发时用用户输入截取的临时标题 |
| `agent` | 已采用 ACP `session.title`，首轮锁定 |
| `user` | 用户手动改过，永不自动覆盖 |

### 转换规则

```
new conversation          → default
first send (still default) → prompt   (buildConversationTitle)
ACP session.title arrives
  and source ∈ {default, prompt} → agent
manual rename             → user
```

一旦进入 `agent` 或 `user`，自动标题逻辑不再修改。

## 应用时机

1. **发送时**：若 `titleSource === "default"`，用 `buildConversationTitle` 设临时标题，并标 `prompt`。
2. **流式过程中**：`items` 含 `session.title` / `session_info_update` 时，若来源是 `default|prompt`，立即 rename 为 Agent title，标 `agent`。
3. **首轮 done**：再结算一次，防止 title 只在收尾才到达。
4. **手动重命名**：`renameConversation` 同时写 `titleSource = "user"`。

## 数据模型

### DB

`conversations` 新增：

- `title_source TEXT`（`default` | `prompt` | `agent` | `user`）

迁移：`ALTER TABLE` 加列；`CREATE TABLE` 同步加入。

### 类型

```ts
type ConversationTitleSource = "default" | "prompt" | "agent" | "user";

interface Conversation {
  // ...
  titleSource?: ConversationTitleSource;
}
```

### 老数据兼容

无 `title_source` 时：

- 标题等于 `defaultTitleFor(agentName, cwd)` → 视为 `default`
- 否则视为 `prompt`（允许首轮仍可被 Agent title 覆盖一次）

## 代码落点

| 区域 | 文件 | 变更 |
|------|------|------|
| DB | `electron/cli/db.ts` | 加列 + 迁移 |
| CRUD | `electron/cli/conversations.ts` | 读写 `titleSource`；rename 可带 source |
| Types / IPC | `types.ts`, `ipc.ts`, `preload.ts`, `client.ts`, `freebuddy.d.ts` | 暴露字段与更新 |
| 规则 | `src/store/conversationUtils.ts` | 重写 `shouldApplyAgentSessionTitle` 基于 `titleSource` |
| 流式 | `src/store/conversationHandlers.ts` | 覆盖时同步 `titleSource=agent` |
| 发送 | `src/store/conversationStore.ts` / `ChatView.tsx` | 首发设 `prompt`；手动 rename 设 `user` |
| 测试 | `tests/*.mjs` | 覆盖状态机与覆盖条件 |

## 与现有逻辑的关系

- **保留** `buildConversationTitle` 作为无 Agent title 时的回退。
- **收紧** `shouldApplyAgentSessionTitle`：不再要求「当前必须是默认 Agent 名」；改为 `titleSource ∈ {default, prompt}`（含老数据推断）。
- **保留** workflow / `workflowRunId` 排除。
- **保留** `preserveConversationTitle`（Feed/Draft）不自动覆盖。
- **不新增** 隐藏总结 prompt。

## 边界情况

| 场景 | 行为 |
|------|------|
| Agent 提供 session.title | 首轮采用并锁定为 `agent` |
| Agent 不提供 title | 保留 `prompt` 截取标题 |
| Agent 多次推送不同 title | 仅第一次 `default/prompt → agent` 生效 |
| 用户手动改名 | `user`，之后忽略 Agent title |
| Team/workflow 会话 | 不自动套用 Agent session title |
| preserveConversationTitle | 不走自动覆盖 |
| 老会话无 title_source | 按标题推断；仍允许被 Agent title 覆盖一次 |

## 验收标准

1. 支持 `session.title` 的 Agent：首轮后侧边栏标题变为 Agent 总结，且后续自动逻辑不再改。
2. 不支持的 Agent：仍是用户输入截取标题。
3. 手动改名后，Agent 再推 title 也不覆盖。
4. 老会话无 `title_source` 时，首轮仍可被 Agent title 覆盖一次。
5. Feed/Draft / workflow 行为不回归。

## 测试计划

1. `shouldApplyAgentSessionTitle`：`default`/`prompt` 可覆盖；`agent`/`user` 不可。
2. 老数据推断：默认名 → `default`；其他 → `prompt`。
3. 流式收到 session title 后 rename + `titleSource=agent`。
4. 手动 rename 后 `titleSource=user`，后续 Agent title 被忽略。
5. workflow 消息存在时不覆盖。

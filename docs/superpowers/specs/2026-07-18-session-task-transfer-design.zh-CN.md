# 会话任务转接（Session Task Transfer）设计

## 目标

在 A agent 会话过程中，用户可一键将当前会话"转接"到一个新的 B agent 会话；B 继承 A 的上下文快照（任务目标、最近消息、文件改动等），从中段继续工作。

用户心智：

> 我用 Codex 聊到一半，点 ⇄，选 Claude，确认。新开的 Claude 会话就已经知道前面 Codex 做了什么——它能调一个工具读到结构化的交班 brief，然后接着干。

## 非目标

- **不做** A→B 的真实 session 协议续接（各 agent session 协议互不兼容，本质不可行）。
- **不做** A 的归档/只读化（A 照旧可写，B 是"另起一支"）。
- **不做** 持续共享记忆 / 双向同步（MCP 服务仅服务转接业务，不暴露 write）。
- **不做** 跨 agent 同任务横向对比（一次转接只产生一个 B）。
- **不做** A 端的转出标记（toast / banner / 反向跳转链接），MVP 仅在 B 端展示 origin badge。
- **不做** keyDecisions / openItems 等需要启发式推断的 brief 字段（做不准反而误导 B）。
- **不考虑** 非 ACP 适配器（目标 agent 全部支持 MCP）。
- **不做** 链式转接的递归 brief（B→C 时 C 的 brief 仅基于 B 的历史，A 的更早上下文不递归携带）。

## 已确认决策

| 决策点 | 选择 | 备注 |
|--------|------|------|
| 核心动机 | 中选按需换手 | A 做一段后用户主动让 B 接力 |
| 上下文传递架构 | app 提供 MCP 上下文服务 | 对标 Context7 模式，复刻现有 Skill MCP 模式 |
| Brief 生成方式 | app 自动抽取 | 不让 A 写、不需用户编辑，纯启发式 |
| A 会话命运 | 照旧可写 | A 不归档、不只读、不阻塞；B 是独立分支 |
| MCP 服务范围 | 仅转接业务 | 只读 brief + origin，不暴露 write |
| B 如何感知上下文 | MCP + prompt 引导（方案 C） | brief 存 MCP；composer 预填引导 prompt，用户回车才发 |

## 背景

FreeBuddy 是桌面端 CLI agent 工作台，并行托管 Codex / ClaudeCode / OpenCode / Cursor / Kimi / Qoder / CodeBuddy 等。每个会话绑定一个 agent，消息存 SQLite。已有 Workflow Teams 做预编排多 agent 协作（plan → implement → review → verify → summary），转接与它的本质差别：

| 维度 | Workflow Teams | 转接（本设计） |
|------|----------------|----------------|
| 触发 | 预定义模板、提前编排 | 运行时、用户临时发起 |
| 流程 | 多 agent 多步流水线 | 一次性 A→B 单跳 |
| 上下文 | 模板预设每步 prompt | app 抽取源会话历史 |

### 现有可复用模式

- **Skill MCP 模式**：`electron/mcp/skillMcpServer.ts` 是独立子进程 + manifest 文件 + env 传参；`electron/skillToolService.ts` 生成 `AcpStdioMcpServer` 描述符；`acpRuntime.ts` 在启动 agent 时 `mcpServers.push(...)` 注入。转接的 `freebuddy-context` MCP 完全复刻此模式。
- **Conversation 创建**：`cliClient.createConversation` → `electron/cli/conversations.ts:createConversation`，DB 表 `conversations` + `conversation_messages`。
- **消息流**：`conversationStore.sendMessage` 组装 `CliRunArgs` → ACP runtime 启动子进程；`acpRuntime.ts` 是 MCP 注入点。
- **DB 迁移**：`db.ts:migrate` 用 `PRAGMA table_info` 守卫 `ALTER TABLE ADD COLUMN`，幂等。
- **测试**：`node:test` + `assert/strict`，跑 `dist-electron/`；MCP 用 `InMemoryTransport`；wiring 用源码扫描（对标 `skills.test.mjs:61`）。

## 架构总览

转接 = 复制 A 当前消息历史 → app 自动抽取 brief 存 DB → 新建会话 B（带 origin 元数据）→ 注册 `freebuddy-context` MCP 服务（brief 通过 manifest 文件喂给子进程，复刻 Skill 模式）→ B 的 composer 预填引导 prompt（不自动发送，等用户回车）。

### 新增模块

| 层 | 新增文件 | 对标已有 |
|----|---------|----------|
| MCP 服务 | `electron/mcp/contextMcpServer.ts` | `skillMcpServer.ts` |
| 工具注册 | `electron/contextToolService.ts` | `skillToolService.ts` |
| DB 层 | `electron/cli/handoffBriefs.ts`（新表） | `conversations.ts` |
| Brief 抽取 | `electron/cli/handoffBriefExtractor.ts`（纯函数） | `conversationUtils.ts` |
| IPC | `cli:transferConversation` | `cli:createConversation` |
| Store | `conversationStore.transferConversation` | `newConversation` |
| UI | `TransferDialog` + composer-context-row 按钮 + origin badge | `newTaskUiStore` |

### 数据流

```
[用户在 A 点 ⇄]
      ↓
[TransferDialog: 选 B agent / cwd / 预览 brief]
      ↓ confirm
[main: listMessages(A) → extractBrief → 存 handoff_briefs
       → createConversation(B, origin=A) → 返回 B + seedPrompt]
      ↓
[renderer: 切到 B + composer 预填 seedPrompt（不发送）]
      ↓ 用户回车
[sendMessage: 若发现 conv.originBriefId 且 B 首条未发 → 从 DB 重读 brief
       → registerContextToolSession 注入 freebuddy-context 到 mcpServers]
      ↓
[B agent 启动, 调 read_handoff_brief → 拿到上下文]
```

A 完全不变，B 顶部展示"继承自 {A agentName}"badge。链式转接 B→C 天然支持（B 也是普通会话）。

## 数据模型

### 新表 `handoff_briefs`

```sql
CREATE TABLE IF NOT EXISTS handoff_briefs (
  id                       TEXT PRIMARY KEY,
  source_conversation_id   TEXT NOT NULL,
  target_conversation_id   TEXT NOT NULL,
  source_agent_id          TEXT NOT NULL,
  source_agent_name        TEXT NOT NULL,
  source_adapter           TEXT NOT NULL,
  brief_json               TEXT NOT NULL,
  source_message_count     INTEGER NOT NULL,
  source_last_message_id   TEXT,
  created_at               TEXT NOT NULL,
  FOREIGN KEY(source_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(target_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_handoff_briefs_target
  ON handoff_briefs(target_conversation_id);
CREATE INDEX IF NOT EXISTS idx_handoff_briefs_source
  ON handoff_briefs(source_conversation_id, created_at DESC);
```

### `conversations` 新增列

用现有 PRAGMA-guarded ALTER 模式（见 `db.ts:migrate`）：

```sql
ALTER TABLE conversations ADD COLUMN origin_conversation_id TEXT;
ALTER TABLE conversations ADD COLUMN origin_agent_id        TEXT;
ALTER TABLE conversations ADD COLUMN origin_agent_name      TEXT;
ALTER TABLE conversations ADD COLUMN origin_adapter         TEXT;
ALTER TABLE conversations ADD COLUMN origin_brief_id        TEXT;
```

source/target 都用 CASCADE：A 删了 brief 也清，B 删了 brief 也清。`origin_*` 是冗余便利字段（避免每次 JOIN），值与 `handoff_briefs.source_*` 一致。

### `HandoffBrief` 结构（存进 `brief_json`）

```typescript
export interface HandoffBriefFileChange {
  path: string;
  action: "edit" | "create" | "delete" | "read" | string;
  toolName?: string;
}

export interface HandoffBriefMessageRef {
  messageId: string;
  role: "user" | "assistant";
  createdAt: string;
  excerpt: string;
}

export interface HandoffBrief {
  version: 1;
  generatedAt: string;
  source: {
    conversationId: string;
    agentId: string;
    agentName: string;
    adapter: string;
    title: string;
    cwd?: string;
    messageCount: number;
  };
  originalGoal: string;
  recentUserMessages: string[];
  lastAssistantSummary: string;
  fileChanges: HandoffBriefFileChange[];
  transcriptExcerpts: HandoffBriefMessageRef[];
}
```

### `Conversation` 接口扩展

`src/services/cli/types.ts` 与 `electron/cli/conversations.ts` 同步加：

```typescript
export interface Conversation {
  // ...原字段 ...
  originConversationId?: string;
  originAgentId?: string;
  originAgentName?: string;
  originAdapter?: string;
  originBriefId?: string;
}
```

### Brief 总体硬上限

`brief_json` 序列化后 > 64 KB 时，extractor 进一步裁剪。64 KB 也是 MCP 工具返回时的兜底校验。

## MCP 服务接口

完全复刻 `skillMcpServer` 模式：独立子进程 + manifest 文件 + env 传参。

### Manifest 文件（per task session）

路径：`{getDataDir()}/context-sessions/{taskSessionId}.json`

```json
{
  "version": 1,
  "brief": { "/* HandoffBrief 完整对象 */": "..." },
  "briefId": "abc123",
  "source": {
    "conversationId": "...",
    "agentId": "...",
    "agentName": "Codex",
    "adapter": "codex",
    "title": "..."
  }
}
```

mode `0o600`（与 skill 一致）。会话结束/进程退出时清理（`unregisterContextToolSession`）。

### `contextMcpServer.ts`

```typescript
export function createContextMcpServer(): McpServer {
  const manifest = loadManifest();   // 读 FREEBUDDY_HANDOFF_MANIFEST
  const server = new McpServer({
    name: "freebuddy-context",
    version: process.env.FB_APP_VERSION || "0.1.0"
  });

  server.registerTool(
    "read_handoff_brief",
    {
      title: "Read Handoff Brief",
      description:
        "Load the structured handoff brief for this FreeBuddy conversation, " +
        "if it was transferred from another agent. Returns origin metadata, " +
        "the original goal, recent messages, and file changes from the " +
        "previous agent. Returns an empty result if no handoff exists.",
      inputSchema: {
        format: z.enum(["full", "compact"]).default("full").optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ format } = {}) => {
      if (!manifest) return emptyResult("No handoff brief for this session");
      const brief = format === "compact" ? toCompact(manifest.brief) : manifest.brief;
      return result(JSON.stringify(brief, null, 2), { brief, source: manifest.source });
    }
  );

  server.registerTool(
    "get_handoff_origin",
    {
      title: "Get Handoff Origin",
      description:
        "Return only the originating agent metadata for this conversation " +
        "(agent name, adapter, conversation id, title). Cheaper than " +
        "read_handoff_brief when you just need to know where this came from.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => manifest
      ? result(JSON.stringify(manifest.source, null, 2), { source: manifest.source })
      : emptyResult("No handoff origin for this session")
  );

  return server;
}
```

### `contextToolService.ts`

```typescript
export function registerContextToolSession(
  taskSessionId: string,
  brief: HandoffBrief,
  briefId: string,
  source: {
    conversationId: string;
    agentId: string;
    agentName: string;
    adapter: string;
    title: string;
  }
): AcpStdioMcpServer {
  unregisterContextToolSession(taskSessionId);
  const directory = path.join(getDataDir(), "context-sessions");
  fs.mkdirSync(directory, { recursive: true });
  const manifest = path.join(directory, `${taskSessionId}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, brief, briefId, source }), {
    encoding: "utf8",
    mode: 0o600
  });
  manifests.set(taskSessionId, manifest);
  return {
    name: "freebuddy-context",
    command: process.execPath,
    args: [serverPath()],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "FREEBUDDY_HANDOFF_MANIFEST", value: manifest },
      { name: "FB_APP_VERSION", value: process.env.FB_APP_VERSION || "0.1.0" }
    ]
  };
}

export function unregisterContextToolSession(taskSessionId: string): void {
  // 同 skill：删 manifest 文件 + Map 清理
}
```

### 注入点（`acpRuntime.ts`）

```typescript
if (args.handoffBrief) {
  mcpServers.push(registerContextToolSession(
    args.sessionId,
    args.handoffBrief,
    args.handoffBriefId,
    args.handoffSource
  ));
}
```

`CliRunArgs` 新增可选字段：`handoffBrief?`, `handoffBriefId?`, `handoffSource?`。

### Compact 格式

`toCompact(brief)` 输出仅含 `originalGoal / recentUserMessages / fileChanges.path[]` 的精简版，供多轮后只想再扫一眼的 B 使用。

### 错误语义

- manifest 缺失/损坏 → 工具返回非错误 `{ content: "No handoff brief for this session" }`，避免 B 误以为调用失败而卡住。
- brief 超 64 KB → server 启动前由 extractor 已裁剪；server 自身只读取不裁剪。

## Brief 抽取算法

`extractHandoffBrief` 是纯函数。位置：`electron/cli/handoffBriefExtractor.ts`。

### 签名

```typescript
export interface ExtractInput {
  conversation: Conversation;
  messages: ConversationMessage[];
}
export function extractHandoffBrief(input: ExtractInput): HandoffBrief;
```

### 各字段算法

| 字段 | 算法 |
|------|------|
| `source.*` | 来自 `conversation.{id, agentId, agentName, adapter, title, cwd}`；`messageCount = messages.length` |
| `originalGoal` | 最早的 `role==="user"` 消息，`content` 原文，trim 后截 **2000 chars**；没有则 `""` |
| `recentUserMessages` | 末尾 ≤ 3 条 user 消息，每条 trim 后截 **800 chars**；不含首条（避免与 originalGoal 重复） |
| `lastAssistantSummary` | 末条 assistant 消息，解析 `content` 为 `CliStreamItem[]`，concat 所有 `kind==="text"` 的 `content`，trim 后截 **2000 chars**；无则 `""` |
| `fileChanges` | 见下文 |
| `transcriptExcerpts` | 末尾 ≤ 8 条消息（user+assistant，跳过 system），逐条生成 `{messageId, role, createdAt, excerpt}`：user → `content` 截 800；assistant → 解析后取 text 段截 800；无 text 段则 `"(tool calls only)"` |
| `generatedAt` | `new Date().toISOString()` |

### `fileChanges` 抽取

遍历**所有 assistant 消息**，解析 `CliStreamItem[]`，收集：

1. `kind === "file-edit"` → `{ path, action: file-edit.action, toolName: undefined }`
2. `kind === "tool-call"` 且满足下列任一：
   - `toolKind` ∈ `["edit", "delete", "read"]`
   - `tool` 名匹配白名单：`apply_patch | write | edit | update | str_replace | create_file | edit_file | multi_edit | read_file`

   → 对每个 `locations[].path` 产出一个 entry，`action` 从 `toolKind` 推断（`toolKind==="read"` → `"read"`，`"delete"` → `"delete"`，否则 `"edit"`），`toolName = item.tool`

**去重**：按 `path` 去重，**保留最新**（消息从早到晚遍历，后写覆盖前写）。`action==="read"` 永远不覆盖非 read（read 是次要信息）。

**排序**：按出现顺序倒序（最近改动排前）。

**上限**：≤ 50 条；超出按"非 read 优先于 read、最近优先于较早"裁剪。

### 总体裁剪（64 KB 上限）

序列化后若 > 64 KB，按以下顺序裁剪，每步重新测量直至达标：

1. `transcriptExcerpts` 从 8 → 4 → 2 → 0
2. `fileChanges` 从 50 → 25 → 10（保留非 read）
3. `recentUserMessages` 从 3 → 2 → 1
4. `lastAssistantSummary` 截到 1000 → 500 → 200
5. `originalGoal` 截到 500

最坏情况（all empty）远小于 64 KB，循环必终止。

### 边界

- 0 条消息 → 仍生成 brief（全空字段），不阻塞流程
- 只有 user 消息（A 还没回）→ `lastAssistantSummary=""`，其余正常
- `content` 解析失败（脏数据）→ 该消息跳过，记 warn 日志，不抛异常
- A 的 `thinking` / `usage` / `error` / `command` 等 stream item 不进入 brief（噪声）

## UI 流程

### 转接触发入口

**主入口**：`ChatView.tsx` 的 `.composer-context-row`（显示 agent 名 + cwd 那一行）右侧新增图标按钮 `⇄ Transfer`（lucide `ArrowLeftRight` 或 `Shuffle`）。语义贴合"针对当前会话操作"。

**辅入口**（可选）：`ConversationList` 行 hover 出的 actions 里加 `Transfer`（与现有删除按钮并排）。

**禁用条件**：无（即使 A 正在 streaming 也允许；in-flight 消息不计入 brief，brief 仅基于已落库消息）。

### `TransferDialog`

```
┌── Transfer conversation ─────────────────────────┐
│  Hand off "实现登录页" from Codex to another agent │
│                                                   │
│  Target agent:   [ Claude ▾ ]   (Codex 灰掉)      │
│  Workspace:      [ /Users/.../freebuddy ]         │
│                                                   │
│  ▼ Preview handoff brief (read-only)              │
│    • Original goal: 实现 login 页面...             │
│    • Recent: 改用 JWT / 加 loading 状态           │
│    • Files changed (12): src/login.tsx, ...        │
│    • Last assistant: 已完成表单校验，待...         │
│                                                   │
│            [ Cancel ]   [ Transfer → ]            │
└───────────────────────────────────────────────────┘
```

- **目标 agent**：复用 `AgentPicker` 数据源（`useConversationStore.members`），把 A 的 `agentId` 设 disabled
- **cwd**：默认 `conv.cwd`，可改（自由文本 + 工作区选择器，复用现有 new task 的 cwd 输入）
- **brief 预览**：dialog 挂载时调用 `cliClient.previewHandoffBrief(sourceConvId)` → 返回 `HandoffBrief`；折叠默认 collapsed，展开后只读显示
- **Confirm** 禁用条件：目标 agent 未选；cwd 与 A 不同时弹一个轻量 confirm（"workspace 不一致，B 看不到 A 改过的文件，确定？"）

### 主流程时序

```
1. 点 ⇄ → 打开 TransferDialog
2. dialog didMount → cliClient.previewHandoffBrief(A.id) → 展示 brief
3. 用户选 B agent、调 cwd、点 Transfer
4. renderer: conversationStore.transferConversation({
     sourceConversationId: A.id,
     targetMemberId: B.memberId,
     cwd
   })
5. store → cliClient.transferConversation(...)
6. main 进程（transaction 内，预先生成 briefId + B.id）:
   a. msgs = listMessages(A.id)
   b. brief = extractHandoffBrief({ conversation: A, messages: msgs })
   c. briefId = nanoid(); B.id 已由调用方生成
   d. insertHandoffBrief({ id: briefId, source: A, targetId: B.id, brief, ... })
   e. createConversation({ id: B.id, ..., originConversationId: A.id, originBriefId: briefId, ... })
   f. 返回 { conversation: B, briefId, seedPrompt }
7. store:
   a. B 加入 conversations，设为 activeId
   b. ChatView 监测到 activeId 变化 + 新 conv 有 originBriefId → 把 seedPrompt 灌进 composer textarea（不发送）
8. 用户回车 → sendMessage 正常流程
9. sendMessage 内部：若 conv.originBriefId 存在且 B 还没有 assistant 消息 → 从 DB 重读 brief
   → CliRunArgs 附带 handoffBrief / handoffBriefId / handoffSource
   → registerContextToolSession 注入 MCP
```

**id 生成约定**：`transferConversation` 的 input 必须包含 `targetConversationId`（renderer 用 `nanoid()` 生成）；main 用 `nanoid()` 生成 `briefId`。这样在事务内先插 brief（target_id 已知）再插 conversation（origin_brief_id 已知），双方 NOT NULL 约束都满足，无需 UPDATE 补数据。

### Seed prompt 模板

i18n 化，默认英文：

```
Continuing a task transferred from {A.agentName} ({A.adapter}).
Call the `freebuddy-context.read_handoff_brief` tool now to load the
handoff (original goal, recent messages, file changes), then ask me
what you'd like to focus on first.
```

放在 composer 里作为**可编辑**初始 draft——用户可删、改、补充（比如 "focus on the failing tests"）再回车。

### B 端 origin badge

`ChatView` 顶部 `composer-context-row`（或紧贴其上）显示一个轻量 badge：

```
⇄ 继承自 Codex · 实现登录页   [→]
```

- 点击 `[→]`：`setActive(A.id)` 跳回 A
- 数据源：`conv.originConversationId` / `originAgentName`
- 仅当 `originBriefId` 存在时渲染

### A 端不做主动标记

依"A 照旧可写"。MVP 不加任何 A-side banner / link / toast。后续可加轻 toast"已转接到 Claude"，不在本期范围。

### 链式转接 B→C

天然工作：B 也是普通会话，可再次点 ⇄。**已知限制**：C 的 brief 仅基于 B 的消息历史，A 的更早上下文不递归携带——MVP 取舍（避免 brief 膨胀 + 实现简单）。

## 错误处理 & 边界

### 转接原子性

`transferConversation` IPC 在 main 进程内包一个 DB transaction。`targetConversationId` 由 renderer 传入，`briefId` 在事务内 `nanoid()` 生成；事务顺序保证两个 NOT NULL 外键（`handoff_briefs.target_conversation_id` 与 `conversations.origin_brief_id`）都能正确写入：

```ts
db.transaction(() => {
  const brief = extractOrCatch(A, msgs);     // 容错抽取，可能返回 null
  const briefId = brief ? nanoid() : null;
  if (brief) {
    insertHandoffBrief({
      id: briefId,
      sourceConversationId: A.id,
      targetConversationId: input.targetConversationId,
      brief, /* ... */
    });
  }
  const conv = createConversation({
    id: input.targetConversationId,
    ..., 
    originConversationId: A.id,
    originAgentId: A.agentId,
    originAgentName: A.agentName,
    originAdapter: A.adapter,
    originBriefId: briefId  // null 时不写入（列允许 NULL）
  });
  return { conv, briefId, warning: brief ? null : "brief_extraction_failed" };
})();
```

任一步失败 → 全部回滚，renderer 弹 toast `"Transfer failed: {reason}"`，A 和列表状态不变。

### 崩溃恢复（pendingHandoff 持久化）

**问题**：转接后 → app 重启 → 用户没回车 → 内存里 pendingHandoff 丢了 → B 启动时 MCP 不会注入。

**方案**：不另开持久化，改为**懒恢复**：

- B 的 `originBriefId` 已在 conversations 表里（持久化）
- `sendMessage` 时检查：若 conv 有 `originBriefId` **且 B 还没有 assistant 消息**（说明首条还没发）→ 从 DB 重读 brief → 注入 MCP

无需新表/新字段，零额外持久化状态。

### Brief 抽取容错

extractor 全防御：

- 单条 message 的 `content` JSON.parse 失败 → 跳过该条，记 `console.warn`，继续
- `fileChanges` 项 path 为空/非字符串 → 跳过
- 任何 stream item 字段类型异常 → 跳过该项
- 整体 try/catch 兜底：万一 extractor 整体抛 → 在 `transferConversation` 里捕获 → **brief 不入库、`originBriefId` 不写入 B**，事务返回 `warning: "brief_extraction_failed"` → renderer toast 提示"B 已创建但未携带上下文，请手动告知"。B 此时没有 originBriefId，行为等同于普通新会话（无 badge、无懒恢复、无 MCP 注入）

不会因为抽取失败阻塞转接。

### MCP 服务端失败

| 情况 | 行为 |
|------|------|
| manifest 文件缺失/损坏 | 工具返回非错误 `"No handoff brief for this session"`，B 正常继续 |
| MCP 子进程启动失败 | 沿用现有 Skill/Draft MCP 的依赖与降级；ACP 启动会报 MCP server error，B 仍可工作只是无 brief 可读。renderer 不额外告警 |
| B 不调用 `read_handoff_brief` | seed prompt 已强引导；agent 仍忽略时无能为力，属 agent 行为 |

### Dialog preview 失败

`previewHandoffBrief` 调用失败 → dialog 顶部显示橙色 banner `"Brief preview unavailable. You can still transfer."`，Confirm 按钮保持可用。失败本身不影响转接（抽取在 main 端会重跑一次）。

### A 在转接后被删除

- `handoff_briefs.source_conversation_id` CASCADE → A 删时 brief 行一起删
- B 的 `originConversationId` / `originBriefId` 冗余字段仍保留（用于 badge 显示和懒恢复判定）
- B 已生成的 manifest 是 transfer 那刻的快照，独立于 DB——A 删除不影响 B 当次会话读 brief
- B 端 origin badge 点击跳回 A → `getConversation(A.id)` 返回 undefined → store 把 activeId 设为 undefined（回到 new task 主屏），不报错

### A 正在 streaming 时转接

- 允许；brief 基于 `listMessages(A.id)`，in-flight 那条 assistant 消息要么没入库要么 status=`running` 且 content 可能不完整
- extractor 对 `status !== "done"|"sent"` 的 assistant 消息：**跳过 content 解析**，只在 `transcriptExcerpts` 里记 `"(streaming)"` 占位
- B 启动后看到的 brief 反映"截至上次完成的轮次"——符合直觉

### 空 / 极小源会话

| 场景 | 行为 |
|------|------|
| A 0 条消息 | brief 全空字段；B 创建成功；seed prompt 改为 `"No prior context available from {A}. ..."`（i18n 模板分支） |
| A 仅 1 条 user 消息 | `lastAssistantSummary=""`；其余正常 |
| A 全是 system 消息（异常） | originalGoal / recentUserMessages 为空；不阻塞 |

### 长会话性能

- extractor 全程 O(n)，n=消息数
- 1000 条消息实测目标 < 100ms（仅扫描，无 IO）
- 若将来需要优化：仅扫首条 user + 末尾 N 条 + 全量 file-edit 扫描。MVP 不做。

### 并发与去重

- 同一个 A 快速连续转接到 B1、B2 → 各自独立 snapshot，互不影响
- store 内 `transferConversation` 加一个 in-flight 锁（同 `newTaskSendLock` 模式），防止双击重复触发

### 安全

- manifest 文件 mode `0o600`，路径在 `getDataDir()` 内（与 skill 一致）
- MCP 子进程仅读 manifest，无网络、无其他 FS 访问
- brief 内容敏感度 = 现有 `conversation_messages` 表（无新增攻击面）

## 测试策略

测试惯例：`node:test` + `assert/strict` + 跑 `dist-electron/`；MCP 用 `InMemoryTransport`；wiring 用源码扫描（对标 `skills.test.mjs:61`）。

### 新增测试文件

| 文件 | 类型 | 对标 |
|------|------|------|
| `tests/handoff-brief-extractor.test.mjs` | 纯函数单测 | `conversation-utils.test.mjs` |
| `tests/handoff-context-mcp.test.mjs` | MCP in-memory | `draft-mcp.test.mjs` |
| `tests/handoff-brief-db.test.mjs` | DB 层（in-memory better-sqlite3） | `attachments-integration.test.mjs` |
| `tests/handoff-transfer-wiring.test.mjs` | 源码扫描 wiring | `skills.test.mjs:61` |

### `handoff-brief-extractor.test.mjs` 覆盖

- `originalGoal`: 取首条 user，trim+截 2000
- `originalGoal`: 没 user 消息时为 ""
- `recentUserMessages`: 末尾 ≤ 3 条，跳过首条
- `recentUserMessages`: 各截 800
- `lastAssistantSummary`: 解析末条 assistant 的 text stream items，截 2000
- `lastAssistantSummary`: 末条 assistant 没 text 段（纯工具调用）→ ""
- `fileChanges`: 从 file-edit 项抽取
- `fileChanges`: 从 tool-call 项抽取（toolKind 白名单 + tool 名白名单）
- `fileChanges`: 同路径去重，后写覆盖前写
- `fileChanges`: read 不覆盖 edit
- `fileChanges`: 上限 50，超出按非 read 优先 + 最近优先裁剪
- `fileChanges`: path 非字符串/空 → 跳过
- `transcriptExcerpts`: 末尾 ≤ 8 条，各截 800
- `transcriptExcerpts`: assistant 无 text 段 → "(tool calls only)"
- 64 KB 裁剪顺序：transcriptExcerpts → fileChanges → recentUserMessages → lastAssistantSummary → originalGoal
- 0 条消息 → 全空字段，不抛
- content JSON.parse 失败 → 跳过该条，不抛
- status="running" 的 assistant → content 不解析，transcriptExcerpts 记 "(streaming)"
- `source.{agentId,title,cwd,messageCount}` 正确填充

### `handoff-context-mcp.test.mjs` 覆盖

用 `InMemoryTransport` 连 server：

- `listTools` 返回 `read_handoff_brief` + `get_handoff_origin`，schema 含 format
- `read_handoff_brief` (format=full)：返回完整 brief + structuredContent
- `read_handoff_brief` (format=compact)：返回精简版
- `read_handoff_brief`：manifest 缺失 → 非错误 "No handoff brief..."
- `read_handoff_brief`：manifest 文件损坏 → 非错误
- `get_handoff_origin`：返回仅 source 元数据
- `get_handoff_origin`：manifest 缺失 → 非错误
- structuredContent 与 content JSON 一致

### `handoff-brief-db.test.mjs` 覆盖

- `insertHandoffBrief` + `getHandoffBriefByTarget` 往返
- `getHandoffBriefsBySource` 返回某 A 的所有 brief（按 created_at DESC）
- CASCADE：删 target conversation → brief 一起删
- CASCADE：删 source conversation → brief 一起删
- `conversations.origin_*` 列读写正常
- migration 幂等（老库无 origin_* 列 → ALTER 后存在）

### `handoff-transfer-wiring.test.mjs` 覆盖

源码扫描保证各层串联：

- `db.ts`: `CREATE TABLE IF NOT EXISTS handoff_briefs`
- `db.ts`: `ALTER TABLE conversations ADD COLUMN origin_conversation_id`（受 PRAGMA 保护）
- `conversations.ts`: `rowToConversation` 映射 origin_* 字段
- `conversations.ts`: `createConversation` 接收并写入 origin_* 参数
- `handoffBriefs.ts`: 导出 `insertHandoffBrief` / `getHandoffBriefByTarget`
- `handoffBriefExtractor.ts`: 导出 `extractHandoffBrief`
- `contextToolService.ts`: 导出 `registerContextToolSession` / `unregister`
- `acpRuntime.ts`: 当 `args.handoffBrief` 存在时调用 `registerContextToolSession`
- `ipc.ts`: `cli:transferConversation` handler
- `ipc.ts`: `cli:previewHandoffBrief` handler
- `preload.ts`: `cliClient.transferConversation` 暴露
- `preload.ts`: `cliClient.previewHandoffBrief` 暴露
- `conversationStore.ts`: `transferConversation` action 调用 `cliClient.transferConversation`

### 不在 MVP 测试范围

- 端到端 renderer 流程（点按钮 → dialog → confirm → B 创建 → composer 预填）：现有 FreeBuddy 测试基础设施没渲染层 E2E，沿用现状不补
- 真实 ACP agent 调用 MCP：需真实 agent binary，CI 不可行；MCP server 本身被 `handoff-context-mcp.test.mjs` 覆盖

### CI 集成

新增 4 个 `.mjs` 自动被 `node --test tests/*.mjs` 捡起，无需改 `package.json`。

## 验证（Verification）

实现完成的判据：

- `npm run typecheck` 通过
- `npm run build:electron` 通过（`dist-electron/` 生成）
- `npm test` 全绿（73 + 4 新增 = 77 个测试文件全过）
- 手工 smoke：`npm run dev` 模式跑通"A→B 转接、B 调 `read_handoff_brief` 看到内容、origin badge 显示、点击跳回 A"

## 未决事项

无。所有关键设计点已在 brainstorming 阶段对齐。

## 后续可选增强（不在本期）

- A 端转出 toast 提示
- 链式转接递归 brief（C 看到 A+B 合并历史）
- `write_note` MCP 工具让 A/B 双向共享任务记忆（超出"仅转接业务"）
- Brief `keyDecisions` / `openItems` 字段（需启发式推断，做准后再加）
- Transfer 触发更精细的"从某条消息开始转接"（per-message 起点）

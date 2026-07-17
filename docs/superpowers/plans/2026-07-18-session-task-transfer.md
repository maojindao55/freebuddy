# 会话任务转接（Session Task Transfer）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现在 A agent 会话中一键转接到新 B agent 会话；B 通过 `freebuddy-context` MCP 服务读取 app 自动抽取的 handoff brief，继承 A 的上下文快照继续工作。

**Architecture:** 复刻现有 Skill MCP 模式（独立子进程 + manifest 文件 + env 传参）。转接 = 抽取 A 历史 → 生成 brief 入库 → 新建带 origin 元数据的 B 会话 → 用户回车首条 prompt 时懒注入 MCP server。A 完全不变。

**Tech Stack:** Electron + React 19 + TypeScript + better-sqlite3 + @modelcontextprotocol/sdk + zustand + node:test。

**Spec:** `docs/superpowers/specs/2026-07-18-session-task-transfer-design.zh-CN.md`

---

## 文件结构

### 新建

| 文件 | 职责 |
|------|------|
| `electron/cli/handoffBriefs.ts` | `handoff_briefs` 表的 CRUD（纯 DB 层） |
| `electron/cli/handoffBriefExtractor.ts` | 纯函数：`Conversation + Message[] → HandoffBrief` |
| `electron/contextToolService.ts` | 写 per-task manifest 文件，返回 `AcpStdioMcpServer` 描述符 |
| `electron/mcp/contextMcpServer.ts` | 独立子进程，暴露 `read_handoff_brief` / `get_handoff_origin` 工具 |
| `src/components/CLI/TransferDialog.tsx` | 转接对话框组件 |
| `tests/handoff-brief-extractor.test.mjs` | extractor 单测 |
| `tests/handoff-context-mcp.test.mjs` | MCP server in-memory 测试 |
| `tests/handoff-brief-db.test.mjs` | DB 层测试 |
| `tests/handoff-transfer-wiring.test.mjs` | 源码扫描 wiring |

### 修改

| 文件 | 改动 |
|------|------|
| `electron/cli/db.ts` | 新表 + ALTER `conversations` 加 5 个 `source_*` 列 |
| `electron/cli/conversations.ts` | `rowToConversation` + `createConversation` 支持 origin 字段 |
| `electron/cli/ipc.ts` | `cli:previewHandoffBrief` + `cli:transferConversation` handler |
| `electron/preload.ts` | 暴露两个新方法 |
| `electron/cli/acpRuntime.ts` | `args.handoffBrief` 存在时 push context MCP server |
| `src/services/cli/types.ts` | `Conversation` 加 origin 字段；`CliRunArgs` 加 handoff 字段；新 `HandoffBrief` 等接口 |
| `src/services/cli/client.ts` | 加 `previewHandoffBrief` / `transferConversation` |
| `src/types/freebuddy.d.ts` | 同步 preload 类型 |
| `src/store/conversationStore.ts` | 加 `transferConversation` action；`sendMessage` 加懒恢复 |
| `src/components/CLI/ChatView.tsx` | composer-context-row 加 ⇄ 按钮；origin badge；composer prefill |
| `src/i18n/en.json` / `zh-CN.json` | 新 i18n key |

---

## 任务依赖图

```
Task 1 (types) ─┬─→ Task 3 (DB layer) ──→ Task 5 (extractor)
Task 2 (migration) ┘                       │
                                           ↓
Task 4 (conv origin)              Task 6 (toolService) ─→ Task 7 (MCP server)
                                                              │
                                                              ↓
                                                       Task 8 (acpRuntime)
                                                              │
Task 9 (IPC + preload) ←──────────────────────────────────────┘
        │
        ↓
Task 10 (store action)
Task 11 (sendMessage lazy recovery)
        │
        ↓
Task 12 (TransferDialog)
Task 13 (ChatView integration)
Task 14 (i18n)
        │
        ↓
Task 15 (verification)
```

---

## Task 1: 添加类型定义

**Files:**
- Modify: `src/services/cli/types.ts`

- [ ] **Step 1: 在 `src/services/cli/types.ts` 末尾追加类型**

```typescript
// ---- Handoff Brief -------------------------------------------------------

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

export interface HandoffBriefSource {
  conversationId: string;
  agentId: string;
  agentName: string;
  adapter: string;
  title: string;
  cwd?: string;
  messageCount: number;
}

export interface HandoffBrief {
  version: 1;
  generatedAt: string;
  source: HandoffBriefSource;
  originalGoal: string;
  recentUserMessages: string[];
  lastAssistantSummary: string;
  fileChanges: HandoffBriefFileChange[];
  transcriptExcerpts: HandoffBriefMessageRef[];
}

export interface HandoffBriefRow {
  id: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceAgentId: string;
  sourceAgentName: string;
  sourceAdapter: string;
  brief: HandoffBrief | null;
  sourceMessageCount: number;
  sourceLastMessageId?: string;
  createdAt: string;
}

export interface PreviewHandoffBriefInput {
  sourceConversationId: string;
}

export interface PreviewHandoffBriefResult {
  brief: HandoffBrief | null;
  warning?: "brief_extraction_failed";
}

export interface TransferConversationInput {
  sourceConversationId: string;
  targetConversationId: string;
  targetMemberId: string;
  cwd?: string;
}

export interface TransferConversationResult {
  conversation: Conversation;
  briefId: string | null;
  seedPrompt: string;
  warning?: "brief_extraction_failed";
}
```

- [ ] **Step 2: 在 `Conversation` 接口里追加 source 字段**

定位 `src/services/cli/types.ts` 里 `export interface Conversation {` 块，在 `lastMessageAt?: string;` 之后追加：

```typescript
  sourceConversationId?: string;
  sourceAgentId?: string;
  sourceAgentName?: string;
  sourceAdapter?: string;
  sourceBriefId?: string;
```

- [ ] **Step 3: 在 `CliRunArgs` 接口里追加 handoff 字段**

定位 `src/services/cli/types.ts` 里 `export interface CliRunArgs {` 块，在 `announceSkills?: boolean;` 之后追加：

```typescript
  handoffBrief?: HandoffBrief;
  handoffBriefId?: string;
```

（不单独定义 `handoffSource` —— 消费方从 `handoffBrief.source` 读取，避免冗余字段。）

- [ ] **Step 4: 类型检查通过**

Run: `npm run typecheck`
Expected: 通过（新类型未被引用时 TS 不会报错）

- [ ] **Step 5: Commit**

```bash
git add src/services/cli/types.ts
git commit -m "feat(handoff): add type definitions for transfer feature"
```

---

## Task 2: DB migration（新表 + ALTER 列）

**Files:**
- Modify: `electron/cli/db.ts`
- Test: `tests/handoff-transfer-wiring.test.mjs`

- [ ] **Step 1: 先写 wiring 测试（必然会失败）**

Create `tests/handoff-transfer-wiring.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) =>
  fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("db.ts declares handoff_briefs table and source_* columns", () => {
  const db = read("electron/cli/db.ts");
  assert.match(db, /CREATE TABLE IF NOT EXISTS handoff_briefs/);
  assert.match(db, /ALTER TABLE conversations ADD COLUMN source_conversation_id/);
  assert.match(db, /ADD COLUMN source_brief_id/);
  assert.match(db, /FOREIGN KEY\(source_conversation_id\) REFERENCES conversations/);
  assert.match(db, /FOREIGN KEY\(target_conversation_id\) REFERENCES conversations/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: FAIL（`CREATE TABLE IF NOT EXISTS handoff_briefs` 未匹配）

- [ ] **Step 3: 在 `electron/cli/db.ts` 的 `migrate()` 里加表**

定位 `db.ts` 里 `CREATE TABLE IF NOT EXISTS scheduled_task_runs` 块之后（`db.exec(\`` 的反引号闭合前）追加：

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

- [ ] **Step 4: 在 `migrate()` 末尾（最后一个 `if (!currentScheduledTaskCols...)` 块之后）加 ALTER 守卫**

```typescript
  const handoffConvCols = db
    .prepare("PRAGMA table_info(conversations)")
    .all() as Array<{ name: string }>;
  if (!handoffConvCols.some((c) => c.name === "source_conversation_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_conversation_id TEXT");
  }
  if (!handoffConvCols.some((c) => c.name === "source_agent_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_agent_id TEXT");
  }
  if (!handoffConvCols.some((c) => c.name === "source_agent_name")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_agent_name TEXT");
  }
  if (!handoffConvCols.some((c) => c.name === "source_adapter")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_adapter TEXT");
  }
  if (!handoffConvCols.some((c) => c.name === "source_brief_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN source_brief_id TEXT");
  }
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add electron/cli/db.ts tests/handoff-transfer-wiring.test.mjs
git commit -m "feat(handoff): add handoff_briefs table and source_* columns"
```

---

## Task 3: handoffBriefs.ts DB 层

**Files:**
- Create: `electron/cli/handoffBriefs.ts`
- Test: `tests/handoff-brief-db.test.mjs`

- [ ] **Step 1: 先写 DB 测试**

Create `tests/handoff-brief-db.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

// 复刻 db.ts 的 schema 子集，建内存库
function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      adapter TEXT NOT NULL,
      cwd TEXT,
      approval_mode TEXT,
      config_option_overrides TEXT,
      skill_snapshot TEXT,
      title_source TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT,
      source_conversation_id TEXT,
      source_agent_id TEXT,
      source_agent_name TEXT,
      source_adapter TEXT,
      source_brief_id TEXT
    );
    CREATE TABLE handoff_briefs (
      id TEXT PRIMARY KEY,
      source_conversation_id TEXT NOT NULL,
      target_conversation_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      source_agent_name TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      source_message_count INTEGER NOT NULL,
      source_last_message_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(source_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(target_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
  `);
  return db;
}

test("insertHandoffBrief + getHandoffBriefByTarget roundtrip", async () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
     VALUES ('A', 'A', 'A', 'A', 'codex', '0', '0'),
            ('B', 'B', 'B', 'B', 'claude', '0', '0')`
  ).run();
  process.env.FREEBUDDY_TEST_DB_PATH = ""; // not used; mock via setDb
  const { setDbForTest, insertHandoffBrief, getHandoffBriefByTarget } =
    await import("../dist-electron/cli/handoffBriefs.js");
  setDbForTest(db);
  const brief = { version: 1, originalGoal: "g", recentUserMessages: [], lastAssistantSummary: "", fileChanges: [], transcriptExcerpts: [], generatedAt: "t", source: { conversationId: "A", agentId: "A", agentName: "Codex", adapter: "codex", title: "A", messageCount: 1 } };
  const row = insertHandoffBrief({
    id: "br1",
    sourceConversationId: "A",
    targetConversationId: "B",
    sourceAgentId: "A",
    sourceAgentName: "Codex",
    sourceAdapter: "codex",
    brief,
    sourceMessageCount: 1,
    sourceLastMessageId: "m1"
  });
  assert.equal(row.id, "br1");
  const got = getHandoffBriefByTarget("B");
  assert.equal(got?.id, "br1");
  assert.equal(got?.brief.originalGoal, "g");
});

test("CASCADE: delete target conversation removes brief", async () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
     VALUES ('A', 'A', 'A', 'A', 'codex', '0', '0'),
            ('B', 'B', 'B', 'B', 'claude', '0', '0')`
  ).run();
  const { setDbForTest, insertHandoffBrief, getHandoffBriefByTarget } =
    await import("../dist-electron/cli/handoffBriefs.js");
  setDbForTest(db);
  insertHandoffBrief({
    id: "br1", sourceConversationId: "A", targetConversationId: "B",
    sourceAgentId: "A", sourceAgentName: "Codex", sourceAdapter: "codex",
    brief: { version: 1, originalGoal: "" , recentUserMessages: [], lastAssistantSummary: "", fileChanges: [], transcriptExcerpts: [], generatedAt: "t", source: { conversationId: "A", agentId: "A", agentName: "Codex", adapter: "codex", title: "A", messageCount: 0 } },
    sourceMessageCount: 0
  });
  db.prepare("DELETE FROM conversations WHERE id = ?").run("B");
  assert.equal(getHandoffBriefByTarget("B"), undefined);
});

test("getHandoffBriefsBySource returns briefs ordered DESC", async () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
     VALUES ('A', 'A', 'A', 'A', 'codex', '0', '0'),
            ('B1', 'B1', 'B1', 'B1', 'claude', '0', '0'),
            ('B2', 'B2', 'B2', 'B2', 'claude', '0', '0')`
  ).run();
  const { setDbForTest, insertHandoffBrief, getHandoffBriefsBySource } =
    await import("../dist-electron/cli/handoffBriefs.js");
  setDbForTest(db);
  insertHandoffBrief({ id: "old", sourceConversationId: "A", targetConversationId: "B1", sourceAgentId: "A", sourceAgentName: "Codex", sourceAdapter: "codex", brief: { version: 1, originalGoal: "", recentUserMessages: [], lastAssistantSummary: "", fileChanges: [], transcriptExcerpts: [], generatedAt: "1", source: { conversationId: "A", agentId: "A", agentName: "Codex", adapter: "codex", title: "A", messageCount: 0 } }, sourceMessageCount: 0 });
  insertHandoffBrief({ id: "new", sourceConversationId: "A", targetConversationId: "B2", sourceAgentId: "A", sourceAgentName: "Codex", sourceAdapter: "codex", brief: { version: 1, originalGoal: "", recentUserMessages: [], lastAssistantSummary: "", fileChanges: [], transcriptExcerpts: [], generatedAt: "2", source: { conversationId: "A", agentId: "A", agentName: "Codex", adapter: "codex", title: "A", messageCount: 0 } }, sourceMessageCount: 0 });
  const list = getHandoffBriefsBySource("A");
  assert.deepEqual(list.map((r) => r.id), ["new", "old"]);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run build:electron && node --test tests/handoff-brief-db.test.mjs`
Expected: FAIL（`../dist-electron/cli/handoffBriefs.js` 不存在）

- [ ] **Step 3: 创建 `electron/shared/handoffTypes.ts`**

**架构说明**：`electron/` 端不能 import `src/services/cli/types.ts`（`tsconfig.electron.json` 的 `rootDir: electron` 限制 + `src/` 内 `@/` 别名只在 renderer 端解析）。Codebase 现有惯例是 electron 端自定义平行类型（如 `electron/cli/conversations.ts` 自己定义 `Conversation`）。本项目沿用此惯例：在 `electron/shared/handoffTypes.ts` 放一份与 `src/services/cli/types.ts` 中同名接口**结构一致**的定义。两份定义需手动保持同步（与 `Conversation` 的现状相同）。

```typescript
// electron/shared/handoffTypes.ts
// Parallel type definitions for the electron/ side. These mirror the
// handoff-related interfaces in src/services/cli/types.ts. The two copies
// must be kept in sync manually (same convention as Conversation, which
// is defined in both electron/cli/conversations.ts and src/services/cli/types.ts).

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

export interface HandoffBriefSource {
  conversationId: string;
  agentId: string;
  agentName: string;
  adapter: string;
  title: string;
  cwd?: string;
  messageCount: number;
}

export interface HandoffBrief {
  version: 1;
  generatedAt: string;
  source: HandoffBriefSource;
  originalGoal: string;
  recentUserMessages: string[];
  lastAssistantSummary: string;
  fileChanges: HandoffBriefFileChange[];
  transcriptExcerpts: HandoffBriefMessageRef[];
}

export interface HandoffBriefRow {
  id: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceAgentId: string;
  sourceAgentName: string;
  sourceAdapter: string;
  brief: HandoffBrief | null;
  sourceMessageCount: number;
  sourceLastMessageId?: string;
  createdAt: string;
}

// Subset of stream item shapes that the extractor inspects. Structurally
// compatible with src/services/cli/streamParser.ts CliStreamItem so
// JSON.parse of stored assistant content fits.
export interface ParsedAssistantStreamItem {
  kind: string;
  content?: string;
  path?: string;
  action?: string;
  tool?: string;
  toolKind?: string;
  locations?: { path: string; line?: number }[];
}
```

- [ ] **Step 4: 扩展 `electron/cli/runtimeShared.ts` 的 `CliRunArgs`**

`electron/` 端运行时实际使用的 `CliRunArgs` 在 `runtimeShared.ts`，与 `src/services/cli/types.ts` 的同名接口平行（codebase 既有惯例）。Task 8 的 acpRuntime 注入依赖此处的字段。

定位 `electron/cli/runtimeShared.ts` 的 `export interface CliRunArgs {` 块，在 `announceSkills?: boolean;` 之后追加：

```typescript
  handoffBrief?: HandoffBrief;
  handoffBriefId?: string;
```

并在文件顶部 import 处加：

```typescript
import type { HandoffBrief } from "../shared/handoffTypes.js";
```

- [ ] **Step 5: 实现 `electron/cli/handoffBriefs.ts`**

```typescript
import type { Database as DB } from "better-sqlite3";
import { getDb } from "./db.js";
import type { HandoffBrief, HandoffBriefRow } from "../shared/handoffTypes.js";

// 测试钩子：仅测试时可注入 in-memory DB
let testDb: DB | null = null;
export function setDbForTest(db: DB | null): void {
  testDb = db;
}
function db(): DB {
  return testDb ?? getDb();
}

export interface InsertHandoffBriefInput {
  id: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceAgentId: string;
  sourceAgentName: string;
  sourceAdapter: string;
  brief: HandoffBrief;
  sourceMessageCount: number;
  sourceLastMessageId?: string;
}

function rowToHandoffBrief(r: any): HandoffBriefRow {
  let brief: HandoffBrief | null = null;
  try {
    brief = JSON.parse(r.brief_json);
  } catch {
    brief = null;
  }
  return {
    id: r.id,
    sourceConversationId: r.source_conversation_id,
    targetConversationId: r.target_conversation_id,
    sourceAgentId: r.source_agent_id,
    sourceAgentName: r.source_agent_name,
    sourceAdapter: r.source_adapter,
    brief,
    sourceMessageCount: r.source_message_count,
    sourceLastMessageId: r.source_last_message_id ?? undefined,
    createdAt: r.created_at
  };
}

export function insertHandoffBrief(input: InsertHandoffBriefInput): HandoffBriefRow {
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO handoff_briefs
         (id, source_conversation_id, target_conversation_id,
          source_agent_id, source_agent_name, source_adapter,
          brief_json, source_message_count, source_last_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.sourceConversationId,
      input.targetConversationId,
      input.sourceAgentId,
      input.sourceAgentName,
      input.sourceAdapter,
      JSON.stringify(input.brief),
      input.sourceMessageCount,
      input.sourceLastMessageId ?? null,
      now
    );
  return getHandoffBrief(input.id) as HandoffBriefRow;
}

export function getHandoffBrief(id: string): HandoffBriefRow | undefined {
  const row = db().prepare(`SELECT * FROM handoff_briefs WHERE id = ?`).get(id) as any;
  return row ? rowToHandoffBrief(row) : undefined;
}

export function getHandoffBriefByTarget(targetConversationId: string): HandoffBriefRow | undefined {
  const row = db()
    .prepare(`SELECT * FROM handoff_briefs WHERE target_conversation_id = ?`)
    .get(targetConversationId) as any;
  return row ? rowToHandoffBrief(row) : undefined;
}

export function getHandoffBriefsBySource(sourceConversationId: string): HandoffBriefRow[] {
  const rows = db()
    .prepare(
      `SELECT * FROM handoff_briefs
       WHERE source_conversation_id = ?
       ORDER BY created_at DESC`
    )
    .all(sourceConversationId) as any[];
  return rows.map(rowToHandoffBrief);
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `npm run build:electron && node --test tests/handoff-brief-db.test.mjs`
Expected: 3 tests PASS

- [ ] **Step 7: Commit**

```bash
git add electron/shared/handoffTypes.ts electron/cli/runtimeShared.ts electron/cli/handoffBriefs.ts tests/handoff-brief-db.test.mjs
git commit -m "feat(handoff): add handoffBriefs DB layer with parallel electron types"
```

---

## Task 4: conversations.ts 支持 origin 字段

**Files:**
- Modify: `electron/cli/conversations.ts`
- Test: `tests/handoff-transfer-wiring.test.mjs`（追加用例）

- [ ] **Step 1: 在 `tests/handoff-transfer-wiring.test.mjs` 追加测试**

在文件末尾追加：

```javascript
test("conversations.ts wires source_* through createConversation and rowToConversation", () => {
  const src = read("electron/cli/conversations.ts");
  assert.match(src, /source_conversation_id/);
  assert.match(src, /sourceConversationId:/);
  assert.match(src, /sourceBriefId/);
  // createConversation 的 input 接收 origin 字段
  assert.match(src, /sourceConversationId\?: string;/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: FAIL（source_conversation_id 未匹配）

- [ ] **Step 3: 修改 `electron/cli/conversations.ts` 的 `Conversation` 接口**

在 `export interface Conversation {` 块末尾（`lastMessageAt?: string;` 之后）追加：

```typescript
  sourceConversationId?: string;
  sourceAgentId?: string;
  sourceAgentName?: string;
  sourceAdapter?: string;
  sourceBriefId?: string;
```

- [ ] **Step 4: 修改 `rowToConversation` 把 origin 字段读出**

定位 `function rowToConversation(r: any): Conversation {`，在 `lastMessageAt: r.last_message_at ?? undefined` 之后追加：

```typescript
    ,
    sourceConversationId: r.source_conversation_id ?? undefined,
    sourceAgentId: r.source_agent_id ?? undefined,
    sourceAgentName: r.source_agent_name ?? undefined,
    sourceAdapter: r.source_adapter ?? undefined,
    sourceBriefId: r.source_brief_id ?? undefined
```

（实际改动是把 `lastMessageAt: r.last_message_at ?? undefined` 后的 `}` 替换为 `,` 然后加以上字段再 `}`。）

- [ ] **Step 5: 修改 `CreateConversationInput` 接口**

```typescript
export interface CreateConversationInput {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  cwd?: string;
  approvalMode?: "auto" | "ask";
  configOptionOverrides?: Record<string, string>;
  skillIds?: string[];
  titleSource?: ConversationTitleSource;
  sourceConversationId?: string;
  sourceAgentId?: string;
  sourceAgentName?: string;
  sourceAdapter?: string;
  sourceBriefId?: string;
}
```

- [ ] **Step 6: 修改 `createConversation` 写入 origin 字段**

定位 `createConversation` 函数，把 SQL 改为：

```typescript
export function createConversation(input: CreateConversationInput): Conversation {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO conversations
         (id, title, agent_id, agent_name, adapter, cwd, approval_mode,
          config_option_overrides, skill_snapshot, title_source, archived,
          source_conversation_id, source_agent_id, source_agent_name,
          source_adapter, source_brief_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.title,
      input.agentId,
      input.agentName,
      input.adapter,
      input.cwd ?? null,
      input.approvalMode ?? null,
      input.configOptionOverrides &&
        Object.keys(input.configOptionOverrides).length > 0
        ? JSON.stringify(input.configOptionOverrides)
        : null,
      JSON.stringify(resolveSkillSnapshots(input.skillIds ?? [])),
      input.titleSource ?? "default",
      input.sourceConversationId ?? null,
      input.sourceAgentId ?? null,
      input.sourceAgentName ?? null,
      input.sourceAdapter ?? null,
      input.sourceBriefId ?? null,
      now,
      now
    );
  return getConversation(input.id) as Conversation;
}
```

- [ ] **Step 7: 类型检查 + 测试**

Run: `npm run typecheck && npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add electron/cli/conversations.ts tests/handoff-transfer-wiring.test.mjs
git commit -m "feat(handoff): wire source_* fields through createConversation"
```

---

## Task 5: handoffBriefExtractor 纯函数

**Files:**
- Create: `electron/cli/handoffBriefExtractor.ts`
- Test: `tests/handoff-brief-extractor.test.mjs`

- [ ] **Step 1: 写测试（覆盖 spec §4.6 全部分支）**

Create `tests/handoff-brief-extractor.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { extractHandoffBrief } from "../dist-electron/cli/handoffBriefExtractor.js";

const conv = (extra = {}) => ({
  id: "C1", title: "T", agentId: "A", agentName: "Codex", adapter: "codex",
  cwd: "/w", archived: false, createdAt: "0", updatedAt: "0", ...extra
});

const userMsg = (id, content, createdAt = "0") => ({
  id, conversationId: "C1", role: "user", status: "done",
  content, createdAt, updatedAt: createdAt
});

const assistantMsg = (id, items, createdAt = "0", status = "done") => ({
  id, conversationId: "C1", role: "assistant", status,
  content: JSON.stringify(items), createdAt, updatedAt: createdAt
});

test("originalGoal: first user message, trimmed + capped 2000", () => {
  const long = "x".repeat(3000);
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [userMsg("u1", long), assistantMsg("a1", [{ kind: "text", role: "assistant", content: "ok" }])]
  });
  assert.equal(brief.originalGoal.length, 2000);
  assert.equal(brief.originalGoal, "x".repeat(2000));
});

test("originalGoal: no user messages -> empty string", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [assistantMsg("a1", [{ kind: "text", role: "assistant", content: "ok" }])]
  });
  assert.equal(brief.originalGoal, "");
});

test("recentUserMessages: last 3 user msgs, excludes the first when count > 3", () => {
  const msgs = [
    userMsg("u1", "first"),               // originalGoal
    assistantMsg("a1", [{ kind: "text", role: "assistant", content: "r1" }]),
    userMsg("u2", "second"),
    assistantMsg("a2", [{ kind: "text", role: "assistant", content: "r2" }]),
    userMsg("u3", "third"),
    userMsg("u4", "fourth"),
    userMsg("u5", "fifth")
  ];
  const brief = extractHandoffBrief({ conversation: conv(), messages: msgs });
  assert.deepEqual(brief.recentUserMessages, ["third", "fourth", "fifth"]);
});

test("lastAssistantSummary: concat text items from last assistant, capped 2000", () => {
  const long = "y".repeat(3000);
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [
        { kind: "text", role: "assistant", content: long },
        { kind: "thinking", content: "private" },
        { kind: "text", role: "assistant", content: " tail" }
      ])
    ]
  });
  assert.equal(brief.lastAssistantSummary.length, 2000);
  assert.ok(brief.lastAssistantSummary.startsWith("y".repeat(1995)));
  assert.ok(brief.lastAssistantSummary.endsWith(" tail".slice(0, 5)));
});

test("lastAssistantSummary: empty when last assistant has no text items", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [{ kind: "file-edit", path: "/a", action: "update" }])
    ]
  });
  assert.equal(brief.lastAssistantSummary, "");
});

test("fileChanges: from file-edit items", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [
        { kind: "file-edit", path: "/src/a.ts", action: "create" },
        { kind: "file-edit", path: "/src/b.ts", action: "update" }
      ])
    ]
  });
  assert.equal(brief.fileChanges.length, 2);
  assert.equal(brief.fileChanges[0].path, "/src/b.ts");  // 倒序，最近改动排前
  assert.equal(brief.fileChanges[1].path, "/src/a.ts");
});

test("fileChanges: from tool-call items (toolKind whitelist + tool name whitelist)", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [
        { kind: "tool-call", tool: "apply_patch", toolKind: "edit",
          locations: [{ path: "/p1" }] },
        { kind: "tool-call", tool: "custom_thing", toolKind: "read",
          locations: [{ path: "/p2" }] },
        { kind: "tool-call", tool: "write_file", toolKind: "other",
          locations: [{ path: "/p3" }] }
      ])
    ]
  });
  const paths = brief.fileChanges.map((c) => c.path);
  assert.ok(paths.includes("/p1"));
  assert.ok(paths.includes("/p2"));
  assert.ok(paths.includes("/p3"));
});

test("fileChanges: dedupe by path, later write wins; read never overwrites edit", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [{ kind: "file-edit", path: "/x", action: "update" }]),
      assistantMsg("a2", [{ kind: "tool-call", tool: "read_file", toolKind: "read", locations: [{ path: "/x" }] }])
    ]
  });
  const x = brief.fileChanges.find((c) => c.path === "/x");
  assert.equal(x.action, "edit");  // read 没覆盖
});

test("fileChanges: cap 50, non-read priority", () => {
  const items = [];
  for (let i = 0; i < 60; i++) {
    items.push({ kind: "tool-call", tool: "read_file", toolKind: "read", locations: [{ path: `/r${i}` }] });
  }
  for (let i = 0; i < 30; i++) {
    items.push({ kind: "file-edit", path: `/e${i}.ts`, action: "update" });
  }
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [userMsg("u1", "go"), assistantMsg("a1", items)]
  });
  assert.equal(brief.fileChanges.length, 50);
  // 30 个 edit 全部保留 + 20 个 read（最近优先）
  const edits = brief.fileChanges.filter((c) => c.action === "edit");
  assert.equal(edits.length, 30);
});

test("fileChanges: skip empty/non-string path", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [
        { kind: "file-edit", path: "", action: "update" },
        { kind: "file-edit", path: 123, action: "update" },
        { kind: "file-edit", path: "/ok", action: "update" }
      ])
    ]
  });
  assert.equal(brief.fileChanges.length, 1);
  assert.equal(brief.fileChanges[0].path, "/ok");
});

test("transcriptExcerpts: last 8 msgs, user→content capped 800, assistant→text capped 800", () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(userMsg(`u${i}`, `user-${i}`));
    msgs.push(assistantMsg(`a${i}`, [{ kind: "text", role: "assistant", content: `assistant-${i}` }]));
  }
  const brief = extractHandoffBrief({ conversation: conv(), messages: msgs });
  assert.equal(brief.transcriptExcerpts.length, 8);
  assert.equal(brief.transcriptExcerpts[0].messageId, "a6");  // 末尾倒推 8 条
});

test("transcriptExcerpts: assistant with no text -> '(tool calls only)'", () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [{ kind: "file-edit", path: "/x", action: "update" }])
    ]
  });
  assert.equal(brief.transcriptExcerpts.length, 2);
  const aExcerpt = brief.transcriptExcerpts.find((e) => e.role === "assistant");
  assert.equal(aExcerpt.excerpt, "(tool calls only)");
});

test("0 messages -> all empty fields, does not throw", () => {
  const brief = extractHandoffBrief({ conversation: conv(), messages: [] });
  assert.equal(brief.originalGoal, "");
  assert.equal(brief.recentUserMessages.length, 0);
  assert.equal(brief.fileChanges.length, 0);
  assert.equal(brief.transcriptExcerpts.length, 0);
  assert.equal(brief.source.messageCount, 0);
});

test("malformed content JSON -> skip that message, do not throw", () => {
  const badMsg = { ...userMsg("u1", "go"), role: "assistant", content: "{not json" };
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [badMsg, assistantMsg("a1", [{ kind: "text", role: "assistant", content: "ok" }])]
  });
  assert.equal(brief.lastAssistantSummary, "ok");  // 仅 a1 被处理
});

test('status="running" assistant -> content not parsed, transcriptExcerpt says "(streaming)"', () => {
  const brief = extractHandoffBrief({
    conversation: conv(),
    messages: [
      userMsg("u1", "go"),
      assistantMsg("a1", [{ kind: "text", role: "assistant", content: "should be ignored" }], "1", "running")
    ]
  });
  assert.equal(brief.lastAssistantSummary, "");
  assert.equal(brief.transcriptExcerpts.find((e) => e.role === "assistant").excerpt, "(streaming)");
});

test("source metadata correctly populated", () => {
  const brief = extractHandoffBrief({
    conversation: conv({ id: "X", title: "My Task", agentId: "A1", agentName: "Claude", adapter: "claude", cwd: "/path" }),
    messages: [userMsg("u1", "go")]
  });
  assert.equal(brief.source.conversationId, "X");
  assert.equal(brief.source.title, "My Task");
  assert.equal(brief.source.agentName, "Claude");
  assert.equal(brief.source.adapter, "claude");
  assert.equal(brief.source.cwd, "/path");
  assert.equal(brief.source.messageCount, 1);
});

test("64 KB trim order: transcriptExcerpts -> fileChanges -> recentUserMessages -> lastAssistantSummary -> originalGoal", () => {
  // 构造一个超大 brief
  const huge = "z".repeat(10000);
  const msgs = [];
  msgs.push(userMsg("u1", huge));  // originalGoal 巨大
  for (let i = 0; i < 20; i++) {
    msgs.push(userMsg(`u${i + 2}`, huge));
    msgs.push(assistantMsg(`a${i + 1}`, [
      { kind: "text", role: "assistant", content: huge },
      { kind: "file-edit", path: `/f${i}.ts`, action: "update" }
    ]));
  }
  const brief = extractHandoffBrief({ conversation: conv(), messages: msgs });
  const size = JSON.stringify(brief).length;
  assert.ok(size <= 64 * 1024, `brief size ${size} exceeds 64KB`);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run build:electron && node --test tests/handoff-brief-extractor.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `electron/cli/handoffBriefExtractor.ts`**

```typescript
import type { Conversation, ConversationMessage } from "./conversations.js";
import type {
  HandoffBrief,
  HandoffBriefFileChange,
  HandoffBriefMessageRef,
  ParsedAssistantStreamItem
} from "../shared/handoffTypes.js";

const MAX_ORIGINAL_GOAL = 2000;
const MAX_RECENT_USER = 800;
const MAX_ASSISTANT_SUMMARY = 2000;
const MAX_EXCERPT = 800;
const MAX_TRANSCRIPT_REFS = 8;
const MAX_FILE_CHANGES = 50;
const SIZE_LIMIT = 64 * 1024;

const FILE_TOOL_NAMES = new Set([
  "apply_patch", "write", "edit", "update", "str_replace",
  "create_file", "edit_file", "multi_edit", "read_file"
]);

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max);
}

function parseAssistantItems(msg: ConversationMessage): ParsedAssistantStreamItem[] | null {
  try {
    const parsed = JSON.parse(msg.content);
    if (!Array.isArray(parsed)) return null;
    return parsed as ParsedAssistantStreamItem[];
  } catch {
    return null;
  }
}

function extractAssistantText(items: ParsedAssistantStreamItem[]): string {
  return items
    .filter((it) => it.kind === "text" && typeof it.content === "string")
    .map((it) => it.content ?? "")
    .join("");
}

function actionFromToolKind(toolKind: string | undefined): "edit" | "delete" | "read" {
  if (toolKind === "delete") return "delete";
  if (toolKind === "read") return "read";
  return "edit";
}

function collectFileChanges(messages: ConversationMessage[]): HandoffBriefFileChange[] {
  const byPath = new Map<string, HandoffBriefFileChange>();
  const order: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const items = parseAssistantItems(msg);
    if (!items) continue;

    for (const item of items) {
      if (item.kind === "file-edit") {
        const p = typeof item.path === "string" ? item.path : "";
        if (!p) continue;
        const next: HandoffBriefFileChange = { path: p, action: item.action };
        const prev = byPath.get(p);
        if (!(prev && prev.action !== "read" && next.action === "read")) {
          byPath.set(p, next);
          if (!order.includes(p)) order.push(p);
        }
      } else if (item.kind === "tool-call") {
        const toolKind = (item as any).toolKind as string | undefined;
        const toolName = (item as any).tool as string | undefined;
        const isMatch =
          toolKind === "edit" || toolKind === "delete" || toolKind === "read" ||
          (typeof toolName === "string" && FILE_TOOL_NAMES.has(toolName));
        if (!isMatch) continue;
        const locations = Array.isArray((item as any).locations) ? (item as any).locations : [];
        for (const loc of locations) {
          const p = typeof loc?.path === "string" ? loc.path : "";
          if (!p) continue;
          const next: HandoffBriefFileChange = {
            path: p,
            action: actionFromToolKind(toolKind),
            toolName: toolName
          };
          const prev = byPath.get(p);
          if (!(prev && prev.action !== "read" && next.action === "read")) {
            byPath.set(p, next);
            if (!order.includes(p)) order.push(p);
          }
        }
      }
    }
  }

  // 排序：出现顺序倒序（最近改动排前）
  const ordered = order.slice().reverse().map((p) => byPath.get(p)!);

  // 上限 50：非 read 优先 + 最近优先
  if (ordered.length <= MAX_FILE_CHANGES) return ordered;
  const nonRead = ordered.filter((c) => c.action !== "read");
  const reads = ordered.filter((c) => c.action === "read");
  const picks = [...nonRead, ...reads].slice(0, MAX_FILE_CHANGES);
  return picks;
}

function excerptForMessage(msg: ConversationMessage): string {
  if (msg.role === "user") return clip(msg.content, MAX_EXCERPT);
  if (msg.status === "running" || msg.status === "starting") return "(streaming)";
  const items = parseAssistantItems(msg);
  if (!items) return "(malformed)";
  const text = extractAssistantText(items);
  return text.trim() ? clip(text, MAX_EXCERPT) : "(tool calls only)";
}

function trimForSize(brief: HandoffBrief): HandoffBrief {
  let b = brief;
  let stage: keyof HandoffBrief | null = null;

  const stages: Array<() => void> = [
    () => { b = { ...b, transcriptExcerpts: b.transcriptExcerpts.slice(0, 4) }; },
    () => { b = { ...b, transcriptExcerpts: b.transcriptExcerpts.slice(0, 2) }; },
    () => { b = { ...b, transcriptExcerpts: [] }; },
    () => {
      const nonRead = b.fileChanges.filter((c) => c.action !== "read");
      b = { ...b, fileChanges: [...nonRead, ...b.fileChanges.filter((c) => c.action === "read")].slice(0, 25) };
    },
    () => { b = { ...b, fileChanges: b.fileChanges.filter((c) => c.action !== "read").slice(0, 10) }; },
    () => { b = { ...b, recentUserMessages: b.recentUserMessages.slice(0, 2) }; },
    () => { b = { ...b, recentUserMessages: b.recentUserMessages.slice(0, 1) }; },
    () => { b = { ...b, lastAssistantSummary: b.lastAssistantSummary.slice(0, 1000) }; },
    () => { b = { ...b, lastAssistantSummary: b.lastAssistantSummary.slice(0, 500) }; },
    () => { b = { ...b, lastAssistantSummary: b.lastAssistantSummary.slice(0, 200) }; },
    () => { b = { ...b, originalGoal: b.originalGoal.slice(0, 500) }; }
  ];

  let i = 0;
  while (JSON.stringify(b).length > SIZE_LIMIT && i < stages.length) {
    stages[i]();
    i++;
    stage = null;
  }
  return b;
}

export interface ExtractInput {
  conversation: Conversation;
  messages: ConversationMessage[];
}

export function extractHandoffBrief(input: ExtractInput): HandoffBrief {
  const { conversation: c, messages } = input;

  const userMsgs = messages.filter((m) => m.role === "user");
  const originalGoal = userMsgs.length > 0 ? clip(userMsgs[0].content, MAX_ORIGINAL_GOAL) : "";

  const recentUser = userMsgs.length > 1
    ? userMsgs.slice(Math.max(1, userMsgs.length - 3)).map((m) => clip(m.content, MAX_RECENT_USER))
    : [];

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  let lastAssistantSummary = "";
  if (lastAssistant && (lastAssistant.status === "done" || lastAssistant.status === "sent")) {
    const items = parseAssistantItems(lastAssistant);
    if (items) lastAssistantSummary = clip(extractAssistantText(items), MAX_ASSISTANT_SUMMARY);
  }

  const fileChanges = collectFileChanges(messages);

  const tail = messages.slice(-MAX_TRANSCRIPT_REFS);
  const transcriptExcerpts: HandoffBriefMessageRef[] = tail
    .filter((m) => m.role !== "system")
    .map((m) => ({
      messageId: m.id,
      role: m.role as "user" | "assistant",
      createdAt: m.createdAt,
      excerpt: excerptForMessage(m)
    }));

  const brief: HandoffBrief = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      conversationId: c.id,
      agentId: c.agentId,
      agentName: c.agentName,
      adapter: c.adapter,
      title: c.title,
      cwd: c.cwd,
      messageCount: messages.length
    },
    originalGoal,
    recentUserMessages: recentUser,
    lastAssistantSummary,
    fileChanges,
    transcriptExcerpts
  };

  return trimForSize(brief);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run build:electron && node --test tests/handoff-brief-extractor.test.mjs`
Expected: 全部 PASS（若有失败，按测试反馈微调实现，保持 spec §4.6 的算法为准）

- [ ] **Step 5: Commit**

```bash
git add electron/cli/handoffBriefExtractor.ts tests/handoff-brief-extractor.test.mjs
git commit -m "feat(handoff): implement brief extractor with full test coverage"
```

---

## Task 6: contextToolService.ts

**Files:**
- Create: `electron/contextToolService.ts`
- Test: `tests/handoff-transfer-wiring.test.mjs`（追加）

- [ ] **Step 1: 追加 wiring 测试**

在 `tests/handoff-transfer-wiring.test.mjs` 末尾追加：

```javascript
test("contextToolService exports register/unregister and writes manifest under dataDir", () => {
  const src = read("electron/contextToolService.ts");
  assert.match(src, /export function registerContextToolSession/);
  assert.match(src, /export function unregisterContextToolSession/);
  assert.match(src, /name: "freebuddy-context"/);
  assert.match(src, /FREEBUDDY_HANDOFF_MANIFEST/);
  assert.match(src, /context-sessions/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 `electron/contextToolService.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDataDir } from "./cli/db.js";
import type { HandoffBrief, HandoffBriefSource } from "../src/services/cli/types.js";
import type { AcpStdioMcpServer } from "./shared/draftToolProtocol.js";

const manifests = new Map<string, string>();

function serverPath(): string {
  return fileURLToPath(new URL("./mcp/contextMcpServer.js", import.meta.url));
}

export function registerContextToolSession(
  taskSessionId: string,
  brief: HandoffBrief,
  briefId: string
): AcpStdioMcpServer {
  unregisterContextToolSession(taskSessionId);
  const directory = path.join(getDataDir(), "context-sessions");
  fs.mkdirSync(directory, { recursive: true });
  const manifest = path.join(directory, `${taskSessionId}.json`);
  // Manifest source 直接取自 brief.source（仅 5 个必需字段，cwd/messageCount 不入 manifest）
  const source = {
    conversationId: brief.source.conversationId,
    agentId: brief.source.agentId,
    agentName: brief.source.agentName,
    adapter: brief.source.adapter,
    title: brief.source.title
  };
  fs.writeFileSync(
    manifest,
    JSON.stringify({ version: 1, brief, briefId, source }),
    { encoding: "utf8", mode: 0o600 }
  );
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
  const manifest = manifests.get(taskSessionId);
  manifests.delete(taskSessionId);
  if (!manifest) return;
  try {
    fs.unlinkSync(manifest);
  } catch {
    // best-effort cleanup
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/contextToolService.ts tests/handoff-transfer-wiring.test.mjs
git commit -m "feat(handoff): add contextToolService for manifest-based MCP wiring"
```

---

## Task 7: contextMcpServer.ts

**Files:**
- Create: `electron/mcp/contextMcpServer.ts`
- Test: `tests/handoff-context-mcp.test.mjs`

- [ ] **Step 1: 写 MCP in-memory 测试**

Create `tests/handoff-context-mcp.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContextMcpServer } from "../dist-electron/mcp/contextMcpServer.js";

const sampleBrief = {
  version: 1,
  generatedAt: "2026-07-18T00:00:00Z",
  source: {
    conversationId: "A", agentId: "A", agentName: "Codex",
    adapter: "codex", title: "T", messageCount: 5
  },
  originalGoal: "implement login",
  recentUserMessages: ["use JWT"],
  lastAssistantSummary: "form validation done",
  fileChanges: [{ path: "/src/login.tsx", action: "edit" }],
  transcriptExcerpts: []
};

function withManifest(brief, source, fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-ctx-"));
    const file = path.join(dir, "m.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, brief, briefId: "b1", source }));
    process.env.FREEBUDDY_HANDOFF_MANIFEST = file;
    try {
      await fn();
    } finally {
      delete process.env.FREEBUDDY_HANDOFF_MANIFEST;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createContextMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

test("listTools exposes read_handoff_brief and get_handoff_origin", withManifest(sampleBrief, sampleBrief.source, async () => {
  const { client, server } = await connect();
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    assert.ok(names.includes("read_handoff_brief"));
    assert.ok(names.includes("get_handoff_origin"));
  } finally {
    await client.close();
    await server.close();
  }
}));

test("read_handoff_brief full returns complete brief", withManifest(sampleBrief, sampleBrief.source, async () => {
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "read_handoff_brief", arguments: {} });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.originalGoal, "implement login");
    assert.deepEqual(res.structuredContent.brief.originalGoal, "implement login");
  } finally {
    await client.close();
    await server.close();
  }
}));

test("read_handoff_brief compact returns only originalGoal/recentUserMessages/fileChanges paths", withManifest(sampleBrief, sampleBrief.source, async () => {
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "read_handoff_brief", arguments: { format: "compact" } });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.originalGoal, "implement login");
    assert.deepEqual(parsed.recentUserMessages, ["use JWT"]);
    assert.deepEqual(parsed.fileChanges, ["/src/login.tsx"]);
    assert.equal(parsed.lastAssistantSummary, undefined);
  } finally {
    await client.close();
    await server.close();
  }
}));

test("read_handoff_brief: missing manifest -> non-error empty result", async () => {
  delete process.env.FREEBUDDY_HANDOFF_MANIFEST;
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "read_handoff_brief", arguments: {} });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /No handoff brief/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("read_handoff_brief: corrupted manifest file -> non-error empty result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-ctx-"));
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, "{not json");
  process.env.FREEBUDDY_HANDOFF_MANIFEST = file;
  try {
    const { client, server } = await connect();
    try {
      const res = await client.callTool({ name: "read_handoff_brief", arguments: {} });
      assert.equal(res.isError, undefined);
      assert.match(res.content[0].text, /No handoff brief/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    delete process.env.FREEBUDDY_HANDOFF_MANIFEST;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("get_handoff_origin returns only source metadata", withManifest(sampleBrief, sampleBrief.source, async () => {
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "get_handoff_origin", arguments: {} });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.agentName, "Codex");
    assert.equal(parsed.adapter, "codex");
    assert.equal(parsed.originalGoal, undefined);
  } finally {
    await client.close();
    await server.close();
  }
}));

test("get_handoff_origin: missing manifest -> non-error", async () => {
  delete process.env.FREEBUDDY_HANDOFF_MANIFEST;
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "get_handoff_origin", arguments: {} });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /No handoff origin/);
  } finally {
    await client.close();
    await server.close();
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run build:electron && node --test tests/handoff-context-mcp.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `electron/mcp/contextMcpServer.ts`**

```typescript
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { HandoffBrief } from "../shared/handoffTypes.js";

interface ManifestSource {
  conversationId: string;
  agentId: string;
  agentName: string;
  adapter: string;
  title: string;
}

interface LoadedManifest {
  brief: HandoffBrief;
  briefId: string;
  source: ManifestSource;
}

function loadManifest(): LoadedManifest | null {
  const file = process.env.FREEBUDDY_HANDOFF_MANIFEST?.trim();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== 1 || !parsed.brief || !parsed.source) return null;
    return parsed as LoadedManifest;
  } catch {
    return null;
  }
}

function emptyResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function result(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {})
  };
}

function toCompact(brief: HandoffBrief) {
  return {
    originalGoal: brief.originalGoal,
    recentUserMessages: brief.recentUserMessages,
    fileChanges: brief.fileChanges.map((c) => c.path)
  };
}

export function createContextMcpServer(): McpServer {
  const manifest = loadManifest();
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
      inputSchema: { format: z.enum(["full", "compact"]).default("full").optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ format }: { format?: "full" | "compact" } = {}) => {
      if (!manifest) return emptyResult("No handoff brief for this session");
      const brief = format === "compact" ? toCompact(manifest.brief) : manifest.brief;
      return result(JSON.stringify(brief, null, 2), {
        brief: manifest.brief,
        source: manifest.source
      });
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

export async function runContextMcpServer(): Promise<void> {
  await createContextMcpServer().connect(new StdioServerTransport());
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runContextMcpServer().catch((error) => {
    console.error("[FreeBuddy Context MCP]", error);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run build:electron && node --test tests/handoff-context-mcp.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/mcp/contextMcpServer.ts tests/handoff-context-mcp.test.mjs
git commit -m "feat(handoff): add freebuddy-context MCP server with read_handoff_brief"
```

---

## Task 8: acpRuntime.ts 注入点

**Files:**
- Modify: `electron/cli/acpRuntime.ts`
- Test: `tests/handoff-transfer-wiring.test.mjs`（追加）

- [ ] **Step 1: 追加 wiring 测试**

```javascript
test("acpRuntime pushes context MCP server when args.handoffBrief present", () => {
  const src = read("electron/cli/acpRuntime.ts");
  assert.match(src, /import.*registerContextToolSession.*from.*contextToolService/);
  assert.match(src, /args\.handoffBrief/);
  assert.match(src, /registerContextToolSession\(/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: FAIL

- [ ] **Step 3: 在 `electron/cli/acpRuntime.ts` 加 import**

定位现有 import 区，追加：

```typescript
import { registerContextToolSession } from "../contextToolService.js";
```

- [ ] **Step 4: 在 `acpRuntime.ts` 的 mcpServers 注入区加分支**

定位 `if (args.skills?.length) { mcpServers.push(registerSkillToolSession(args.sessionId, args.skills)); }` 块之后追加：

```typescript
    if (args.handoffBrief && args.handoffBriefId) {
      mcpServers.push(
        registerContextToolSession(
          args.sessionId,
          args.handoffBrief,
          args.handoffBriefId
        )
      );
    }
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add electron/cli/acpRuntime.ts tests/handoff-transfer-wiring.test.mjs
git commit -m "feat(handoff): inject freebuddy-context MCP into ACP runtime on transfer"
```

---

## Task 9: IPC handlers + preload 暴露

**Files:**
- Modify: `electron/cli/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/freebuddy.d.ts`
- Test: `tests/handoff-transfer-wiring.test.mjs`（追加）

- [ ] **Step 1: 追加 wiring 测试**

```javascript
test("IPC exposes previewHandoffBrief, transferConversation, and getHandoffBriefByTarget", () => {
  const ipc = read("electron/cli/ipc.ts");
  const preload = read("electron/preload.ts");
  const dts = read("src/types/freebuddy.d.ts");
  assert.match(ipc, /cli:previewHandoffBrief/);
  assert.match(ipc, /cli:transferConversation/);
  assert.match(ipc, /cli:getHandoffBriefByTarget/);
  assert.match(ipc, /extractHandoffBrief/);
  assert.match(ipc, /insertHandoffBrief/);
  assert.match(preload, /previewHandoffBrief:/);
  assert.match(preload, /transferConversation:/);
  assert.match(preload, /getHandoffBriefByTarget:/);
  assert.match(dts, /previewHandoffBrief\(/);
  assert.match(dts, /transferConversation\(/);
  assert.match(dts, /getHandoffBriefByTarget\(/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: FAIL

- [ ] **Step 3: 把 `TransferConversationInput` 改为 renderer 自带 agent 信息**

修订 `src/services/cli/types.ts` 里 Task 1 写入的 `TransferConversationInput`：

```typescript
export interface TransferConversationInput {
  sourceConversationId: string;
  targetConversationId: string;
  targetAgentId: string;
  targetAgentName: string;
  targetAdapter: string;
  cwd?: string;
}
```

理由：main 进程不解析 members（那是 renderer 的 `aiMembers` 配置），renderer 直接把目标 agent 的 `id/name/adapter` 传过来即可。

- [ ] **Step 4: 在 `electron/cli/ipc.ts` 加 imports**

```typescript
import { nanoid } from "nanoid";
import { extractHandoffBrief } from "./handoffBriefExtractor.js";
import {
  insertHandoffBrief,
  getHandoffBriefByTarget
} from "./handoffBriefs.js";
import type {
  HandoffBrief,
  PreviewHandoffBriefInput,
  PreviewHandoffBriefResult,
  TransferConversationInput,
  TransferConversationResult
} from "../shared/handoffTypes.js";
```

若 `nanoid` 已在 ipc.ts 顶部 import，跳过那一行。

- [ ] **Step 5: 在 `electron/cli/ipc.ts` 加三个 handler**

定位 `cli:createConversation` handler 块之后追加：

```typescript
  ipcMain.handle(
    "cli:previewHandoffBrief",
    (_e, input: PreviewHandoffBriefInput): PreviewHandoffBriefResult => {
      const conversation = getConversation(input.sourceConversationId);
      if (!conversation) {
        return { brief: null, warning: "brief_extraction_failed" };
      }
      const messages = listMessages(input.sourceConversationId);
      try {
        return { brief: extractHandoffBrief({ conversation, messages }) };
      } catch {
        return { brief: null, warning: "brief_extraction_failed" };
      }
    }
  );

  ipcMain.handle(
    "cli:getHandoffBriefByTarget",
    (_e, targetConversationId: string) =>
      getHandoffBriefByTarget(targetConversationId)
  );

  ipcMain.handle(
    "cli:transferConversation",
    (_e, input: TransferConversationInput): TransferConversationResult => {
      const source = getConversation(input.sourceConversationId);
      if (!source) {
        throw new Error("Source conversation not found");
      }
      const messages = listMessages(input.sourceConversationId);

      let brief: HandoffBrief | null = null;
      try {
        brief = extractHandoffBrief({ conversation: source, messages });
      } catch {
        brief = null;
      }

      let briefId: string | null = null;
      const result = getDb().transaction(() => {
        if (brief) {
          briefId = nanoid();
          insertHandoffBrief({
            id: briefId,
            sourceConversationId: source.id,
            targetConversationId: input.targetConversationId,
            sourceAgentId: source.agentId,
            sourceAgentName: source.agentName,
            sourceAdapter: source.adapter,
            brief,
            sourceMessageCount: messages.length,
            sourceLastMessageId: messages[messages.length - 1]?.id
          });
        }
        const conversation = createConversation({
          id: input.targetConversationId,
          title: source.title,
          agentId: input.targetAgentId,
          agentName: input.targetAgentName,
          adapter: input.targetAdapter,
          cwd: input.cwd ?? source.cwd,
          skillIds: [],
          titleSource: "default",
          sourceConversationId: source.id,
          sourceAgentId: source.agentId,
          sourceAgentName: source.agentName,
          sourceAdapter: source.adapter,
          sourceBriefId: briefId ?? undefined
        });
        return { conversation };
      })();

      return {
        conversation: result.conversation,
        briefId,
        seedPrompt: buildSeedPrompt(source, brief),
        warning: brief ? undefined : "brief_extraction_failed"
      };
    }
  );
```

并在 `ipc.ts` 文件末尾（所有 handler 之外）加 seed prompt 模板函数：

```typescript
function buildSeedPrompt(
  source: { agentName: string; adapter: string },
  brief: HandoffBrief | null
): string {
  if (!brief) {
    return `Continuing a task transferred from ${source.agentName} (${source.adapter}). ` +
      `No prior context is available. Ask the user what they'd like to focus on.`;
  }
  return `Continuing a task transferred from ${source.agentName} (${source.adapter}).\n` +
    `Call the \`freebuddy-context.read_handoff_brief\` tool now to load the ` +
    `handoff (original goal, recent messages, file changes), then ask me ` +
    `what you'd like to focus on first.`;
}
```

- [ ] **Step 6: 在 `electron/preload.ts` 的 `cli` 对象里加方法**

定位现有 `createConversation: ...` 之后追加：

```typescript
    previewHandoffBrief: (input) =>
      ipcRenderer.invoke("cli:previewHandoffBrief", input),
    getHandoffBriefByTarget: (targetConversationId) =>
      ipcRenderer.invoke("cli:getHandoffBriefByTarget", targetConversationId),
    transferConversation: (input) =>
      ipcRenderer.invoke("cli:transferConversation", input),
```

- [ ] **Step 7: 在 `src/types/freebuddy.d.ts` 加声明**

确保 `PreviewHandoffBriefInput` / `PreviewHandoffBriefResult` / `TransferConversationInput` / `TransferConversationResult` / `HandoffBriefRow` 都已在顶部 import。

定位 `createConversation(...): Promise<Conversation>;` 之后追加：

```typescript
    previewHandoffBrief(
      input: PreviewHandoffBriefInput
    ): Promise<PreviewHandoffBriefResult>;
    getHandoffBriefByTarget(
      targetConversationId: string
    ): Promise<HandoffBriefRow | undefined>;
    transferConversation(
      input: TransferConversationInput
    ): Promise<TransferConversationResult>;
```

- [ ] **Step 8: 在 `src/services/cli/client.ts` 加方法**

定位现有 `createConversation` 方法之后追加：

```typescript
  previewHandoffBrief(input: PreviewHandoffBriefInput): Promise<PreviewHandoffBriefResult> {
    return api().previewHandoffBrief(input);
  },

  getHandoffBriefByTarget(targetConversationId: string): Promise<HandoffBriefRow | undefined> {
    return api().getHandoffBriefByTarget(targetConversationId);
  },

  transferConversation(input: TransferConversationInput): Promise<TransferConversationResult> {
    return api().transferConversation(input);
  },
```

确保 client.ts 顶部 import 了新类型。

- [ ] **Step 9: 运行类型检查 + 测试**

Run: `npm run typecheck && npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add electron/cli/ipc.ts electron/preload.ts src/services/cli/types.ts src/services/cli/client.ts src/types/freebuddy.d.ts tests/handoff-transfer-wiring.test.mjs
git commit -m "feat(handoff): expose preview/transfer/getHandoffBrief IPC"
```

---

## Task 10: conversationStore.transferConversation action

**Files:**
- Modify: `src/store/conversationStore.ts`

- [ ] **Step 1: 在 `ConversationState` 接口加 action 签名**

定位 `export interface ConversationState {` 块，在 `newConversation(...)` 之后追加：

```typescript
  transferConversation(input: {
    sourceConversationId: string;
    targetMember: CLIMember;
    cwd?: string;
  }): Promise<{ conversation: Conversation; seedPrompt: string; warning?: "brief_extraction_failed" }>;
```

- [ ] **Step 2: 实现 `transferConversation`**

在 store 实现里（`newConversation` 函数之后）加：

```typescript
  async transferConversation({ sourceConversationId, targetMember, cwd }) {
    if (transferInFlight) {
      throw new Error("Another transfer is in progress");
    }
    transferInFlight = true;
    try {
      const targetConversationId = nanoid();
      const result = await cliClient.transferConversation({
        sourceConversationId,
        targetConversationId,
        targetAgentId: targetMember.id,
        targetAgentName: targetMember.name,
        targetAdapter: targetMember.cli.adapter,
        cwd
      });
      set((s) => ({
        conversations: [
          result.conversation,
          ...s.conversations.filter((c) => c.id !== result.conversation.id)
        ],
        activeId: result.conversation.id,
        messages: { ...s.messages, [result.conversation.id]: [] },
        pendingFreshContext: {
          ...s.pendingFreshContext,
          [result.conversation.id]: true
        },
        pendingTransferSeed: {
          ...s.pendingTransferSeed,
          [result.conversation.id]: result.seedPrompt
        }
      }));
      ensureWorkflowMessageSubscription(result.conversation.id, async (cid, messageIds) => {
        await get().loadMessages(cid, messageIds);
      });
      return {
        conversation: result.conversation,
        seedPrompt: result.seedPrompt,
        warning: result.warning
      };
    } finally {
      transferInFlight = false;
    }
  },
```

- [ ] **Step 3: 在 store state 初始值里加 `pendingTransferSeed`**

定位 `pendingFreshContext: Record<string, boolean>;` 字段，在 `ConversationState` 接口里追加：

```typescript
  pendingTransferSeed: Record<string, string>;
```

并在 store 初始 `set({...})` 里（`pendingFreshContext: {}` 旁）加 `pendingTransferSeed: {}`。

- [ ] **Step 4: 在 store 模块顶部加 in-flight 锁**

```typescript
let transferInFlight = false;
```

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/conversationStore.ts
git commit -m "feat(handoff): add transferConversation store action with seed prompt"
```

---

## Task 11: sendMessage 懒恢复 + 消耗 seed

**前提**：Task 9 已暴露 `cliClient.getHandoffBriefByTarget`。

**Files:**
- Modify: `src/store/conversationStore.ts`

- [ ] **Step 1: 在 store 文件顶部 helpers 区加 `maybeHandoffArgs`**

```typescript
async function maybeHandoffArgs(
  state: ConversationState,
  conv: Conversation
): Promise<
  Pick<CliRunArgs, "handoffBrief" | "handoffBriefId">
> {
  if (!conv.sourceBriefId) return {};
  // 懒恢复：仅当 B 还没有任何 assistant 消息（首条未发）时注入
  const msgs = state.messages[conv.id] ?? [];
  const hasAssistant = msgs.some((m) => m.role === "assistant");
  if (hasAssistant) return {};
  const row = await cliClient.getHandoffBriefByTarget(conv.id);
  if (!row?.brief) return {};
  return {
    handoffBrief: row.brief,
    handoffBriefId: row.id
  };
}
```

- [ ] **Step 2: 修改 `sendMessage` 把 handoff 字段注入 runArgs**

定位 `sendMessage` 里 `const runArgs: CliRunArgs = { ... }` 块，在 `announceSkills: wantFresh || !resumedFromSessionId` 之后追加：

```typescript
      ...(await maybeHandoffArgs(get(), conv))
```

注意 `runArgs` 必须改为 `await` 后再构造——若 runArgs 当前不是 await 表达式，需重构成 `const handoff = await maybeHandoffArgs(get(), conv); const runArgs: CliRunArgs = { ..., ...handoff };`。

- [ ] **Step 3: 消耗 pendingTransferSeed（避免下次发送又注入）**

在 `sendMessage` 成功 dispatch cliExecutor 之后（函数末尾），追加：

```typescript
    set((s) => {
      const nextSeeds = { ...s.pendingTransferSeed };
      delete nextSeeds[conversationId];
      return { pendingTransferSeed: nextSeeds };
    });
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `npm run typecheck && npm run build:electron && node --test tests/handoff-transfer-wiring.test.mjs`
Expected: PASS（wiring 已在 Task 9 覆盖）

- [ ] **Step 5: Commit**

```bash
git add src/store/conversationStore.ts
git commit -m "feat(handoff): lazy MCP injection on first send of transferred conversation"
```

---

## Task 12: TransferDialog 组件

**Files:**
- Create: `src/components/CLI/TransferDialog.tsx`

- [ ] **Step 1: 实现组件**

```typescript
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CLIMember } from "@/config/aiMembers";
import { useConversationStore } from "@/store/conversationStore";
import { cliClient } from "@/services/cli/client";
import type {
  Conversation,
  HandoffBrief,
  PreviewHandoffBriefResult
} from "@/services/cli/types";

interface TransferDialogProps {
  source: Conversation;
  members: CLIMember[];
  onClose(): void;
}

export function TransferDialog({ source, members, onClose }: TransferDialogProps) {
  const { t } = useTranslation();
  const transferConversation = useConversationStore((s) => s.transferConversation);
  const [targetMemberId, setTargetMemberId] = useState<string>("");
  const [cwd, setCwd] = useState<string>(source.cwd ?? "");
  const [preview, setPreview] = useState<PreviewHandoffBriefResult | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    cliClient
      .previewHandoffBrief({ sourceConversationId: source.id })
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  const targetMember = useMemo(
    () => members.find((m) => m.id === targetMemberId),
    [members, targetMemberId]
  );

  const cwdMismatch = source.cwd && cwd && source.cwd !== cwd;

  const onConfirm = async () => {
    if (!targetMember) return;
    if (cwdMismatch) {
      const ok = window.confirm(t("handoff.cwdMismatchConfirm"));
      if (!ok) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await transferConversation({
        sourceConversationId: source.id,
        targetMember,
        cwd: cwd.trim() || undefined
      });
      if (result.warning === "brief_extraction_failed") {
        // 不阻塞，只提示
        console.warn("[FreeBuddy] Transfer completed but brief extraction failed");
      }
      onClose();
    } catch (e) {
      setError((e as Error).message || String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="transfer-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="transfer-dialog">
        <h3>{t("handoff.dialogTitle")}</h3>
        <p className="transfer-dialog-subtitle">
          {t("handoff.dialogSubtitle", {
            title: source.title,
            agentName: source.agentName
          })}
        </p>

        <label className="transfer-dialog-field">
          <span>{t("handoff.targetAgent")}</span>
          <select
            value={targetMemberId}
            onChange={(e) => setTargetMemberId(e.target.value)}
            disabled={submitting}
          >
            <option value="">{t("handoff.selectAgent")}</option>
            {members.map((m) => (
              <option
                key={m.id}
                value={m.id}
                disabled={m.id === source.agentId}
              >
                {m.name}
                {m.id === source.agentId ? ` (${t("handoff.current")})` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="transfer-dialog-field">
          <span>{t("handoff.workspace")}</span>
          <input
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            disabled={submitting}
          />
        </label>

        <div className="transfer-dialog-preview-toggle">
          <button
            type="button"
            className="link-button"
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? t("handoff.hidePreview") : t("handoff.showPreview")}
          </button>
        </div>
        {showPreview && (
          <BriefPreview preview={preview} error={previewError} />
        )}

        {error && <div className="transfer-dialog-error">{error}</div>}

        <div className="transfer-dialog-actions">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            {t("handoff.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={onConfirm}
            disabled={!targetMember || submitting}
          >
            {submitting ? t("handoff.transferring") : t("handoff.transfer")}
          </button>
        </div>
      </div>
    </div>
  );
}

function BriefPreview({
  preview,
  error
}: {
  preview: PreviewHandoffBriefResult | null;
  error: boolean;
}) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div className="transfer-dialog-preview-warning">
        {t("handoff.previewUnavailable")}
      </div>
    );
  }
  if (!preview) return null;
  const brief: HandoffBrief | null = preview.brief;
  if (!brief) {
    return (
      <div className="transfer-dialog-preview-warning">
        {t("handoff.previewEmpty")}
      </div>
    );
  }
  return (
    <pre className="transfer-dialog-preview">
      {JSON.stringify(brief, null, 2)}
    </pre>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/CLI/TransferDialog.tsx
git commit -m "feat(handoff): add TransferDialog component"
```

---

## Task 13: ChatView 集成（按钮 + badge + prefill）

**Files:**
- Modify: `src/components/CLI/ChatView.tsx`

- [ ] **Step 1: import TransferDialog 和 lucide 图标**

在 ChatView.tsx 顶部 import 区追加：

```typescript
import { ArrowLeftRight } from "lucide-react";
import { TransferDialog } from "./TransferDialog";
```

- [ ] **Step 2: 加 state 控制对话框**

在组件内合适位置（其他 useState 旁）：

```typescript
  const [transferOpen, setTransferOpen] = useState(false);
  const pendingTransferSeed = useConversationStore((s) => s.pendingTransferSeed);
```

- [ ] **Step 3: 在 composer-context-row 渲染区加 Transfer 按钮**

定位 `<div className="composer-context-row">...</div>` 块，把内部的 `<span>` 之后追加一个按钮：

```tsx
            <button
              type="button"
              className="composer-context-transfer"
              title={t("handoff.transferAction")}
              onClick={() => setTransferOpen(true)}
              aria-label={t("handoff.transferAction")}
            >
              <ArrowLeftRight size={14} />
            </button>
```

- [ ] **Step 4: 渲染 TransferDialog**

在 ChatView 返回的 JSX 末尾追加：

```tsx
      {transferOpen && activeConversation && (
        <TransferDialog
          source={activeConversation}
          members={members}
          onClose={() => setTransferOpen(false)}
        />
      )}
```

（`members` 和 `activeConversation` 应已在 ChatView 作用域内可用；若名字不同，按实际改）

- [ ] **Step 5: 渲染 origin badge**

在 composer-context-row 上方或内部加：

```tsx
      {activeConversation?.sourceBriefId && (
        <div className="conversation-origin-badge">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              if (activeConversation.sourceConversationId) {
                void useConversationStore.getState().setActive(activeConversation.sourceConversationId);
              }
            }}
          >
            ⇄ {t("handoff.inheritedFrom", { agentName: activeConversation.sourceAgentName ?? "?" })}
            {activeConversation.sourceConversationId ? " · →" : ""}
          </button>
        </div>
      )}
```

- [ ] **Step 6: composer textarea prefill：监测 pendingTransferSeed**

在 ChatView 已有的处理 `newTaskDraft` 的 useEffect 旁加一个：

```typescript
  useEffect(() => {
    if (!activeConversation) return;
    const seed = pendingTransferSeed[activeConversation.id];
    if (seed && chatDraft === "") {
      setChatDraft(seed);
    }
  }, [activeConversation, pendingTransferSeed, chatDraft]);
```

注意：`chatDraft` 是 ChatView 里 composer 的当前文本 state（若名字不同按实际改）。仅当 composer 当前为空时才灌入，避免覆盖用户已开始打字的内容。

- [ ] **Step 7: 类型检查 + 构建**

Run: `npm run typecheck && npm run build:electron`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/components/CLI/ChatView.tsx
git commit -m "feat(handoff): integrate transfer button, origin badge, and composer prefill"
```

---

## Task 14: i18n strings

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/zh-CN.json`

- [ ] **Step 1: en.json 加 key**

在顶层对象里加：

```json
  "handoff": {
    "transferAction": "Transfer to another agent",
    "dialogTitle": "Transfer conversation",
    "dialogSubtitle": "Hand off \"{{title}}\" from {{agentName}} to another agent",
    "targetAgent": "Target agent",
    "selectAgent": "Select an agent…",
    "current": "current",
    "workspace": "Workspace",
    "showPreview": "Show handoff brief preview",
    "hidePreview": "Hide preview",
    "previewUnavailable": "Brief preview unavailable. You can still transfer.",
    "previewEmpty": "No prior context available from the source conversation.",
    "cancel": "Cancel",
    "transfer": "Transfer",
    "transferring": "Transferring…",
    "cwdMismatchConfirm": "Workspace differs from the source. The target agent won't see the same files. Continue?",
    "inheritedFrom": "Inherited from {{agentName}}",
    "transferFailed": "Transfer failed",
    "briefExtractionFailed": "Transfer completed but no context was carried over. Tell the new agent manually."
  },
```

- [ ] **Step 2: zh-CN.json 加对应 key**

```json
  "handoff": {
    "transferAction": "转接到其他 agent",
    "dialogTitle": "转接会话",
    "dialogSubtitle": "将「{{title}}」从 {{agentName}} 转接给其他 agent",
    "targetAgent": "目标 agent",
    "selectAgent": "选择 agent…",
    "current": "当前",
    "workspace": "工作区",
    "showPreview": "展开交班 brief 预览",
    "hidePreview": "收起预览",
    "previewUnavailable": "Brief 预览不可用。仍可继续转接。",
    "previewEmpty": "源会话无前置上下文。",
    "cancel": "取消",
    "transfer": "转接",
    "transferring": "转接中…",
    "cwdMismatchConfirm": "工作区与源会话不一致，目标 agent 看不到相同的文件。继续？",
    "inheritedFrom": "继承自 {{agentName}}",
    "transferFailed": "转接失败",
    "briefExtractionFailed": "转接完成但未携带上下文，请手动告知新 agent。"
  },
```

- [ ] **Step 3: 类型检查 + i18n 测试**

Run: `npm run typecheck && npm run build:electron && node --test tests/i18n-strings.test.mjs`
Expected: PASS（CJK 测试只扫 src/，i18n/ 不影响）

- [ ] **Step 4: Commit**

```bash
git add src/i18n/en.json src/i18n/zh-CN.json
git commit -m "feat(handoff): add i18n strings for transfer UI"
```

---

## Task 15: 全量验证 + smoke

**Files:**
- 无新文件

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: build**

Run: `npm run build:electron`
Expected: PASS（dist-electron/ 全部生成）

- [ ] **Step 3: 全套测试**

Run: `npm test`
Expected: 77 个测试文件全部 PASS（原 73 + 新增 4）

- [ ] **Step 4: dev 模式 smoke**

Run: `npm run dev`

手工验证清单：
- 在 Codex 会话发几条消息（含一次代码改动）
- 点 composer 顶部 ⇄ 按钮 → TransferDialog 弹出
- 选 Claude / 不改 cwd / 展开 brief 预览 → 看到内容
- 点 Transfer → 切到新 Claude 会话
- 顶部出现"⇄ 继承自 Codex"badge
- composer 自动填入 seed prompt
- 回车发送 → Claude 调 `read_handoff_brief` → 看到回复中包含 brief 信息
- 点 badge 的 → 跳回 Codex 会话
- 在 Codex 会话再发一条消息 → 正常工作（A 未受影响）

- [ ] **Step 5: 边界 smoke**

- 空 Codex 会话直接转接 → Claude 创建成功，seed prompt 提示无上下文
- 转接到不同 cwd → 弹 cwdMismatchConfirm
- 转接后关闭 app 重启 → 打开 B → 仍能看到 origin badge；回车发送 → MCP 仍注入（懒恢复生效）

- [ ] **Step 6: Commit（如有 smoke 中发现的修复）**

```bash
git add -A
git commit -m "fix(handoff): smoke test fixes"
```

若无修复，跳过。

---

## Self-Review 备注

完成所有 task 后回头核对 spec 覆盖：

- ✅ §1 架构总览 → Tasks 1-15 全覆盖
- ✅ §2 数据模型 → Task 2（schema）+ Task 3（DB 层）+ Task 4（source_*）
- ✅ §3 MCP 服务 → Task 6（toolService）+ Task 7（MCP server）
- ✅ §4 抽取算法 → Task 5（含全测试覆盖）
- ✅ §5 UI 流程 → Tasks 9, 10, 12, 13（IPC + store + dialog + ChatView）
- ✅ §6 错误处理 → Tasks 5（抽取容错）+ 9（preview 失败）+ 11（懒恢复）+ 15（smoke）
- ✅ §7 测试策略 → Tasks 2/4/6/8/9（wiring）+ 3（DB）+ 5（extractor）+ 7（MCP）

**潜在风险点**（执行时留意）：
1. Task 11 的 `maybeHandoffArgs` 是 async；`sendMessage` 现有 `runArgs` 构造可能是同步表达式，需改成 `await` 后再组装
2. Task 13 的 ChatView 现有 state 变量名（`chatDraft` / `activeConversation` / `members`）需按实际名字同步——计划用了占位名
3. Task 9 的 `nanoid` import 是否已在 ipc.ts 顶部存在；若无需引入
4. Task 11 的 `maybeHandoffArgs` 与 `sendMessage` 现有 `workflowFollowupContext` 的 prompt 拼接顺序不冲突（handoff 走 MCP 不走 prompt，互不干扰）

执行过程中遇到 spec 与实现的偏差，回到 spec 文档更新（spec 是 source of truth）。

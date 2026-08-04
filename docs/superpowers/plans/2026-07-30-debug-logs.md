# 调试日志导出功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户一键导出脱敏（或完整）的 zip 诊断包（应用日志 + agent 会话日志 + 环境快照），帮助开发者远程定位问题。

**Architecture:** 自建轻量 logger：主进程 JSONL 落盘（按天 + 7 天保留 + 10MB 轮转）、渲染端批量 IPC 转发、既有 cli-logs 会话日志纳入导出；导出时按 standard/full 两种模式过滤后用 adm-zip 打包。纯逻辑全部放 `electron/shared/` 以便 node:test 真单测；Electron 绑定层只做薄接线。

**Tech Stack:** Electron, React 19, TypeScript, node:test, adm-zip（已有依赖）, zustand, react-i18next

**Spec:** `docs/superpowers/specs/2026-07-30-debug-logs-design.md`

## 关键既有模式（实施前必读）

- IPC：`electron/cli/ipc.ts` 里 `registerHandler("channel", (event, ...args) => ...)`（来自 `electron/invokeRegistry.ts`）。**新 channel 不在 `electron/shared/remoteChannelPolicy.ts` 白名单中即默认拒绝远程调用——本功能三个 channel 都不加白名单，这是有意的（桌面端专属）**
- preload：`electron/preload.ts` 按域对象（如 `const cli = {...}`）+ 底部 `contextBridge.exposeInMainWorld("freebuddy", {...})`；类型声明在 `src/types/freebuddy.d.ts` 的 `FreebuddyApi`
- 测试：`npm test` 先 `build:electron` 再 `node --test tests/*.mjs`。纯 TS 模块的真单测用 `ts.transpileModule` + data: URL import（见 `tests/workspace-path-guard.test.mjs`）；契约测试直接读源码正则断言（见 `tests/telemetry.test.mjs`）
- i18n：只需改 `src/locales/en.json` + `zh-CN.json`，key 一致性由 `tests/i18n-strings.test.mjs` 自动校验（两份 JSON 的 key 集合必须完全一致）
- Modal 模式：`<div className="modal-backdrop" onMouseDown={...}><div className="modal ..." role="dialog" aria-modal="true">`（见 `ShareConversationDialog.tsx`）
- toast：`useAgentBridgeStore((s) => s.notify)` → `notify("文案")`
- 菜单模式：见 `ReplayBar.tsx` 的 `TitlebarOverflowMenu`（对话右上角 "..." 菜单，挂在 App.tsx titlebar）

## 文件结构

**新增：**
- `electron/shared/logSanitize.ts` — 纯函数：密钥打码、路径掩码、内容剥离、会话日志行过滤（零依赖，可单测）
- `electron/shared/debugLogCore.ts` — 纯逻辑 logger 工厂（注入目录/时钟，只用 node:fs，不 import electron，可单测）
- `electron/shared/environmentInfo.ts` — 纯函数：environment.json 构建
- `electron/debugLog.ts` — Electron 绑定：单例 logger、console 接管、崩溃钩子、渲染端写入入口
- `electron/debugLogExport.ts` — Electron 绑定：预览构建、zip 导出、保存对话框
- `src/services/debugLog.ts` — 渲染端 logger（批量缓冲 + 全局错误钩子）
- `src/store/debugLogsDialogStore.ts` — 对话框开关状态（zustand）
- `src/components/Settings/ExportDebugLogsDialog.tsx` — 导出对话框
- `tests/log-sanitize.test.mjs`、`tests/debug-log-rotation.test.mjs`、`tests/debug-log-export.test.mjs`

**改动：**
- `electron/cli/runtimeShared.ts` — `appendLog` 写入时密钥打码
- `electron/cli/db.ts` — 启动时清理 7 天前 cli-logs
- `electron/main.ts` — `initDebugLog()` + 生命周期/崩溃打点
- `electron/cli/acpRuntime.ts` — `finish()` 打点；`electron/cli/runtime.ts` — 运行开始打点
- `electron/cli/ipc.ts`、`electron/preload.ts`、`src/types/freebuddy.d.ts` — 三个 channel 接线
- `src/main.tsx` — 安装渲染端 logger
- `src/store/conversationStore.ts` — 发送失败打点
- `src/components/CLI/StreamItem.tsx`（错误块入口）、`src/components/CLI/ReplayBar.tsx`（菜单入口）、`src/components/Settings/AboutTab.tsx`（About 入口）
- `src/App.tsx` — 挂载对话框；`styles.css` — 样式；`src/locales/en.json` + `zh-CN.json` — 文案

---

### Task 1: logSanitize 纯函数模块

**Files:**
- Create: `electron/shared/logSanitize.ts`
- Test: `tests/log-sanitize.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/log-sanitize.test.mjs`：

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function load() {
  const source = fs.readFileSync(
    new URL("../electron/shared/logSanitize.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("redactsecrets masks sk- keys keeping a 6-char prefix", async () => {
  const { redactsecrets } = await load();
  assert.equal(
    redactsecrets("key is sk-ant-abc123def456ghi789"),
    "key is sk-ant…<redacted>"
  );
});

test("redactsecrets masks bearer tokens and key=value secrets", async () => {
  const { redactsecrets } = await load();
  assert.equal(redactsecrets("Bearer abcdef1234567890"), "Bearer <redacted>");
  assert.equal(redactsecrets('api_key="supersecretvalue123"'), 'api_key="<redacted>"');
  assert.equal(redactsecrets("short: abc"), "short: abc"); // < 8 chars untouched
});

test("buildPathMasks sorts longest-first so userData beats home", async () => {
  const { buildPathMasks, maskPaths } = await load();
  const masks = buildPathMasks({
    home: "/Users/alice",
    userData: "/Users/alice/Library/Application Support/freebuddy",
    workspaces: ["/Users/alice/code/proj"]
  });
  assert.equal(
    maskPaths("cwd=/Users/alice/code/proj db in /Users/alice/Library/Application Support/freebuddy/x", masks),
    "cwd=<workspace> db in <appdata>/x"
  );
  assert.equal(maskPaths("home is /Users/alice/other", masks), "home is <home>/other");
});

test("sanitizeLogData redacts content keys with length marker and masks paths", async () => {
  const { sanitizeLogData, buildPathMasks } = await load();
  const masks = buildPathMasks({ home: "/h", userData: "/h/app", workspaces: [] });
  const out = sanitizeLogData(
    { content: "hello world", prompt: 42, cwd: "/h/work", note: "ok" },
    masks
  );
  assert.equal(out.content, "<redacted: 11 chars>");
  assert.equal(out.prompt, 42); // non-string content values pass through
  assert.equal(out.cwd, "<home>/work");
  assert.equal(out.note, "ok");
});

test("filterSessionLogLine full mode only redacts secrets", async () => {
  const { filterSessionLogLine } = await load();
  const line = JSON.stringify({ ts: "t", type: "stdin", content: "sk-ant-abc123def456" });
  const out = JSON.parse(filterSessionLogLine(line, "full", []));
  assert.equal(out.content, "sk-ant…<redacted>");
  assert.equal(out.type, "stdin");
});

test("filterSessionLogLine standard keeps system/stderr with path masks", async () => {
  const { filterSessionLogLine, buildPathMasks } = await load();
  const masks = buildPathMasks({ home: "/h", userData: "/h/app", workspaces: ["/h/w"] });
  const sys = JSON.stringify({ ts: "t", type: "system", content: "start adapter=codex cwd=/h/w" });
  assert.equal(
    JSON.parse(filterSessionLogLine(sys, "standard", masks)).content,
    "start adapter=codex cwd=<workspace>"
  );
  const err = JSON.stringify({ ts: "t", type: "stderr", content: "boom at /h/app/x" });
  assert.equal(JSON.parse(filterSessionLogLine(err, "standard", masks)).content, "boom at <appdata>/x");
});

test("filterSessionLogLine standard strips stdin/stdout payloads but keeps event, error, usage", async () => {
  const { filterSessionLogLine } = await load();
  const payload = JSON.stringify({
    msg: { type: "assistant", text: "private reply", usage: { input_tokens: 1200, output_tokens: 55 } }
  });
  const line = JSON.stringify({ ts: "t", type: "stdout", content: payload });
  const out = JSON.parse(filterSessionLogLine(line, "standard", []));
  assert.equal(out.event, "assistant");
  assert.deepEqual(out.usage, { input_tokens: 1200, output_tokens: 55 });
  assert.equal(out.content, `<redacted: ${payload.length} chars>`);
  assert.ok(!JSON.stringify(out).includes("private reply"));
});

test("filterSessionLogLine standard keeps agent error messages like Compacting failed", async () => {
  const { filterSessionLogLine } = await load();
  const line = JSON.stringify({
    ts: "t",
    type: "stdout",
    content: JSON.stringify({ error: { code: -32603, message: "Compacting failed: aborted" } })
  });
  const out = JSON.parse(filterSessionLogLine(line, "standard", []));
  assert.equal(out.error, "Compacting failed: aborted");
  assert.equal(out.errorCode, -32603);
});

test("filterSessionLogLine standard replaces unparseable lines with a length marker", async () => {
  const { filterSessionLogLine } = await load();
  const out = JSON.parse(filterSessionLogLine("not json at all", "standard", []));
  assert.equal(out.type, "unparsed");
  assert.equal(out.content, "<redacted: 15 chars>");
});

test("filterOwnLogLine standard sanitizes data and msg, full keeps content", async () => {
  const { filterOwnLogLine, buildPathMasks } = await load();
  const masks = buildPathMasks({ home: "/h", userData: "/h/app", workspaces: [] });
  const line = JSON.stringify({ ts: "t", level: "error", scope: "chat", msg: "failed in /h/w", data: { content: "secret text" } });
  const std = JSON.parse(filterOwnLogLine(line, "standard", masks));
  assert.equal(std.msg, "failed in <home>/w");
  assert.equal(std.data.content, "<redacted: 11 chars>");
  const full = JSON.parse(filterOwnLogLine(line, "full", masks));
  assert.equal(full.data.content, "secret text");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/log-sanitize.test.mjs`
Expected: FAIL（`Cannot find module` / readFileSync ENOENT，模块不存在）

- [ ] **Step 3: 实现 logSanitize.ts**

创建 `electron/shared/logSanitize.ts`：

```typescript
/**
 * Pure log-sanitization helpers shared by write-time redaction and
 * export-time filtering. No Node/Electron imports so tests can transpile
 * and load this file directly (see tests/log-sanitize.test.mjs).
 */

export type ExportMode = "standard" | "full";

/** data keys whose values are user message content, stripped in standard mode. */
export const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "content",
  "prompt",
  "messageText",
  "output"
]);

export function redactedLengthMarker(length: number): string {
  return `<redacted: ${length} chars>`;
}

const secret_RULES: Array<[RegExp, (...args: string[]) => string]> = [
  [/Authorization(["'\s:=]+)[^\s"',\]}]{8,}/gi, (_m, sep) => `Authorization${sep}<redacted>`],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, () => "Bearer <redacted>"],
  [/sk-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 6)}…<redacted>`],
  [
    /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|secret)["'\s:=]+)[^\s"',\]}]{8,}/gi,
    (_m, prefix) => `${prefix}<redacted>`
  ]
];

/** Mask API keys / tokens. Safe on JSON text: replacements contain no quotes. */
export function redactsecrets(text: string): string {
  let out = text;
  for (const [re, repl] of secret_RULES) out = out.replace(re, repl);
  return out;
}

export interface PathMask {
  prefix: string;
  label: string;
}

/** Longest-first so more specific paths (userData under home) win. */
export function buildPathMasks(input: {
  home: string;
  userData: string;
  workspaces: string[];
}): PathMask[] {
  const masks: PathMask[] = [
    { prefix: input.userData, label: "<appdata>" },
    { prefix: input.home, label: "<home>" },
    ...input.workspaces.map((prefix) => ({ prefix, label: "<workspace>" }))
  ].filter((m) => m.prefix.length > 0);
  return masks.sort((a, b) => b.prefix.length - a.prefix.length);
}

export function maskPaths(text: string, masks: PathMask[]): string {
  let out = text;
  for (const { prefix, label } of masks) {
    if (out.includes(prefix)) out = out.split(prefix).join(label);
  }
  return out;
}

/** Standard-mode filtering for our own log lines' `data` payloads (shallow). */
export function sanitizeLogData(data: unknown, masks: PathMask[]): unknown {
  if (typeof data === "string") return maskPaths(redactsecrets(data), masks);
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (CONTENT_KEYS.has(key) && typeof value === "string") {
      out[key] = redactedLengthMarker(value.length);
    } else if (typeof value === "string") {
      out[key] = maskPaths(redactsecrets(value), masks);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Export-time filter for one line of our own main/renderer JSONL logs. */
export function filterOwnLogLine(
  line: string,
  mode: ExportMode,
  masks: PathMask[]
): string {
  if (mode === "full") return redactsecrets(line);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return maskPaths(redactsecrets(line), masks);
  }
  const out: Record<string, unknown> = { ...obj };
  if (typeof out.msg === "string") out.msg = maskPaths(redactsecrets(out.msg), masks);
  if ("data" in out) out.data = sanitizeLogData(out.data, masks);
  return JSON.stringify(out);
}

/**
 * Export-time filter for one line of cli-logs/<sessionId>.jsonl
 * ({ts, type: "stdin"|"stdout"|"stderr"|"system", content}).
 * Standard mode keeps structure + numeric metadata + error messages,
 * replaces protocol payloads with a length marker.
 */
export function filterSessionLogLine(
  line: string,
  mode: ExportMode,
  masks: PathMask[]
): string {
  if (mode === "full") return redactsecrets(line);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ type: "unparsed", content: redactedLengthMarker(line.length) });
  }
  const type = typeof obj.type === "string" ? obj.type : "unknown";
  const content = typeof obj.content === "string" ? obj.content : "";
  if (type === "system" || type === "stderr") {
    return JSON.stringify({
      ...obj,
      content: maskPaths(redactsecrets(content), masks)
    });
  }
  const summary: Record<string, unknown> = { ts: obj.ts ?? null, type };
  try {
    const payload = JSON.parse(content) as Record<string, unknown>;
    const msg = (payload?.msg ?? payload) as Record<string, unknown>;
    if (typeof msg?.type === "string") summary.event = msg.type;
    else if (typeof payload?.method === "string") summary.event = payload.method;
    const err = (payload?.error ?? msg?.error) as Record<string, unknown> | undefined;
    if (err && typeof err.message === "string") {
      summary.error = maskPaths(redactsecrets(err.message), masks);
    }
    if (err && typeof err.code !== "undefined") summary.errorCode = err.code;
    const usage = (msg?.usage ?? payload?.usage) as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      const numeric = Object.fromEntries(
        Object.entries(usage).filter(([, v]) => typeof v === "number")
      );
      if (Object.keys(numeric).length > 0) summary.usage = numeric;
    }
  } catch {
    /* content is not JSON — structure-only summary */
  }
  summary.content = redactedLengthMarker(content.length);
  return JSON.stringify(summary);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/log-sanitize.test.mjs`
Expected: PASS（9 个测试）

- [ ] **Step 5: Commit**

```bash
git add electron/shared/logSanitize.ts tests/log-sanitize.test.mjs
git commit -m "feat: add log sanitization helpers for debug log export"
```

---

### Task 2: debugLogCore logger 工厂（落盘 + 轮转 + 保留）

**Files:**
- Create: `electron/shared/debugLogCore.ts`
- Test: `tests/debug-log-rotation.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/debug-log-rotation.test.mjs`：

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

async function load() {
  const sanitizeSource = fs.readFileSync(
    new URL("../electron/shared/logSanitize.ts", import.meta.url), "utf8"
  );
  const coreSource = fs.readFileSync(
    new URL("../electron/shared/debugLogCore.ts", import.meta.url), "utf8"
  );
  const combined = `${sanitizeSource}\n${coreSource.replace(
    /import \{ redactsecrets \} from "\.\/logSanitize\.js";\s*/m, ""
  )}`;
  const output = ts.transpileModule(combined, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debuglog-test-"));
}

test("writes JSONL lines named by source and day, secrets redacted at write time", async () => {
  const { createDebugLogger } = await load();
  const dir = tmpDir();
  const log = createDebugLogger({ dir, source: "main", now: () => new Date("2026-07-30T10:00:00Z") });
  log.info("acp", "started with sk-ant-abc123def456", { adapter: "codex" });
  const file = path.join(dir, "main-2026-07-30.log");
  const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(line.level, "info");
  assert.equal(line.scope, "acp");
  assert.equal(line.msg, "started with sk-ant-…<redacted>");
  assert.equal(line.data.adapter, "codex");
  assert.equal(line.ts, "2026-07-30T10:00:00.000Z");
});

test("rotates a full file to .1 then shifts .1 to .2", async () => {
  const { createDebugLogger } = await load();
  const dir = tmpDir();
  const now = () => new Date("2026-07-30T10:00:00Z");
  const log = createDebugLogger({ dir, source: "main", maxFileBytes: 120, now });
  for (let i = 0; i < 12; i += 1) log.info("s", `line-${i}-padding-padding-padding`);
  assert.ok(fs.existsSync(path.join(dir, "main-2026-07-30.log")));
  assert.ok(fs.existsSync(path.join(dir, "main-2026-07-30.log.1")));
  assert.ok(fs.existsSync(path.join(dir, "main-2026-07-30.log.2")));
});

test("disk failures drop lines and count them instead of throwing", async () => {
  const { createDebugLogger } = await load();
  const log = createDebugLogger({ dir: "/nonexistent/readonly-dir/x", source: "main" });
  log.info("s", "dropped");
  assert.equal(log.droppedLines, 1);
});

test("pruneOldLogs removes files older than retention, keeps recent ones", async () => {
  const { pruneOldLogs } = await load();
  const dir = tmpDir();
  const old = path.join(dir, "abc.jsonl");
  const recent = path.join(dir, "def.jsonl");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(recent, "x");
  const now = new Date("2026-07-30T00:00:00Z");
  const oldTime = new Date("2026-07-20T00:00:00Z");
  fs.utimesSync(old, oldTime, oldTime);
  const removed = pruneOldLogs(dir, 7, now);
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(recent));
});

test("createDebugLogger prunes its own directory on creation", async () => {
  const { createDebugLogger } = await load();
  const dir = tmpDir();
  const old = path.join(dir, "main-2026-07-01.log");
  fs.writeFileSync(old, "x");
  const oldTime = new Date("2026-07-01T00:00:00Z");
  fs.utimesSync(old, oldTime, oldTime);
  createDebugLogger({ dir, source: "main", now: () => new Date("2026-07-30T00:00:00Z") });
  assert.ok(!fs.existsSync(old));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/debug-log-rotation.test.mjs`
Expected: FAIL（ENOENT，模块不存在）

- [ ] **Step 3: 实现 debugLogCore.ts**

创建 `electron/shared/debugLogCore.ts`：

```typescript
/**
 * Core debug-log writer. Pure Node (fs/path only, directory and clock
 * injected) so tests can transpile and load it directly. The Electron
 * singleton wiring lives in electron/debugLog.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { redactsecrets } from "./logSanitize.js";

export type DebugLogLevel = "info" | "warn" | "error" | "debug";

export const LOG_RETENTION_DAYS = 7;
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROTATIONS = 2; // base file + .1 + .2 = 同日最多 3 份

export interface DebugLogger {
  write(level: DebugLogLevel, scope: string, msg: string, data?: unknown): void;
  info(scope: string, msg: string, data?: unknown): void;
  warn(scope: string, msg: string, data?: unknown): void;
  error(scope: string, msg: string, data?: unknown): void;
  debug(scope: string, msg: string, data?: unknown): void;
  readonly droppedLines: number;
  readonly dir: string;
}

/** Delete *.log / *.jsonl (and .N rotations) older than retentionDays. */
export function pruneOldLogs(dir: string, retentionDays: number, now = new Date()): number {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(log|jsonl)(\.\d+)?$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function rotateIfFull(file: string, maxFileBytes: number): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // does not exist yet
  }
  if (size < maxFileBytes) return;
  for (let i = MAX_ROTATIONS - 1; i >= 1; i -= 1) {
    const from = `${file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

export function createDebugLogger(opts: {
  dir: string;
  source: string;
  maxFileBytes?: number;
  now?: () => Date;
}): DebugLogger {
  const maxFileBytes = opts.maxFileBytes ?? MAX_LOG_FILE_BYTES;
  const now = opts.now ?? (() => new Date());
  let droppedLines = 0;
  try {
    fs.mkdirSync(opts.dir, { recursive: true });
    pruneOldLogs(opts.dir, LOG_RETENTION_DAYS, now());
  } catch {
    /* logging must never take the app down */
  }

  const write = (level: DebugLogLevel, scope: string, msg: string, data?: unknown): void => {
    try {
      const entry: Record<string, unknown> = {
        ts: now().toISOString(),
        level,
        scope,
        msg
      };
      if (data !== undefined) entry.data = data;
      const line = redactsecrets(JSON.stringify(entry));
      const file = path.join(opts.dir, `${opts.source}-${dayStamp(now())}.log`);
      rotateIfFull(file, maxFileBytes);
      fs.appendFileSync(file, line + "\n");
    } catch {
      droppedLines += 1;
    }
  };

  return {
    write,
    info: (scope, msg, data) => write("info", scope, msg, data),
    warn: (scope, msg, data) => write("warn", scope, msg, data),
    error: (scope, msg, data) => write("error", scope, msg, data),
    debug: (scope, msg, data) => write("debug", scope, msg, data),
    get droppedLines() {
      return droppedLines;
    },
    dir: opts.dir
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/debug-log-rotation.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: Commit**

```bash
git add electron/shared/debugLogCore.ts tests/debug-log-rotation.test.mjs
git commit -m "feat: add debug log writer with rotation and retention"
```

---

### Task 3: Electron 单例 logger + main.ts 接线

**Files:**
- Create: `electron/debugLog.ts`
- Modify: `electron/main.ts`（whenReady 开头、createWindow 内、`initializeTelemetry();` 附近）

- [ ] **Step 1: 实现 electron/debugLog.ts**

```typescript
/**
 * Electron-bound debug log singleton: owns the main-process logger,
 * intercepts console.* and process-level crash hooks, and accepts
 * batched log entries forwarded from the renderer.
 */
import { app } from "electron";
import path from "node:path";
import {
  createDebugLogger,
  type DebugLogger,
  type DebugLogLevel
} from "./shared/debugLogCore.js";

const LEVELS: ReadonlySet<string> = new Set(["info", "warn", "error", "debug"]);
const MAX_RENDERER_MSG_CHARS = 4000;
const MAX_RENDERER_BATCH = 100;

let mainLogger: DebugLogger | null = null;
let rendererLogger: DebugLogger | null = null;

const noopLogger: DebugLogger = {
  write: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  droppedLines: 0,
  dir: ""
};

export function logMain(): DebugLogger {
  return mainLogger ?? noopLogger;
}

export function mainLogDroppedLines(): number {
  return mainLogger?.droppedLines ?? 0;
}

export function debugLogDir(): string {
  return path.join(app.getPath("userData"), "freebuddy", "logs");
}

function toConsoleArgs(scope: string, msg: string, data?: unknown): unknown[] {
  return data === undefined ? [`[${scope}]`, msg] : [`[${scope}]`, msg, data];
}

/** Route console.* into the log file while preserving original output. */
function interceptConsole(logger: DebugLogger): void {
  const wrap =
    (level: DebugLogLevel, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const msg = args
        .map((a) => (typeof a === "string" ? a : safeStringify(a)))
        .join(" ");
      logger.write(level, "console", msg);
      original.apply(console, args);
    };
  console.log = wrap("info", console.log.bind(console));
  console.info = wrap("info", console.info.bind(console));
  console.warn = wrap("warn", console.warn.bind(console));
  console.error = wrap("error", console.error.bind(console));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function initDebugLog(): void {
  if (mainLogger) return;
  try {
    const dir = debugLogDir();
    mainLogger = createDebugLogger({ dir, source: "main" });
    rendererLogger = createDebugLogger({ dir, source: "renderer" });
    interceptConsole(mainLogger);
    process.on("uncaughtException", (err) => {
      logMain().error("crash", "uncaughtException", {
        message: err.message,
        stack: err.stack?.slice(0, 4000)
      });
    });
    process.on("unhandledRejection", (reason) => {
      logMain().error("crash", "unhandledRejection", {
        reason: safeStringify(reason)?.slice(0, 2000)
      });
    });
    logMain().info("main", "debug log initialized", { dir });
  } catch {
    mainLogger = null; // degrade to no-op
  }
}

/** Validate and persist a batch of renderer entries (IPC debugLog:write). */
export function appendRendererLogEntries(entries: unknown): void {
  const logger = rendererLogger;
  if (!logger || !Array.isArray(entries)) return;
  for (const raw of entries.slice(0, MAX_RENDERER_BATCH)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.msg !== "string" || typeof e.scope !== "string") continue;
    const level = LEVELS.has(e.level as string) ? (e.level as DebugLogLevel) : "info";
    logger.write(level, e.scope.slice(0, 40), e.msg.slice(0, MAX_RENDERER_MSG_CHARS), e.data);
  }
}
```

- [ ] **Step 2: main.ts 接线（3 处插入）**

在 `electron/main.ts` 顶部 import 区加：

```typescript
import { initDebugLog, logMain } from "./debugLog.js";
```

插入点 1 — `app.whenReady()` 回调内**第一行**（在 `initializeTelemetry();` 之前）：

```typescript
  initDebugLog();
  logMain().info("main", "app ready", {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch
  });
```

插入点 2 — `createWindow()` 里 `mainWindow = new BrowserWindow({...});` 之后、`initApplicationMenu();` 之前：

```typescript
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logMain().error("crash", "render process gone", {
      reason: details.reason,
      exitCode: details.exitCode
    });
  });
  logMain().info("window", "main window created");
```

- [ ] **Step 3: 编译验证**

Run: `npm run build:electron`
Expected: 编译通过无错误

- [ ] **Step 4: 手动冒烟（可选但推荐）**

Run: `npm run dev`，启动后退出，检查 `~/Library/Application Support/Electron/freebuddy/logs/main-*.log`（dev 下 userData 是 `Electron`）有 `app ready` 和 `debug log initialized` 行

- [ ] **Step 5: Commit**

```bash
git add electron/debugLog.ts electron/main.ts
git commit -m "feat: wire main-process debug logger with crash hooks"
```

---

### Task 4: appendLog 密钥打码 + cli-logs 7 天清理

**Files:**
- Modify: `electron/cli/runtimeShared.ts`（`appendLog`，约 :258）
- Modify: `electron/cli/db.ts`（`getDb()`）
- Test: `tests/log-sanitize.test.mjs`（追加用例）

- [ ] **Step 1: 追加失败测试**

在 `tests/log-sanitize.test.mjs` 末尾追加（`appendLog` 是纯函数，可直接测——它只依赖 fs 类型签名）：

```javascript
test("appendLog redacts secrets before writing session log lines", async () => {
  const sanitizeSource = fs.readFileSync(
    new URL("../electron/shared/logSanitize.ts", import.meta.url), "utf8"
  );
  const sharedSource = fs.readFileSync(
    new URL("../electron/cli/runtimeShared.ts", import.meta.url), "utf8"
  );
  // appendLog 位于文件尾部且只用到 fs 类型；抽出函数体连同依赖常量一起编译
  const fnMatch = sharedSource.match(
    /const MAX_LOG_LINE_CHARS[\s\S]*?^export function appendLog[\s\S]*?\n}/m
  );
  assert.ok(fnMatch, "appendLog source found");
  const combined = `${sanitizeSource}\n${fnMatch[0]
    .replace(/import[^\n]*\n/g, "")
    .replace("export function appendLog", "function appendLog")
    .replace("fs.WriteStream | null", "unknown")}\nexport { appendLog };`;
  const output = ts.transpileModule(combined, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const { appendLog } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
  const writes = [];
  const fakeStream = { writableEnded: false, destroyed: false, write: (s) => writes.push(s) };
  appendLog(fakeStream, "stderr", "auth failed for sk-ant-abc123def456");
  const line = JSON.parse(writes[0]);
  assert.equal(line.content, "auth failed for sk-ant-…<redacted>");
});
```

Run: `node --test tests/log-sanitize.test.mjs`
Expected: 新用例 FAIL（内容未打码）

注意：此测试用正则抽取 `appendLog` 源码，若 `runtimeShared.ts` 中该函数结构变化需同步更新正则。

- [ ] **Step 2: 修改 appendLog**

`electron/cli/runtimeShared.ts` 顶部 import 区加：

```typescript
import { redactsecrets } from "../shared/logSanitize.js";
```

`appendLog` 函数体内，把：

```typescript
  const safeContent =
    content.length > MAX_LOG_LINE_CHARS
      ? `${content.slice(0, MAX_LOG_LINE_CHARS)}\n… [log truncated]`
      : content;
```

改为：

```typescript
  const safeContent = redactsecrets(
    content.length > MAX_LOG_LINE_CHARS
      ? `${content.slice(0, MAX_LOG_LINE_CHARS)}\n… [log truncated]`
      : content
  );
```

- [ ] **Step 3: db.ts 启动清理 cli-logs**

`electron/cli/db.ts` 顶部 import 区加：

```typescript
import { pruneOldLogs, LOG_RETENTION_DAYS } from "../shared/debugLogCore.js";
```

`getDb()` 里 `dbInstance = db;` 之前插入：

```typescript
  try {
    pruneOldLogs(getLogDir(), LOG_RETENTION_DAYS);
  } catch {
    /* best-effort: log cleanup must never block startup */
  }
```

- [ ] **Step 4: 运行测试 + 编译**

Run: `node --test tests/log-sanitize.test.mjs && npm run build:electron`
Expected: 全部 PASS，编译通过

- [ ] **Step 5: Commit**

```bash
git add electron/cli/runtimeShared.ts electron/cli/db.ts tests/log-sanitize.test.mjs
git commit -m "feat: redact secrets in agent session logs and prune old cli-logs"
```

---

### Task 5: environmentInfo 纯函数

**Files:**
- Create: `electron/shared/environmentInfo.ts`
- Test: `tests/environment-info.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/environment-info.test.mjs`：

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function load() {
  const source = fs.readFileSync(
    new URL("../electron/shared/environmentInfo.ts", import.meta.url), "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("buildEnvironmentInfo shapes the environment.json snapshot", async () => {
  const { buildEnvironmentInfo } = await load();
  const info = buildEnvironmentInfo({
    appVersion: "0.6.8",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.22631",
    locale: "zh-CN",
    versions: { electron: "35.0.0", chrome: "134.0.0", node: "22.0.0" },
    telemetryEnabled: true,
    adapters: [{ id: "codex", label: "Codex" }],
    conversationCount: 12,
    droppedLines: 0,
    exportedAt: "2026-07-30T01:02:03.000Z",
    exportMode: "standard"
  });
  assert.equal(info.app.version, "0.6.8");
  assert.equal(info.app.platform, "win32");
  assert.equal(info.runtime.electron, "35.0.0");
  assert.equal(info.telemetry.enabled, true);
  assert.deepEqual(info.adapters, [{ id: "codex", label: "Codex" }]);
  assert.equal(info.counts.conversations, 12);
  assert.equal(info.logHealth.droppedLines, 0);
  assert.equal(info.exportMode, "standard");
});

test("environment info never includes paths, usernames or message content", async () => {
  const { buildEnvironmentInfo } = await load();
  const serialized = JSON.stringify(buildEnvironmentInfo({
    appVersion: "0.6.8", platform: "darwin", arch: "arm64", osRelease: "24.5.0",
    locale: "en", versions: {}, telemetryEnabled: false,
    adapters: [], conversationCount: 0, droppedLines: 0,
    exportedAt: "t", exportMode: "full"
  }));
  assert.doesNotMatch(serialized, /workspacePath|cwd|home|message/i);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/environment-info.test.mjs`
Expected: FAIL（ENOENT）

- [ ] **Step 3: 实现 environmentInfo.ts**

创建 `electron/shared/environmentInfo.ts`：

```typescript
/** Pure builder for the environment.json included in debug log exports. */

export interface EnvironmentInfoInput {
  appVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  locale: string;
  versions: { electron?: string; chrome?: string; node?: string };
  telemetryEnabled: boolean;
  adapters: Array<{ id: string; label?: string }>;
  conversationCount: number;
  droppedLines: number;
  exportedAt: string;
  exportMode: "standard" | "full";
}

export function buildEnvironmentInfo(
  input: EnvironmentInfoInput
): Record<string, unknown> {
  return {
    app: {
      version: input.appVersion,
      platform: input.platform,
      arch: input.arch,
      osRelease: input.osRelease,
      locale: input.locale
    },
    runtime: {
      electron: input.versions.electron ?? "",
      chrome: input.versions.chrome ?? "",
      node: input.versions.node ?? ""
    },
    telemetry: { enabled: input.telemetryEnabled },
    adapters: input.adapters.map((a) => ({ id: a.id, label: a.label ?? a.id })),
    counts: { conversations: input.conversationCount },
    logHealth: { droppedLines: input.droppedLines },
    exportedAt: input.exportedAt,
    exportMode: input.exportMode
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/environment-info.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/shared/environmentInfo.ts tests/environment-info.test.mjs
git commit -m "feat: add environment info builder for debug exports"
```

---

### Task 6: debugLogExport（预览 + zip 导出）

**Files:**
- Create: `electron/debugLogExport.ts`

说明：本模块是 Electron 绑定层（dialog/adm-zip/DB），用 Task 12 的契约测试 + Task 13 手动验证覆盖，不写隔离单测。

- [ ] **Step 1: 实现 debugLogExport.ts**

先确认 `electron/cli/ipc.ts:7` 的 `import { cliAdapterDefinitions } from "./adapters.js";`（已核实），本文件复用同一来源。

创建 `electron/debugLogExport.ts`：

```typescript
/**
 * Builds the debug-log zip bundle: app logs + recent agent session logs
 * (cli-logs) + environment.json, filtered by export mode.
 */
import { app, dialog, type BrowserWindow } from "electron";
import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { debugLogDir, mainLogDroppedLines } from "./debugLog.js";
import { getDb, getLogDir } from "./cli/db.js";
import { getSetting } from "./cli/settings.js";
import { cliAdapterDefinitions } from "./cli/adapters.js";
import { buildEnvironmentInfo } from "./shared/environmentInfo.js";
import {
  buildPathMasks,
  filterOwnLogLine,
  filterSessionLogLine,
  type ExportMode,
  type PathMask
} from "./shared/logSanitize.js";

const SESSION_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_FILES = 20;
const PREVIEW_LINES = 200;

export interface DebugLogPreviewFile {
  name: string;
  totalLines: number;
  lines: string[];
  truncated: boolean;
}

export interface DebugLogPreview {
  environment: Record<string, unknown>;
  files: DebugLogPreviewFile[];
}

function gatherPathMasks(): PathMask[] {
  const workspaces = new Set<string>();
  try {
    const db = getDb();
    for (const row of db
      .prepare("SELECT DISTINCT cwd FROM conversations WHERE cwd IS NOT NULL")
      .all() as Array<{ cwd: string }>) {
      if (row.cwd) workspaces.add(row.cwd);
    }
    for (const row of db
      .prepare("SELECT DISTINCT cwd FROM cli_tasks WHERE cwd IS NOT NULL")
      .all() as Array<{ cwd: string }>) {
      if (row.cwd) workspaces.add(row.cwd);
    }
  } catch {
    /* masks degrade gracefully */
  }
  return buildPathMasks({
    home: os.homedir(),
    userData: app.getPath("userData"),
    workspaces: [...workspaces]
  });
}

function gatherEnvironment(mode: ExportMode, exportedAt: string): Record<string, unknown> {
  let conversationCount = 0;
  try {
    conversationCount = (
      getDb().prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }
    ).n;
  } catch {
    /* keep 0 */
  }
  let locale = "";
  try {
    locale = app.getLocale();
  } catch {
    /* not ready */
  }
  return buildEnvironmentInfo({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    locale,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    telemetryEnabled: getSetting("telemetry.enabled") !== "0",
    adapters: cliAdapterDefinitions.map((d) => ({
      id: d.id,
      label: (d as { label?: string }).label ?? d.id
    })),
    conversationCount,
    droppedLines: mainLogDroppedLines(),
    exportedAt,
    exportMode: mode
  });
}

function filterLines(lines: string[], kind: "own" | "session", mode: ExportMode, masks: PathMask[]): string[] {
  const filter = kind === "own" ? filterOwnLogLine : filterSessionLogLine;
  return lines.filter((l) => l.trim().length > 0).map((l) => filter(l, mode, masks));
}

function readAppLogFiles(mode: ExportMode, masks: PathMask[]): Array<{ name: string; lines: string[] }> {
  const out: Array<{ name: string; lines: string[] }> = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(debugLogDir());
  } catch {
    return out;
  }
  for (const name of entries.filter((n) => /\.(log)(\.\d+)?$/.test(n)).sort()) {
    try {
      const text = fs.readFileSync(path.join(debugLogDir(), name), "utf8");
      out.push({ name, lines: filterLines(text.split("\n"), "own", mode, masks) });
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

function readSessionLogFiles(mode: ExportMode, masks: PathMask[]): Array<{ name: string; lines: string[] }> {
  const out: Array<{ name: string; lines: string[] }> = [];
  let stat: Array<{ name: string; mtimeMs: number }> = [];
  try {
    stat = fs
      .readdirSync(getLogDir())
      .filter((n) => n.endsWith(".jsonl"))
      .map((name) => ({
        name,
        mtimeMs: fs.statSync(path.join(getLogDir(), name)).mtimeMs
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return out;
  }
  for (const { name } of stat.slice(0, MAX_SESSION_FILES)) {
    const file = path.join(getLogDir(), name);
    try {
      const size = fs.statSync(file).size;
      let text: string;
      let truncated = false;
      if (size > SESSION_TAIL_BYTES) {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(SESSION_TAIL_BYTES);
        fs.readSync(fd, buf, 0, SESSION_TAIL_BYTES, size - SESSION_TAIL_BYTES);
        fs.closeSync(fd);
        text = buf.toString("utf8");
        text = text.slice(text.indexOf("\n") + 1); // drop partial first line
        truncated = true;
      } else {
        text = fs.readFileSync(file, "utf8");
      }
      const lines = filterLines(text.split("\n"), "session", mode, masks);
      if (truncated) {
        lines.unshift(
          JSON.stringify({ type: "system", content: "[export] truncated to last 2MB" })
        );
      }
      out.push({ name, lines });
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

function collectBundle(mode: ExportMode, exportedAt: string) {
  const masks = gatherPathMasks();
  return {
    environment: gatherEnvironment(mode, exportedAt),
    appLogs: readAppLogFiles(mode, masks),
    sessionLogs: readSessionLogFiles(mode, masks)
  };
}

export async function buildDebugLogPreview(mode: ExportMode): Promise<DebugLogPreview> {
  const { environment, appLogs, sessionLogs } = collectBundle(mode, new Date().toISOString());
  const files: DebugLogPreviewFile[] = [...appLogs, ...sessionLogs].map((f) => ({
    name: f.name,
    totalLines: f.lines.length,
    lines: f.lines.slice(-PREVIEW_LINES),
    truncated: f.lines.length > PREVIEW_LINES
  }));
  return { environment, files };
}

function readmeText(mode: ExportMode, exportedAt: string): string {
  return [
    "FreeBuddy debug log bundle",
    `Exported at: ${exportedAt}`,
    `Mode: ${mode}${mode === "standard" ? " (message content and paths redacted)" : " (FULL — contains conversation content)"}`,
    "",
    "logs/       app logs (JSONL: {ts, level, scope, msg, data?})",
    "sessions/   agent session transcripts (JSONL: {ts, type, content})",
    "environment.json  environment snapshot",
    "",
    "Please attach this file to a GitHub issue or send it to the developers."
  ].join("\n");
}

export async function exportDebugLogs(
  parent: BrowserWindow,
  mode: ExportMode
): Promise<{ path?: string; canceled?: boolean }> {
  const exportedAt = new Date().toISOString();
  const stamp = exportedAt.replace(/[:.]/g, "-");
  const result = await dialog.showSaveDialog(parent, {
    title: "Export debug logs",
    defaultPath: path.join(app.getPath("downloads"), `freebuddy-debug-${stamp}.zip`),
    filters: [{ name: "Zip archive", extensions: ["zip"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const { environment, appLogs, sessionLogs } = collectBundle(mode, exportedAt);
  const zip = new AdmZip();
  zip.addFile("environment.json", Buffer.from(JSON.stringify(environment, null, 2)));
  zip.addFile("README.txt", Buffer.from(readmeText(mode, exportedAt)));
  for (const f of appLogs) {
    zip.addFile(`logs/${f.name}`, Buffer.from(f.lines.join("\n") + "\n"));
  }
  for (const f of sessionLogs) {
    zip.addFile(`sessions/${f.name}`, Buffer.from(f.lines.join("\n") + "\n"));
  }
  zip.writeZip(result.filePath);
  return { path: result.filePath };
}
```

注意：`cliAdapterDefinitions` 来自 `electron/cli/adapters.ts:94`（`./cli/adapters.js`），已核实与 ipc.ts:7 同源。

- [ ] **Step 2: 编译验证**

Run: `npm run build:electron`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add electron/debugLogExport.ts
git commit -m "feat: add debug log bundle builder with mode filtering"
```

---

### Task 7: IPC + preload + 类型声明

**Files:**
- Modify: `electron/cli/ipc.ts`（`registerCliIpc()` 内任意 registerHandler 群附近）
- Modify: `electron/preload.ts`（域对象区 + exposeInMainWorld 块）
- Modify: `src/types/freebuddy.d.ts`（`FreebuddyApi`）

- [ ] **Step 1: 注册三个 channel**

`electron/cli/ipc.ts` 顶部 import 区加：

```typescript
import { appendRendererLogEntries } from "../debugLog.js";
import { buildDebugLogPreview, exportDebugLogs } from "../debugLogExport.js";
import { BrowserWindow } from "electron";
```

（若 `BrowserWindow` 已被引入则跳过第三条。）在 `registerCliIpc()` 函数体内加：

```typescript
  registerHandler("debugLog:write", (_event, entries: unknown) => {
    appendRendererLogEntries(entries);
  });
  registerHandler("debugLogs:preview", (_event, mode: unknown) =>
    buildDebugLogPreview(mode === "full" ? "full" : "standard")
  );
  registerHandler("debugLogs:export", (event, mode: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error("no window");
    return exportDebugLogs(win, mode === "full" ? "full" : "standard");
  });
```

**不要**把这三个 channel 加进 `electron/shared/remoteChannelPolicy.ts`——默认拒绝远程调用是本功能的隐私设计。

- [ ] **Step 2: preload 暴露**

`electron/preload.ts` 域对象区（`const updater = {...}` 附近）加：

```typescript
const debugLogs = {
  write: (entries: unknown[]) => ipcRenderer.invoke("debugLog:write", entries),
  preview: (mode: "standard" | "full") =>
    ipcRenderer.invoke("debugLogs:preview", mode),
  export: (mode: "standard" | "full") =>
    ipcRenderer.invoke("debugLogs:export", mode) as Promise<{
      path?: string;
      canceled?: boolean;
    }>
};
```

底部 `contextBridge.exposeInMainWorld("freebuddy", { ... updater,` 后加 `debugLogs,`。

- [ ] **Step 3: 类型声明**

`src/types/freebuddy.d.ts` 中，`FreebuddyUpdater` 接口定义附近加：

```typescript
    interface FreebuddyDebugLogs {
      write: (entries: unknown[]) => Promise<unknown>;
      preview: (mode: "standard" | "full") => Promise<{
        environment: Record<string, unknown>;
        files: Array<{
          name: string;
          totalLines: number;
          lines: string[];
          truncated: boolean;
        }>;
      }>;
      export: (mode: "standard" | "full") => Promise<{ path?: string; canceled?: boolean }>;
    }
```

`FreebuddyApi` 里 `updater: FreebuddyUpdater;` 之后加：

```typescript
    debugLogs: FreebuddyDebugLogs;
```

- [ ] **Step 4: 编译 + 类型检查**

Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add electron/cli/ipc.ts electron/preload.ts src/types/freebuddy.d.ts
git commit -m "feat: expose debug log write/preview/export over IPC"
```

---

### Task 8: 渲染端 logger 客户端

**Files:**
- Create: `src/services/debugLog.ts`
- Modify: `src/main.tsx`

- [ ] **Step 1: 实现 debugLog.ts**

创建 `src/services/debugLog.ts`：

```typescript
/**
 * Renderer-side debug logger. Batches entries and forwards them to the
 * main process (debugLog:write IPC), which persists them to
 * renderer-YYYY-MM-DD.log. Never throws: logging must not break the app.
 */

type Level = "info" | "warn" | "error" | "debug";

interface Entry {
  ts: string;
  level: Level;
  scope: string;
  msg: string;
  data?: unknown;
}

const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH = 100;
const MAX_MSG_CHARS = 4000;

let queue: Entry[] = [];
let timer: number | null = null;

function cloneData(data: unknown): unknown {
  if (data === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return String(data);
  }
}

function enqueue(level: Level, scope: string, msg: string, data?: unknown): void {
  queue.push({
    ts: new Date().toISOString(),
    level,
    scope: scope.slice(0, 40),
    msg: String(msg).slice(0, MAX_MSG_CHARS),
    ...(data !== undefined ? { data: cloneData(data) } : {})
  });
  if (queue.length > MAX_BATCH) queue.splice(0, queue.length - MAX_BATCH);
  schedule();
}

function schedule(): void {
  if (timer !== null) return;
  timer = window.setTimeout(flush, FLUSH_INTERVAL_MS);
}

function flush(): void {
  timer = null;
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    void window.freebuddy?.debugLogs?.write(batch)?.catch(() => {
      /* drop on IPC failure */
    });
  } catch {
    /* drop */
  }
}

export const debugLogClient = {
  info: (scope: string, msg: string, data?: unknown) => enqueue("info", scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown) => enqueue("warn", scope, msg, data),
  error: (scope: string, msg: string, data?: unknown) => enqueue("error", scope, msg, data),
  debug: (scope: string, msg: string, data?: unknown) => enqueue("debug", scope, msg, data)
};

let installed = false;

/** Global error hooks. Call once from the renderer entry point. */
export function installDebugLogClient(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    enqueue("error", "renderer", event.message, {
      stack: event.error?.stack?.slice(0, 2000)
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    enqueue("error", "renderer", "unhandled rejection", {
      reason: String(event.reason).slice(0, 1000)
    });
  });
  window.addEventListener("pagehide", flush);
}
```

- [ ] **Step 2: main.tsx 安装**

`src/main.tsx` 在 `import "../styles.css";` 后加：

```typescript
import { installDebugLogClient } from "./services/debugLog";

installDebugLogClient();
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/services/debugLog.ts src/main.tsx
git commit -m "feat: add renderer debug log client with global error hooks"
```

---

### Task 9: i18n 文案

**Files:**
- Modify: `src/locales/en.json`、`src/locales/zh-CN.json`

- [ ] **Step 1: en.json 新增顶级 section**

在顶层 `"updater": { ... }` 之后加（注意前后逗号）：

```json
  "debugLogs": {
    "title": "Export debug logs",
    "aboutSectionTitle": "Diagnostics",
    "aboutSectionHint": "Export a diagnostic bundle to help the developers troubleshoot issues.",
    "openButton": "Export debug logs…",
    "dialogTitle": "Export debug logs",
    "modeStandard": "Standard (recommended)",
    "modeStandardHint": "Message content, paths and keys are redacted.",
    "modeFull": "Full",
    "modeFullWarning": "Includes conversation content and real paths. Only share privately with developers you trust.",
    "previewLoading": "Loading preview…",
    "previewEmpty": "No log files yet.",
    "previewTruncated": "Showing last {shown} of {total} lines",
    "export": "Export…",
    "exporting": "Exporting…",
    "cancel": "Cancel",
    "success": "Debug logs saved to {path}",
    "error": "Failed to export debug logs: {message}",
    "exportLink": "Export debug logs"
  },
```

- [ ] **Step 2: zh-CN.json 同样位置新增**

```json
  "debugLogs": {
    "title": "导出调试日志",
    "aboutSectionTitle": "诊断",
    "aboutSectionHint": "导出诊断日志包，帮助开发者定位你遇到的问题。",
    "openButton": "导出调试日志…",
    "dialogTitle": "导出调试日志",
    "modeStandard": "标准模式（推荐）",
    "modeStandardHint": "已脱敏：不含消息内容、真实路径和密钥。",
    "modeFull": "完整模式",
    "modeFullWarning": "包含对话内容和真实路径，仅供私下发送给你信任的开发者。",
    "previewLoading": "正在加载预览…",
    "previewEmpty": "还没有日志文件。",
    "previewTruncated": "显示最后 {shown} 行，共 {total} 行",
    "export": "导出…",
    "exporting": "导出中…",
    "cancel": "取消",
    "success": "调试日志已保存到 {path}",
    "error": "导出调试日志失败：{message}",
    "exportLink": "导出调试日志"
  },
```

- [ ] **Step 3: 运行 i18n 测试**

Run: `node --test tests/i18n-strings.test.mjs tests/i18n-settings.test.mjs`
Expected: PASS（key 集合一致）

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/zh-CN.json
git commit -m "feat: add debug logs i18n strings"
```

---

### Task 10: 导出对话框 + 状态 store + 样式 + App 挂载

**Files:**
- Create: `src/store/debugLogsDialogStore.ts`
- Create: `src/components/Settings/ExportDebugLogsDialog.tsx`
- Modify: `src/App.tsx`（`<PermissionDialog />` 附近）
- Modify: `styles.css`（末尾追加）

- [ ] **Step 1: store**

创建 `src/store/debugLogsDialogStore.ts`：

```typescript
import { create } from "zustand";

interface DebugLogsDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useDebugLogsDialogStore = create<DebugLogsDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}));
```

- [ ] **Step 2: 对话框组件**

创建 `src/components/Settings/ExportDebugLogsDialog.tsx`：

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDebugLogsDialogStore } from "@/store/debugLogsDialogStore";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";

type Mode = "standard" | "full";

interface Preview {
  environment: Record<string, unknown>;
  files: Array<{ name: string; totalLines: number; lines: string[]; truncated: boolean }>;
}

export function ExportDebugLogsDialog() {
  const { t } = useTranslation();
  const open = useDebugLogsDialogStore((s) => s.open);
  const setOpen = useDebugLogsDialogStore((s) => s.setOpen);
  const notify = useAgentBridgeStore((s) => s.notify);
  const [mode, setMode] = useState<Mode>("standard");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    window.freebuddy?.debugLogs
      ?.preview(mode)
      .then((p) => {
        if (!cancelled) setPreview(p as Preview);
      })
      .catch(() => {
        if (!cancelled) setPreview({ environment: {}, files: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode]);

  if (!open) return null;

  const close = () => {
    if (!busy) setOpen(false);
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const result = await window.freebuddy?.debugLogs?.export(mode);
      if (result?.path) {
        notify(t("debugLogs.success", { path: result.path }));
        setOpen(false);
      }
    } catch (err) {
      notify(
        t("debugLogs.error", { message: (err as Error)?.message ?? String(err) })
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop debug-logs-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="modal debug-logs-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("debugLogs.dialogTitle")}
      >
        <h3>{t("debugLogs.dialogTitle")}</h3>

        <div className="debug-logs-modes" role="radiogroup">
          <label className="debug-logs-mode">
            <input
              type="radio"
              name="debug-logs-mode"
              checked={mode === "standard"}
              onChange={() => setMode("standard")}
            />
            <span>
              <strong>{t("debugLogs.modeStandard")}</strong>
              <small>{t("debugLogs.modeStandardHint")}</small>
            </span>
          </label>
          <label className="debug-logs-mode">
            <input
              type="radio"
              name="debug-logs-mode"
              checked={mode === "full"}
              onChange={() => setMode("full")}
            />
            <span>
              <strong>{t("debugLogs.modeFull")}</strong>
              <small className="debug-logs-mode-warning">
                {t("debugLogs.modeFullWarning")}
              </small>
            </span>
          </label>
        </div>

        <div className="debug-logs-preview">
          {!preview && <p className="muted">{t("debugLogs.previewLoading")}</p>}
          {preview && (
            <details className="debug-logs-preview-file">
              <summary>environment.json</summary>
              <pre>{JSON.stringify(preview.environment, null, 2)}</pre>
            </details>
          )}
          {preview && preview.files.length === 0 && (
            <p className="muted">{t("debugLogs.previewEmpty")}</p>
          )}
          {preview &&
            preview.files.map((f) => (
              <details key={f.name} className="debug-logs-preview-file">
                <summary>
                  {f.name}
                  {f.truncated && (
                    <small>
                      {" "}
                      {t("debugLogs.previewTruncated", {
                        shown: f.lines.length,
                        total: f.totalLines
                      })}
                    </small>
                  )}
                </summary>
                <pre>{f.lines.join("\n")}</pre>
              </details>
            ))}
        </div>

        <div className="debug-logs-actions">
          <button type="button" className="link-btn" disabled={busy} onClick={close}>
            {t("debugLogs.cancel")}
          </button>
          <button
            type="button"
            className="primary-btn"
            disabled={busy}
            onClick={() => void doExport()}
          >
            {busy ? t("debugLogs.exporting") : t("debugLogs.export")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

注意：确认 `@/store/agentBridgeStore` 的导出名（ChatView 用的是 `useAgentBridgeStore`）；`@` alias 已在 vite/tsconfig 配置（AboutTab 用了 `@/store/updaterStore`）。

- [ ] **Step 3: 样式（styles.css 末尾追加）**

```css
.debug-logs-dialog {
  max-width: 640px;
  width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.debug-logs-modes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.debug-logs-mode {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.debug-logs-mode small {
  display: block;
  opacity: 0.7;
}
.debug-logs-mode-warning {
  color: var(--warning-color, #d97706);
}
.debug-logs-preview {
  flex: 1;
  min-height: 120px;
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border-color, #333);
  border-radius: 6px;
  padding: 8px;
}
.debug-logs-preview-file pre {
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow: auto;
}
.debug-logs-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
```

- [ ] **Step 4: App.tsx 挂载**

`src/App.tsx` import 区加：

```tsx
import { ExportDebugLogsDialog } from "./components/Settings/ExportDebugLogsDialog";
```

JSX 中 `<PermissionDialog />` 后加：

```tsx
      <ExportDebugLogsDialog />
```

- [ ] **Step 5: 类型检查 + 构建**

Run: `npm run typecheck && npm run build:renderer`
Expected: 通过

- [ ] **Step 6: Commit**

```bash
git add src/store/debugLogsDialogStore.ts src/components/Settings/ExportDebugLogsDialog.tsx src/App.tsx styles.css
git commit -m "feat: add export debug logs dialog with mode selection and preview"
```

---

### Task 11: 三个入口

**Files:**
- Modify: `src/components/Settings/AboutTab.tsx`
- Modify: `src/components/CLI/StreamItem.tsx`（`case "error":`，约 :978）
- Modify: `src/components/CLI/ReplayBar.tsx`（`TitlebarOverflowMenu` 菜单，约 :349-364）

- [ ] **Step 1: AboutTab 诊断区块**

`AboutTab.tsx` import 区加：

```tsx
import { useDebugLogsDialogStore } from "@/store/debugLogsDialogStore";
```

组件内（其他 store hook 附近）加：

```tsx
  const setDebugLogsOpen = useDebugLogsDialogStore((s) => s.setOpen);
```

在「链接」section（`updater.linksTitle` 那个 `<section className="settings-section">`）之后加：

```tsx
      <section className="settings-section">
        <h3>{t("debugLogs.aboutSectionTitle")}</h3>
        <p className="about-hint">{t("debugLogs.aboutSectionHint")}</p>
        <button
          type="button"
          className="primary-btn"
          onClick={() => setDebugLogsOpen(true)}
        >
          {t("debugLogs.openButton")}
        </button>
      </section>
```

- [ ] **Step 2: 错误气泡入口**

`StreamItem.tsx` import 区加：

```tsx
import { useDebugLogsDialogStore } from "@/store/debugLogsDialogStore";
```

`case "error":` 的 JSX 改为（在原 `<div className="stream-error">` 结构基础上加按钮）：

```tsx
    case "error":
      return (
        <div className="stream-error">
          <div>
            <span className="stream-label">{t("stream.errorLabel")}</span> {item.message}
          </div>
          {item.details?.length ? (
            <details className="stream-error-details">
              {/* 保持原有 details 内容不变 */}
            </details>
          ) : null}
          <button
            type="button"
            className="link-btn stream-error-export-logs"
            onClick={() => useDebugLogsDialogStore.getState().setOpen(true)}
          >
            {t("debugLogs.exportLink")}
          </button>
        </div>
      );
```

注意：`item.details` 块原有 JSX 原样保留，上面的 `...` 只是示意——实施时只插入 `<button>`，不重写 details 内容。

- [ ] **Step 3: "..." 菜单入口**

`ReplayBar.tsx` import 区加（lucide-react 已有 FileDown 图标）：

```tsx
import { FileDown } from "lucide-react";
import { useDebugLogsDialogStore } from "@/store/debugLogsDialogStore";
```

`TitlebarOverflowMenu` 的 `<div className="titlebar-overflow-menu" role="menu">` 内、replay 按钮之后加：

```tsx
          <button
            type="button"
            role="menuitem"
            className="titlebar-overflow-item"
            aria-label={t("debugLogs.title")}
            title={t("debugLogs.title")}
            onClick={() => {
              useDebugLogsDialogStore.getState().setOpen(true);
              setOpen(false);
            }}
          >
            <FileDown aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{t("debugLogs.title")}</span>
          </button>
```

- [ ] **Step 4: 类型检查 + i18n 测试**

Run: `npm run typecheck && node --test tests/i18n-strings.test.mjs`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/components/Settings/AboutTab.tsx src/components/CLI/StreamItem.tsx src/components/CLI/ReplayBar.tsx
git commit -m "feat: add debug log export entry points (about, error bubble, chat menu)"
```

---

### Task 12: 打点（conversationStore + acpRuntime + runtime + updater）

**Files:**
- Modify: `src/store/conversationStore.ts`（catch 块，约 :1032）
- Modify: `electron/cli/acpRuntime.ts`（`finish()`，约 :183）
- Modify: `electron/cli/runtime.ts`（`cliRun()` 的 `insertTask(...)` 之后，约 :180）
- Modify: `electron/updater.ts`（autoUpdater 事件，:46-72）

- [ ] **Step 1: conversationStore 发送失败打点**

`src/store/conversationStore.ts` import 区加：

```typescript
import { debugLogClient } from "../services/debugLog";
```

catch 块内 `const msg = (err as Error)?.message || String(err);` 之后加：

```typescript
      debugLogClient.error("chat", "agent run failed", { errorMessage: msg });
```

- [ ] **Step 2: acpRuntime finish 打点**

`electron/cli/acpRuntime.ts` import 区加：

```typescript
import { logMain } from "../debugLog.js";
```

`finish` 函数（签名已核实：`finish = (status: "done" | "failed" | "killed", exitCode: number, errorMessage?: string) => {...}`，约 :183）内，`if (errorMessage) emit({ type: "error", message: errorMessage });` 之前加：

```typescript
    logMain()[status === "failed" ? "error" : "info"]("acp", `agent run ${status}`, {
      adapter: args.adapter,
      sessionId: args.sessionId,
      exitCode,
      ...(errorMessage ? { errorMessage } : {})
    });
```

- [ ] **Step 3: runtime.ts 运行开始打点**

`electron/cli/runtime.ts` import 区加：

```typescript
import { logMain } from "../debugLog.js";
```

`insertTask(args, logFile, toolSessionId);` 之后加：

```typescript
  logMain().info("runtime", "agent run start", {
    adapter: args.adapter,
    sessionId: args.sessionId
  });
```

- [ ] **Step 4: 更新器事件打点**

`electron/updater.ts` import 区加：

```typescript
import { logMain } from "./debugLog.js";
```

在 5 个 autoUpdater 事件 handler（:46-72）的第一行各加一条（`download-progress` 太频繁，跳过）：

```typescript
// autoUpdater.on("checking-for-update", () => { 内第一行：
  logMain().info("updater", "checking for update");
// autoUpdater.on("update-available", (info) => { 内第一行：
  logMain().info("updater", "update available", { version: info.version });
// autoUpdater.on("update-not-available", (info) => { 内第一行：
  logMain().info("updater", "update not available", { version: info.version });
// autoUpdater.on("update-downloaded", (info) => { 内第一行：
  logMain().info("updater", "update downloaded", { version: info.version });
// autoUpdater.on("error", (_err, message) => { 内第一行：
  logMain().error("updater", "update error", { message });
```

- [ ] **Step 5: 类型检查 + 编译**

Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 6: Commit**

```bash
git add src/store/conversationStore.ts electron/cli/acpRuntime.ts electron/cli/runtime.ts electron/updater.ts
git commit -m "feat: instrument agent run and updater lifecycle in debug logs"
```

---

### Task 13: 契约测试 + 全量验证

**Files:**
- Create: `tests/debug-log-export.test.mjs`

- [ ] **Step 1: 写契约测试**

创建 `tests/debug-log-export.test.mjs`：

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const ipc = read("../electron/cli/ipc.ts");
const preload = read("../electron/preload.ts");
const types = read("../src/types/freebuddy.d.ts");
const policy = read("../electron/shared/remoteChannelPolicy.ts");
const main = read("../electron/main.ts");
const debugLog = read("../electron/debugLog.ts");
const exporter = read("../electron/debugLogExport.ts");
const runtimeShared = read("../electron/cli/runtimeShared.ts");
const db = read("../electron/cli/db.ts");
const aboutTab = read("../src/components/Settings/AboutTab.tsx");
const streamItem = read("../src/components/CLI/StreamItem.tsx");
const replayBar = read("../src/components/CLI/ReplayBar.tsx");
const app = read("../src/App.tsx");
const updater = read("../electron/updater.ts");
const conversationStore = read("../src/store/conversationStore.ts");
const mainEntry = read("../src/main.tsx");

test("debug log IPC channels are registered and exposed via preload", () => {
  assert.match(ipc, /registerHandler\("debugLog:write"/);
  assert.match(ipc, /registerHandler\("debugLogs:preview"/);
  assert.match(ipc, /registerHandler\("debugLogs:export"/);
  assert.match(preload, /ipcRenderer\.invoke\("debugLog:write"/);
  assert.match(preload, /ipcRenderer\.invoke\("debugLogs:preview"/);
  assert.match(preload, /ipcRenderer\.invoke\("debugLogs:export"/);
  assert.match(types, /FreebuddyDebugLogs/);
});

test("debug log channels are NOT remotely callable (privacy)", () => {
  assert.doesNotMatch(policy, /debugLog/);
});

test("main process logger initializes with crash hooks", () => {
  assert.match(main, /initDebugLog\(\)/);
  assert.match(main, /render-process-gone/);
  assert.match(debugLog, /uncaughtException/);
  assert.match(debugLog, /unhandledRejection/);
});

test("export bundle filters by mode and includes sessions", () => {
  assert.match(exporter, /filterSessionLogLine/);
  assert.match(exporter, /filterOwnLogLine/);
  assert.match(exporter, /sessions\/\$\{f\.name\}/);
  assert.match(exporter, /environment\.json/);
  assert.match(exporter, /dialog\.showSaveDialog/);
});

test("session logs are secret-redacted at write time and pruned", () => {
  assert.match(runtimeShared, /redactsecrets/);
  assert.match(db, /pruneOldLogs/);
});

test("three entry points mount the export dialog", () => {
  assert.match(app, /ExportDebugLogsDialog/);
  assert.match(aboutTab, /debugLogs\.aboutSectionTitle/);
  assert.match(streamItem, /debugLogs\.exportLink/);
  assert.match(replayBar, /debugLogs\.title/);
});

test("renderer logger installs global hooks and instruments run failures", () => {
  assert.match(mainEntry, /installDebugLogClient/);
  assert.match(conversationStore, /debugLogClient\.error/);
});

test("updater lifecycle events are logged", () => {
  assert.match(updater, /logMain\(\)\.info\("updater", "checking for update"\)/);
  assert.match(updater, /logMain\(\)\.error\("updater", "update error"/);
});
```

- [ ] **Step 2: 全量测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全部通过

- [ ] **Step 3: 端到端手动验证**

Run: `npm run dev`

1. 发起一段对话（产生 cli-logs 会话日志）
2. About tab → 导出调试日志 → 选标准模式 → 预览有内容 → 导出 zip
3. 解压检查：`environment.json` 字段完整；`sessions/*.jsonl` 中 prompt 正文已替换为 `<redacted: N chars>`，错误消息保留；路径已掩码
4. 再导出一次完整模式，确认内容完整但密钥仍打码
5. 错误气泡与 "..." 菜单入口能打开同一对话框

- [ ] **Step 4: Commit**

```bash
git add tests/debug-log-export.test.mjs
git commit -m "test: add debug log export contract tests"
```

---

## 实施修订记录（执行中评审产生，以此为准）

- **T1（commit 805929f）**：`filterSessionLogLine` 的 system/stderr 分支改为显式构造 `{ts, type, content}`（不 spread 未知字段）；`sanitizeLogData` 改为递归（深度上限 5，数组逐元素处理）；新增 Authorization/access_token/refresh_token/嵌套字段测试（共 14 个用例）。**已接受的残余风险**：standard 模式保留的 agent 错误消息文本理论上可能引用用户内容，当前按长度自然截断（64KB/行）+ 路径/密钥掩码处理，不做内容剥离——已记录于设计文档
- **T2（commit 92135d6）**：轮转测试的打码期望值为 `"sk-ant…<redacted>"`（T1 加固后 slice(0,6)，计划原文的 `"sk-ant-…"` 已过期）
- **T3（commit 1cce885）**：`appendRendererLogEntries` 的 `e.data` 经 `capRendererData` 上限 4000 序列化字符（小对象保留形状，超限转为截断字符串）；`uncaughtException` 打点同步写盘后 `process.exit(1)`（不再吞掉崩溃）；`safeStringify` 修正 undefined 返回；补拦截 `console.debug`。计划 T3 代码片段以上述提交为准
- **T7（commit b67a2fc）**：**计划缺陷修正**——原文"不要把三个 channel 加进 remoteChannelPolicy.ts"与仓库不变量冲突（`tests/remote-channel-policy.test.mjs` 要求每个 channel 显式分类）。正确做法：三个 channel 加入该文件的 **DENY 数组**（运行时行为相同，显式声明）。**T13 契约测试相应改为断言三个 channel 在 DENY 数组中**（而非原文的 `doesNotMatch(policy, /debugLog/)`）。另：`exportDebugLogs` 的清理范围收窄为仅 writeZip 失败时删除自己创建的部分文件（collectBundle/组装失败不删用户文件）；导出 handler 加 sender 守卫；错误 rethrow 带 `{cause}`

## Self-Review 记录

- Spec 覆盖：三层脱敏（T1/T4/T6）、JSONL logger + 轮转保留（T2/T3/T4）、三入口 + 对话框 + 预览含 environment.json（T9/T10/T11）、environment.json（T5/T6）、打点含更新器事件（T3/T12）、错误处理原则（T2 droppedLines、T8 drop-on-fail）、测试方案（T1/T2/T5/T13）✅
- 有意偏差：`electron/debugLog.ts` 拆为 `shared/debugLogCore.ts`（纯逻辑，可测）+ `electron/debugLog.ts`（Electron 绑定），与 spec 模块职责一致、仅为可测性分层
- 远程调用：三个 channel 均不进 remoteChannelPolicy 白名单（隐私，契约测试守护）
- 已核实锚点：`cliAdapterDefinitions` ← `electron/cli/adapters.ts:94`；`useAgentBridgeStore` ← `@/store/agentBridgeStore`；`finish(status, exitCode, errorMessage?)` ← `acpRuntime.ts:183`；autoUpdater 事件 ← `updater.ts:46-72`

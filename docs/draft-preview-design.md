# Draft — 第三列 Web 预览画布 设计

- 状态:Draft / 待评审
- 版本:v1
- 分支:`feature/conversation-drafts`(基于 `cursor/implement-review-loop-41c1`)
- 关联文件:`src/App.tsx`、`src/components/CLI/WorkspacePanel.tsx`、`src/services/cli/streamParser.ts`、`electron/main.ts`、`electron/freebuddyFileProtocol.ts`

> 说明:本期的「Draft」指**第三列的 web 预览画布**(类似 v0/bolt/Cursor preview),用于实时预览 agent 在工作区里生成的 web 产物,**不是**输入框草稿。

## 1. 概述

在主聊天区右侧第三列放入一个 webview 画布。它把当前会话 `cwd` 下 agent 刚写入/修改的 web 产物(HTML/CSS/JS/资源)当作一个真实网站直接渲染;每当流里出现 `file-edit` 事件就自动刷新。第三列顶部改为 **Tab 容器**,在「概览」(现有 `WorkspacePanel`,状态/usage/plan)与「Draft 预览」之间**自由切换**,两者并存、信息均保留。

## 2. 背景与动机

- coding agent 最常见的产出是「一个能跑的 web 页面」。当前 FreeBuddy 只能在消息流里看到文件被改的 diff,看不到渲染结果,用户得手动切到浏览器/编辑器预览,打断「让 agent 改 → 看效果 → 再改」的循环。
- 产物是真实落在 `cwd` 磁盘上的多文件(HTML 引用相对的 CSS/JS/图片),需要相对路径与模块加载都可用,不能只用 `iframe srcdoc`。

## 3. 目标 / 非目标

**目标**
- G1 第三列直接渲染 `cwd` 下的 web 入口(默认 `index.html`),相对资源、CSS、JS、ESM、fetch 都正常工作。
- G2 监听 agent 流式产物,出现 `file-edit` 即自动防抖刷新(无需手动 F5)。
- G3 第三列改为 Tab 容器,`WorkspacePanel`(概览)与 `DraftCanvas`(预览)**自由切换**,两者并存、信息均保留。
- G4 沙盒安全:预览内容无法触及 Electron / FreeBuddy 运行时;协议只读且限定在 `cwd` 子树内。
- G5 复用现有分层与协议范式,不引入新框架/新依赖。

**非目标**
- N1 不做 dev server 代理 / `localhost` 转发(本期只预览**静态产物**;需要打包/起服务的项目由用户自行构建后再预览)。
- N2 不做多入口 tab / 多画布(单画布,入口可手动指定)。
- N3 不做代码与预览的联动高亮、不做元素检查器(后续增强)。
- N4 不做跨设备/云同步。

## 4. 现状与关键集成点

| 事实 | 位置 | 用途 |
| --- | --- | --- |
| 第三列挂载 | `App.tsx:257-259` `{activeConversation && <WorkspacePanel/>}` | 替换为 `<DraftCanvas/>` |
| `file-edit` 事件结构 | `streamParser.ts:62-69` `{ kind:"file-edit"; path; action; patch?; oldText?; newText? }` | 刷新信号源 |
| 各 parser 都发 file-edit | codex `parsers/codex.ts:216`、opencode `parsers/opencode.ts:92`、claude | 跨 agent 通用 |
| 自定义协议注册范式 | `main.ts:36-51` `registerSchemesAsPrivileged` + `protocol.handle` | 新协议照搬 |
| `Request/Response` handler 写法 | `freebuddyFileProtocol.ts:58` `handleFreebuddyFileRequest` | 新 handler 仿写 |
| 会话 cwd 来源 | `conversation.cwd`(`WorkspacePanel.tsx:221` 已使用) | 确定 web 根 |
| 实时流 items | `conversationStore.live[activeId].items` | 实时刷新监听 |
| 历史流 items | assistant message.content(JSON 数组) | 切回/重启后回放 |

## 5. 整体架构

```
agent 写盘 ─> CLI stdout ─> parser ─> file-edit item
                                        │
              ┌─────────────────────────┴─────────────────────────┐
              ▼(live items / message items)                        ▼
   useDraftPreviewStore 订阅 active 会话 items            entry 探测器(cwd 下找 index.html)
              │ path ∈ webRoot ?                                │
              ▼ debounce 300ms                                  │
        重载 iframe ───────────────────────────────────────────► iframe.src
                                                              = freebuddy-draft:///<rel>?root=<cwd>
                                                                    │
                                                                    ▼(主进程)
                                                         handleDraftRequest()
                                                            只读 serve cwd 子树
```

## 6. 技术方案

### 6.1 webview 容器:iframe + sandbox(主方案)
- 用普通 `<iframe>` 放在第三列,布局随 React/antd 栅格自然流动,**无需**像 `WebContentsView` 那样手动同步窗口坐标(第三列尺寸随窗口/侧栏伸缩变化)。
- `sandbox="allow-scripts allow-forms allow-popups allow-modals"`(刻意**不带** `allow-same-origin`):脚本可跑,但被隔离为唯一 opaque origin,拿不到 FreeBuddy 的 DOM / storage / Electron。
- 刷新:优先 `iframe.contentWindow.location.reload()`;跨 origin 不可访问时退化为重置 `src`(带 `?v=<ts>` 防缓存)。
- **备选(进阶)**:主进程 `WebContentsView` + ResizeObserver 坐标同步,换取独立 devtools / 更强隔离 / 原生路由。本期不采用,留待 §12。

### 6.2 产物加载:新增 `freebuddy-draft` 自定义协议
仿 `freebuddy-file`(`main.ts:36-51`、`freebuddyFileProtocol.ts`)新增第二套:

注册(app ready 前):
```ts
protocol.registerSchemesAsPrivileged([
  { scheme: "freebuddy-draft",
    privileges: { standard: true, secure: true, supportFetchAPI: true,
                  bypassCSP: true, stream: true } }
]);
```
URL 形态:`freebuddy-draft://render/<relPath>?root=<encodeURIComponent(cwd)>`
- 例:入口 `freebuddy-draft://render/index.html?root=D%3A%5Cwww%5Cdemo`
- HTML 内 `<link href="styles.css">`、`<script src="main.js">`、`fetch("./api.json")` 都按同协议解析为 `freebuddy-draft://render/styles.css?root=...`,自动复用同一 `root`。

Handler(`handleDraftRequest`)职责:
1. 解析 `root`(绝对路径,校验 `path.isAbsolute`)与 `relPath`。
2. `path.resolve(root, relPath)` 后**校验结果仍以 `root` 开头**(防 `../../etc/passwd` 目录穿越),否则 403。
3. 仅 `fs.readFile`(只读),MIME 按扩展名查表(扩展 `freebuddyFileProtocol.ts` 的表,补 `html/css/js/mjs/map/wasm/ico/woff2...`);目录请求自动追加 `index.html`。
4. 错误返回 404 页面。

> 复用点:MIME 表与只读读取范式直接借鉴 `freebuddyFileProtocol.ts:53-73`;不复用其「任意绝对路径」语义——draft 必须**锁定 root 子树**。

### 6.3 入口探测
无显式入口时,按序找第一个存在的文件作为 `entryRel`:
1. 用户手设(地址栏输入,持久化到 store)
2. `index.html`
3. `public/index.html`、`dist/index.html`、`build/index.html`
4. 最近一次 `file-edit` 里路径以 `.html` 结尾者

探测由 store 调用一次新 IPC `cli:resolveDraftEntry`(主进程 `fs.exists` 检查,避免 renderer 越权读盘)。

### 6.4 实时刷新
- `useDraftPreviewStore` 用 selector 订阅当前会话的 `messages` + `live.items`,聚合成一个「最近 file-edit 路径 + 序号」的派生值。
- 派生值变化 → 若路径在 webRoot 下 → `setTimeout` 300ms 防抖 → 触发 `reload()`。
- 切换会话/`cwd` 变化 → 重算 webRoot + 入口 → 整体替换 `src`。
- agent 正在跑(流式中)也持续刷新;完成时再刷新一次确保最终态。

## 7. 分层改动清单

**主进程**
- `electron/main.ts`:注册 `freebuddy-draft` privileged scheme(`main.ts:36` 附近);app ready 后 `protocol.handle("freebuddy-draft", handleDraftRequest)`(仿 `main.ts:50`)。
- 新建 `electron/draftProtocol.ts`:`handleDraftRequest` + MIME 表 + root 子树校验 + 目录穿越防护 + IPC `resolveDraftEntry`/`draftStat`。
- `electron/cli/ipc.ts`:新增 `cli:resolveDraftEntry`、`cli:draftStat`(返回入口是否存在/最近修改时间)。

**Preload / 类型 / 客户端**
- `electron/preload.ts`:`cli.resolveDraftEntry / draftStat`。
- `src/types/freebuddy.d.ts`:`FreebuddyCli` 补两方法签名。
- `src/services/cli/client.ts`:`cliClient.resolveDraftEntry / draftStat`。

**状态层**
- 新建 `src/store/draftPreviewStore.ts`(zustand):
  ```
  state: { byConv: Record<convId, { cwd, webRoot, entryRel?, manualEntry?, url, lastEditPath?, ready }>; }
  actions: ensureFor(convId, cwd); setEntry(convId, rel); reload(convId);
           onItems(convId, items)  // 由 conversationHandlers/订阅调用,内部防抖 reload
  ```

**UI**
- 新建 `src/components/Draft/DraftCanvas.tsx`(预览 Tab 主体):地址栏(协议相对路径,可编辑)+ 刷新 + 在系统浏览器打开 + 入口下拉 + iframe。空态(cwd 未设 / 无 HTML)给引导。
- 新建 `src/components/Draft/DraftToolbar.tsx`:工具条。
- 新建第三列 Tab 容器 `src/components/CLI/DetailColumn.tsx`:顶部两 Tab「概览 / 预览」,内容分别渲染 `<WorkspacePanel/>` 与 `<DraftCanvas/>`;按会话记忆上次所选 Tab。
- `src/App.tsx:257-259`:把 `<WorkspacePanel/>` 替换为 `<DetailColumn/>`(内部承载两个面板)。

**样式**:`styles.css` 新增 `.draft-canvas / .draft-toolbar / .draft-frame`(尺寸 100% 第三列,圆角 `--fb-rounded-lg`,边框 `rgba(148,163,184,.24)`,暗色背景 `#0b0f19`)。

**i18n**:`locales/{en,zh-CN}.json` 新增 `draft` 命名空间(`title / refresh / openExternal / entry / emptyNoWorkspace / emptyNoEntry / loading / unsupported / tabOverview / tabPreview / previewBadge` 等)。

## 8. 数据流(时序)

**A. 进入有产物的会话**
```
setActive(id) → store.ensureFor(id, conv.cwd)
              → IPC resolveDraftEntry(cwd) → entryRel="index.html"
              → url = freebuddy-draft://render/index.html?root=<cwd>
              → iframe 加载 → 首屏渲染
```

**B. agent 实时改文件**
```
parser 产 file-edit(path) → live.items 更新
  → store.onItems 过滤 path ∈ webRoot → debounce 300ms → iframe.reload()
```

**C. 切换会话 / cwd 变**
```
activeId 变 → ensureFor(newId) → 若 cwd 变则重算 entry → 替换 iframe.src
```

**D. 重启后回看**
```
load 会话 → 取最近 file-edit(历史 message items)→ ensureFor → 首屏即最终态
```

## 9. 安全模型

- 协议 `freebuddy-draft` 只读、锁定 `root=cwd` 子树,目录穿越被 `path.resolve` + 前缀校验拦截。
- iframe `sandbox` 不含 `allow-same-origin` → agent 写的 JS 在隔离 origin,无法访问 `window.parent`(FreeBuddy UI)、localStorage、cookie,也无法触发导航逃逸(不带 `allow-top-navigation`)。
- 协议 `secure: true` 保证 ESM / 现代 web API 可用,同时仍是 opaque origin。
- 不向渲染进程暴露任意路径读盘能力;`resolveDraftEntry` 只返回**相对入口名**,不泄漏绝对路径之外的文件系统信息。

## 10. UI / UX

- 顶部一条工具栏:入口路径(可编辑回车)+ 刷新按钮(带加载态)+ 「在浏览器打开」+ 入口快速切换(若有多个 `.html`)。
- 主区:iframe 占满。空态分两种:`cwd 未设置` / `cwd 下找不到 HTML`,各自给文案与(若适用)引导去新建会话选目录。
- 暗色模式:iframe 外层给暗色衬底,避免白屏闪。
- 首次进入有产物的会话自动加载;agent 跑动时持续刷新(工具栏显示一个「自动刷新中」微指示)。
- **Tab 切换**:第三列顶部两 Tab「概览」/「预览」。默认「概览」;当 cwd 下存在 web 入口或出现首个 `file-edit` 时,「预览」Tab 出现可用徽标(不强切,避免打断)。每个会话在内存里记忆上次所选 Tab,切回时恢复。

## 11. 关键决策与备选

| 决策点 | 选择 | 理由 | 备选(未采用) |
| --- | --- | --- | --- |
| 容器 | renderer `<iframe sandbox>` | 布局随栅格自然、刷新最简单、隔离充分 | 主进程 `WebContentsView`(坐标同步复杂)、`<webview>`(官方 deprecated) |
| 产物加载 | 自定义 privileged 协议 serve cwd | 相对路径/ESM/fetch 全可用;只读+锁子树安全 | `file://`(ESM/fetch 受限、跨平台路径丑)、起本地 http server(多端口、生命周期复杂) |
| 刷新信号 | 监听 `file-edit` item | 跨 agent 通用、已有结构 | 监听磁盘 fs.watch(噪声大、跨平台不稳) |
| 刷新策略 | 300ms 防抖 reload | 平衡实时性与性能 | 每次 item 立即 reload(抖动) |
| 第三列承载 | Tab 容器,概览/预览自由切换 | 遵循需求:两者信息都要保留,用户按需切换 | 整体替换(信息丢失)、纯 status chip(信息降级) |

## 12. 边界情况

- **cwd 未设**:显示空态「请选择工作区目录」。
- **多文件路由(SPA)**:hash/history 路由在 reload 时可能复位——history 路由刷新后会回根路径,属可接受降级。
- **产物需打包/起服务**(如纯 `.tsx`/vite 项目无 `index.html` 产物):本期不支持,空态提示「请先构建」(N1)。
- **大资源/死循环脚本**:iframe 内卡死不影响主 UI(隔离进程/沙盒);提供手动刷新与「在浏览器打开」逃生口。
- **跨平台路径**:Windows 反斜杠统一 `encodeURIComponent` 进 `root`,`relPath` 用正斜杠。
- **无 file-edit 的纯静态会话**:也能加载入口,只是不自动刷新(手动刷新可用)。

## 13. 风险与未决

- **R1(已解决)**:第三列改为 Tab 切换,`WorkspacePanel` 全部信息卡(session/usage/cost/plan/config/agent 状态)保留,与 Draft 预览并存,无信息丢失。
- **R2** sandbox 不带 `allow-same-origin` 时,部分依赖 `localStorage`/`indexedDB` 的页面会异常——若目标用户常用此类产物,需评估是否对「可信 cwd」放宽(带来安全权衡)。
- **R3** ESM + bare import(没 build 的源码直接引用 `react`)无法在协议下解析;属 N1 范畴,空态引导构建。
- **R4** 第三列在窄窗口下可能被挤压;需给 iframe 一个最小可用宽度并允许整列折叠(沿用现有 `sidebar-collapsed` 类思路)。

## 14. 实现拆解(建议提交顺序)

1. **协议层**:`draftProtocol.ts` + `main.ts` 注册;`resolveDraftEntry` IPC。单测:目录穿越拦截、MIME、目录→index.html。
2. **打通调用链**:preload / `freebuddy.d.ts` / `client.ts`。
3. **store**:`draftPreviewStore.ts`(ensureFor / onItems 防抖 / reload / 入口缓存)。
4. **UI 主体**:`DraftCanvas` + `DraftToolbar` + 空态;新增第三列 Tab 容器 `DetailColumn`;`App.tsx` 用 `DetailColumn` 承载 `WorkspacePanel` 与 `DraftCanvas`。
5. **实时刷新接线**:在 `conversationHandlers` 或 store 订阅里把 file-edit 喂给 `onItems`。
6. **样式 + i18n + 暗色**。
7. **Tab 记忆与徽标**:按会话在内存(可选 `app_settings`)记忆上次 Tab;预览可用时给徽标。
8. **验证**:`typecheck` + `test` + Electron 实跑(新建/切换/cwd 变/agent 改文件自动刷新/目录穿越拦截)。

## 15. 验证与测试

- **单测**:`draftProtocol.ts` 的穿越拦截(`../`、绝对路径、符号链接不跟随)、MIME 映射、目录请求补 `index.html`、403/404。
- **手测清单**:
  - [ ] 有 `index.html` 的会话,进入即见首屏,相对 CSS/JS/图片/ESM 正常。
  - [ ] agent 改 `index.html` 或 `style.css` 后 ~300ms 自动刷新。
  - [ ] 切换会话 / 切到不同 cwd,画布随之换站。
  - [ ] 概览/预览 Tab 自由切换;切走再切回会话,恢复上次 Tab;预览可用时 Tab 有徽标。
  - [ ] 地址栏输入相对路径回车可跳转;「在浏览器打开」可用。
  - [ ] cwd 未设 / 无 HTML 时空态正确。
  - [ ] 构造 `freebuddy-draft://render/../../etc/passwd?root=...` 返回 403。
  - [ ] iframe 无法 `parent.postMessage` 触达 FreeBuddy(隔离验证)。

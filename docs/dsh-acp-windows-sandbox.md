# DeepSeek ACP Windows 崩溃修复（方案 A：弃用原生沙箱）

记录 `cursor/dsh-harness-fork-255d` 分支针对 Windows 下 DeepSeek ACP（`dsh-acp` adapter）持续失败的根因与修复。

## 背景

FreeBuddy 在 Windows 上接入 DeepSeek ACP 后，会话一直失败：进程退出码 `3221225477`（`0xC0000005` STATUS_ACCESS_VIOLATION）。在此之前的几次尝试（覆盖官方 JSONL、用 koffi 桩拦截、把 ACL 沙箱关掉、改用 node 拉起 bin）都未能根治。

## 根因

`dsh-sandbox-local` 在 Windows 上拉入 `dsh-sandbox-windows-acl`，后者在**模块导入时**就调用 `koffi` 原生 addon：

```
dsh-sandbox-windows-acl/lib/types-*.js:79  const PVOID = koffi.pointer("void");
dsh-sandbox-windows-acl/lib/types-*.js:82  … koffi.struct(…)
```

文件注释虽称"koffi 懒加载"，但结构体定义是顶层立即执行的。于是形成两条死路：

| 跑法 | 结果 |
| --- | --- |
| 真加载 koffi（无 guard） | 模型能正常返回，但进程退出 `0xC0000005`，FreeBuddy 据此把会话标记为 failed |
| 用 koffi 桩拦截（`koffi-stub.mjs`） | 桩缺 `.struct`，sandbox-windows-acl 导入即抛 `koffi.struct is not a function`，插件树加载失败，退出码 1 |

并且 freebuddy 原有的 koffi 桩在 **Node 24 上根本加载不上**：`dshAcpKoffiGuardImportFlag()` 用裸 `C:\…` 路径作 `--import` 值，Node 24 直接抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（代码注释里"裸路径可行 / `file:///` 会坏"的假设在现代 Node 上是反的）。所以实际线上落入第一种崩溃。

崩溃是 **Windows + koffi + Electron 子进程**特有的：macOS 走 seatbelt（`sandbox-exec`）、Linux 走 Landlock/bwrap，都不碰 koffi。

## 修复

### 1. Windows 专用 composition：`assets/dsh/cordis.win32.yml`

在 Windows 上彻底不挂原生沙箱栈，改用无原生 addon 的本地 bash 执行器：

- 移除 `dsh-sandbox-local`（koffi 的唯一来源）
- `bash`：`dsh-bash-sandbox` → `@deepseek-ai/dsh-bash-local`（依赖已有的 `dsh-subprocess-local` 做进程树管理，提供 `shell` 服务，使 hooks 等正常激活）
- 保留 `dsh-sandbox-policy` + `dsh-fs-sandbox`（纯 JS，继续对 `ctx.fs` 做 workspace 写围栏；仅丢弃原生的**进程**沙箱）

### 2. 单点切换：`bundledDshAcpConfigPath()`

`electron/cli/adapters.ts` 中 `bundledDshAcpConfigPath()` 在 `process.platform === 'win32'` 时返回 `cordis.win32.yml`，否则原 `cordis.yml`（带"平台变体缺失则回退"的兜底）。

由于**托管安装的 `cordis.yml` 副本与 UI installHint 从此函数派生**（`parseDshAcpCompositionPackages` 解析该文件），切换后：

- `resolveDshAcpConfigPath()` / `syncDshAcpManagedConfig()` 在 Windows 落到 win32 配置
- 打包：`electron-builder.yml` 的 `extraResources` 整目录拷贝 `assets/dsh`，新文件自动带上

现代 standalone harness（`deepseek-harness-acp` + `@deepseek-ai/dsh-base`）自带 composition，FreeBuddy **不再**给它传 `--config`，win32 配置只服务于旧的 `@deepseek-ai/dsh-acp-demo`。

`dshAcpInstallCommand()` 只安装 `deepseek-harness-acp` 一个包，**不要**再追加 `@deepseek-ai/dsh-bash-local@next`：`@next` 领先于 harness 核心的 `0.1.x` 版本线，两个根依赖的同名冲突会让 npm 把 `@deepseek-ai/dsh-base` 的整棵插件子树降级到其私有 `node_modules`，而 `boot()` 的裸包名解析锚定在 harness 的 `lib/bin.js`，无法命中那棵子树 → 启动即数十条 `failed to import` 并以 exit 1 结束。`dsh-bash-local` 已由 harness 按匹配版本传递引入，Windows 上并不需要额外的 `@next`。

### 3. koffi 桩按需注入：`withDshAcpSqliteWarningSuppressed()`

koffi 桩只在 composition **真的引用 `dsh-sandbox-local`** 时才注入（新增 `dshAcpConfigUsesNativeSandbox()` 读取 `--config` 指向的文件判定）。win32 配置不含 `dsh-sandbox-local`，于是不再注入——既没必要（不加载 koffi），也避开了 Node 24 的裸路径 `--import` 崩溃。非 Windows 的 `cordis.yml` 仍含 `dsh-sandbox-local`，行为与改动前完全一致。

## 平台影响

| 平台 | composition | 原生沙箱后端 | 行为变化 |
| --- | --- | --- | --- |
| Windows | `cordis.win32.yml` | （移除，改 `dsh-bash-local`） | **修复崩溃** |
| macOS | `cordis.yml` | seatbelt（`sandbox-exec`） | 无变化 |
| Linux | `cordis.yml` | Landlock / bwrap | 无变化 |

macOS/Linux 不 import koffi，koffi 桩的 resolve hook 永不命中（空操作）；且裸路径 `--import` 在 POSIX 上无 drive-colon 问题，照常加载。

## 验证

通过 FreeBuddy 真实 `buildCommand` 端到端实测（全局 `dsh-acp-demo@0.1.0-rc.6` + 真实 DeepSeek key）：

- `bin: node`，`--config cordis.win32.yml`，**koffi-guard 未注入**
- `initialize` / `session/new` 成功
- `session/prompt` 执行 bash 工具（`echo BASH_LOCAL_OK`）成功，`end_turn`
- **进程退出码 `0`**（无 `0xC0000005`、无 ESM scheme 错误）

`tsc -p tsconfig.electron.json --noEmit` 通过。

## 安装

无需任何 Windows 专属补装包。点「安装/升级」时 `prepareDshAcpManagedInstall()` 先清掉 `%APPDATA%\npm\node_modules\@deepseek-ai` 残留、整棵删除托管 `node_modules` 与 lockfile（删除失败即报错中止，不允许 npm 装进半删除的目录），再由 `cleanupLegacyDshAcpManagedFiles()` 丢弃任何不是「单一 `deepseek-harness-acp` 范围依赖」的 `package.json`，保证 npm 从零解析；随后 `dshAcpCompositionReady()` 按 `@deepseek-ai/dsh-base/cordis.patch.yml` 的每一行插件校验依赖树是否真的可解析，被降级的子树会直接报「未安装」而不是启动崩溃。

## 取舍

- 代价：Windows 下 bash 失去原生的**进程级**沙箱围栏（文件级围栏由 `dsh-fs-sandbox` 保留）。FreeBuddy 已用 `DSH_PERMISSION_MODE` + approval 层兜底，可接受。
- 这是对 koffi 原生崩溃的根治；koffi 桩作为"自定义 cordis 仍带 sandbox-local 时的兜底"保留，但其在 Node 24+ 上的裸路径加载问题属既有缺陷，不在本次范围内（自定义 workspace `cordis.yml` 在 Windows 上若仍带 `dsh-sandbox-local`，仍会触发该既有问题）。

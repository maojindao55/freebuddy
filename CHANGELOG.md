# Changelog

记录面向用户的版本变更。每次执行 `npm run release` 时，系统会从上一个 tag 之后的提交生成初稿；如需使用人工或 Agent 润色的文案，可传入 `--notes-file <路径>`。

## [0.10.17] - 2026-09-26

### 新功能

- add Antigravity CLI usage quota card

## [0.10.16] - 2026-09-25

### 新功能

- bridge ACP session mcpServers into bundled pi via forked pi-acp

## [0.10.15] - 2026-09-24

### 问题修复

- disable GPU sandbox on Windows and avoid restarting explorer
- improve DeepSeek adapter toggle, model resolution and vision support

## [0.10.14] - 2026-09-23

### 设置页改进

- CLI Agent 列表：已安装统计并入搜索框所在行，移除列表上方的安装引导横幅与批量勾选流程
- 未安装的 Agent 详情页头部新增「让 GuideBuddy 安装」操作（内置 Pi 除外）
- 修复设置页打开时标题栏仍显示并可编辑上一会话标题的问题

## [0.10.13] - 2026-09-23

### 体验优化

- tone down GuideBuddy install banner (v2)

## [0.10.12] - 2026-09-23

### 体验优化

- tone down GuideBuddy install banner

## [0.10.11] - 2026-09-23

### 新功能

- master-detail CLI agent management page (#194)

### 问题修复

- sweep orphaned install-dir processes during Windows upgrades

## [0.10.10] - 2026-09-22

### 新功能

- add Devin ACP agent (#192)
- keep the CLI agent list in sync with GuideBuddy installs (#191)

### 问题修复

- harden Windows upgrades and render release notes (#193)

## [0.10.9] - 2026-09-22

### 新功能

- Improve GuideBuddy install selection and fix ACP replay suppression
- re-probe GuideBuddy hand-offs through the real check pipeline

### 问题修复

- restore usage page scrolling

## [0.10.8] - 2026-09-22

### 新功能

- let GuideBuddy install missing built-in agents

### 问题修复

- keep titlebar actions always visible and hover-reveal only the pencil

## [0.10.7] - 2026-09-21

### 新功能

- hide chat titlebar icons until hover
- let GuideBuddy install agents via bash when asked

### 问题修复

- keep the rename pencil next to the conversation title

## [0.10.6] - 2026-09-21

### 新功能

- declare deepseek-v4.1-flash vision capability in cordis templates and model inference

### 问题修复

- ship the bundled pi runtime in packaged apps

## [0.10.5] - 2026-09-21

### 问题修复

- make onboarding and pi runtime checks portable on Windows

## [0.10.4] - 2026-09-21

### 新功能

- GuideBuddy 对话向导体验与完成闭环（新手引导 PR3/3） (#189)
- 内置 pi 运行时 + 官方新手引导 Agent GuideBuddy（新手引导 PR1/3） (#187)
- point guide gateway to freebuddy-freebie worker
- PR2 — pi BYOK 能力 + 首次安装引导浮层
- 新增普通 Pi 内置成员，可直接在 AgentPicker 中选用
- 内置 pi 运行时 + 官方新手引导 Agent GuideBuddy（新手引导 PR1）

### 问题修复

- add mainland fallback activation and auto-bind pi adapter
- prefix apiKey with $ so pi-ai expands envKey instead of treating it as literal token
- enrich silent turn failure with pi session error details
- 默认切换至 BYOK Relay 模型并避免 OpenAI 凭证劫持
- Pi 图标 + GuideBuddy 固定 pi-acp 运行时（评审反馈）

## [0.10.3] - 2026-09-21

### 问题修复

- 优先解析全局 standalone deepseek-harness-acp 并支持默认命令路径

## [0.10.2] - 2026-09-21

### 新功能

- 适配现代 standalone DeepSeek Harness ACP 与 BYOK 图片/模型配置

### 问题修复

- 强化恢复会话重放抑制，防止历史消息与已完成工具泄漏
- 发送消息后保持输入框光标焦点

## [0.10.1] - 2026-09-18

### 新功能

- 服务商页与设置侧边栏 UI/UX 优化 (#185)

### 问题修复

- 修复团队会话停止与锁冲突，并修复 Qoder 回放重复 (#186)

## [0.10.0] - 2026-09-18

### 新功能

- **统一服务商架构（Provider Management）**：新增服务商管理中心，集中配置和维护第三方模型 API 渠道（Base URL、API Key、协议类型），支持安全加密存储与连通性检测。
- **Agent BYOK 引用模式**：Codex、Claude Code、DeepSeek Harness 等所有 Agent 支持一键关联服务商，修改服务商密钥全 Agent 同步生效，无缝兼容既有本地配置。
- **模型独立启用与过滤**：支持对各服务商的模型列表进行启用/禁用开关控制，仅启用的模型可在聊天 Composer 与 Agent BYOK 下拉框中使用；列表与会话选项实时双向同步。
- **协议兼容增强**：统一支持 OpenAI 兼容、OpenAI Responses、Anthropic Claude 以及 DeepSeek Harness 等多种协议。

### 体验与界面优化

- **单列紧凑排版**：服务商编辑界面重构为紧凑流式布局，优化表单对齐与内联药丸协议选择器，最大化模型列表纵向可视空间。
- **搜索与展示体验优化**：优化模型搜索框的层叠特异性与图标对齐，新增未保存变更浮动提醒栏。
- **释放长上下文能力**：取消拉取模型时硬编码的上下文窗口猜测，不设人为上限，原生支持 DeepSeek 1M 等超长上下文模型。

## [0.9.40] - 2026-09-17

### 新功能

- integrate Cline adapter and support provider model cascading
- 缩短自组织团队会话标题并支持自定义编辑 (#182)

## [0.9.39] - 2026-09-16

### 问题修复

- unblock ACP delegation yield before cleanup (#181)

## [0.9.38] - 2026-09-16

### 修复

- 修复自组织团队交接结束后工具仍显示“等待中”的问题。
- 修复 ACP 工具运行状态的映射，正确显示正在执行的工具。

### 诊断改进

- 增加团队子任务落库、结果通知、等待恢复和主控唤醒的关联日志，便于排查偶发停滞；日志不包含对话正文。

本版本未确认修复尚未复现的最后一轮未唤醒问题，新增日志用于后续定位。

## [0.9.37] - 2026-09-15

### 问题修复

- 让资源管理器一级菜单真正加载 ExplorerCommand DLL (#177)
- resume team conversations after replacing deleted agents (#178)

## [0.9.36] - 2026-09-15

### 问题修复

- 修复子组织会话卡死，并支持还原精简的历史详情

## [0.9.35] - 2026-09-15

### 问题修复

- 自组织团队子角色超长输出改为保留截断后的正文，运行中不再整条显示 omitted (#176)

## [0.9.34] - 2026-09-15

### 问题修复

- 同一毫秒内按插入顺序分页消息，避免 IPC 读到旧消息

## [0.9.33] - 2026-09-15

### 问题修复

- 打开超长旧对话（含自组织团队会话）时改为分页加载并跳过超大 JSON.parse，避免主进程卡死 (#173)

## [0.9.32] - 2026-09-15

### 问题修复

- 打开超长旧对话（含自组织团队会话）时改为分页加载并跳过超大 JSON.parse，避免主进程卡死 (#173)

## [0.9.31] - 2026-09-15

### 问题修复

- 打开含超长历史的旧对话（含自组织团队会话）时截断 IPC 消息载荷，避免主进程闪退 (#172)

## [0.9.30] - 2026-09-15

### 问题修复

- 一级菜单需要把签名证书导入本地计算机证书库 (#171)

## [0.9.29] - 2026-09-15

### 问题修复

- 用 .NET 导出稀疏包签名证书，避开 CI 的 Security 模块 (#170)

## [0.9.28] - 2026-09-14

### 问题修复

- 用 desktop5 ItemType 注册文件夹右键，避免 MakeAppx 校验失败 (#169)

## [0.9.27] - 2026-09-14

### 新功能

- 把「使用 FreeBuddy 打开」放进 Win11 一级右键菜单 (#168)

## [0.9.26] - 2026-09-14

### 新功能

- 支持 Finder 右键用 FreeBuddy 打开文件夹和文件 (#167)

### 问题修复

- 降低超长会话卡死崩溃，并支持资源管理器右键打开 (#166)

## [0.9.25] - 2026-09-13

### 问题修复

- 修复 macOS 分享扩展签名问题：发布包内的微信分享扩展现使用与主程序相同的签名证书，可被系统正常注册加载，避免首次打开提示"已损坏"
- 修复本地部署脚本将 /Applications 中的应用重签为 ad-hoc 签名导致自动更新一直失败（"代码未能满足指定的代码要求"）的问题

## [0.9.24] - 2026-09-13

### 新功能

- bundle and auto-register share extension for wechat integration
- bridge community reviews and availability votes with HMAC client auth

### 问题修复

- fix dev scheme dispatch and helper resolution
- remove hardcoded client secret and enforce CWE-798 regression guard

## [0.9.23] - 2026-09-12

### 新功能

- 白嫖专区：支持导入服务商头像与自定义头像，根据协议智能匹配和选择底层 Agent（Codex / Claude / DSH）

## [0.9.22] - 2026-09-12

### 新功能

- 团队与转接支持思考强度选择，转接可交回原 agent (#164)
- 支持通过 zcode-acp 接入智谱 ZCode + 修复 Markdown 嵌套列表渲染 (#162)

## [0.9.21] - 2026-09-11

### 问题修复

- 克隆 BYOK 模型透传 + 委派异常终态结构化 outcome (#160)
- 在 chat 桥接中转译 tool_search，恢复 MCP 工具发现 (#158)

## [0.9.20] - 2026-09-10

### 问题修复

- 修复设置页 Tab 类型断言，解除发版 CI 阻塞

## [0.9.19] - 2026-09-10

### 新功能

- 白嫖专区：外置服务商页面 + JS bridge 一键导入 BYOK Agent；侧栏中文副品牌名 (#155)

## [0.9.18] - 2026-09-09

### 新功能

- 定时发送（额度恢复后自动继续对话） (#154)

## [0.9.17] - 2026-09-08

### 问题修复

- resolve macOS cert import helper path on Windows (#153)

## [0.9.16] - 2026-09-08

### 问题修复

- replace leftover macOS signing keychain before import (#152)

## [0.9.15] - 2026-09-08

### 问题修复

- import macOS signing cert before electron-builder (#151)

## [0.9.14] - 2026-09-08

### 新功能

- auto-create projects when opening a folder and show worktree path (#150)

## [0.9.13] - 2026-09-03

### 新功能

- allow isolated browser to load remote HTTP URLs (#149)

### 问题修复

- handle legacy Antigravity bridge result errors as terminal failures

## [0.9.12] - 2026-09-02

### 问题修复

- recover stalled DeepSeek delegation turns (#148)

## [0.9.11] - 2026-09-02

### 问题修复

- make delegation wake recovery reliable (#147)
- key self-organizing team status by role, not shared CLI adapter (#146)

## [0.9.10] - 2026-09-01

### 新功能

- init
- Fix Codex BYOK image capabilities (#145)

## [0.9.9] - 2026-08-31

### 问题修复

- honor Codex BYOK model selection (#144)

## [0.9.8] - 2026-08-31

### 新功能

- Fix self-organizing teams and add Butler creation tools (#142)

## [0.9.7] - 2026-08-30

### 问题修复

- fail silent team agent turns

## [0.9.6] - 2026-08-30

### 问题修复

- surface upstream errors in team steps (#143)

## [0.9.5] - 2026-08-28

### 问题修复

- cover every cached codex model in the BYOK catalog
- write Codex BYOK model catalog for gpt-* model ids too
- make Codex BYOK model catalog parseable and tool-exposing

## [0.9.4] - 2026-08-28

### 问题修复

- restore terminal + local_shell tool support across ACP and BYOK bridge

## [0.9.3] - 2026-08-28

### 问题修复

- canonicalize task workspace paths for symlinked directories

## [0.9.2] - 2026-08-28

### 新功能

- restore codex BYOK chat wire API via local Responses bridge (#141)
- split runtime release into artifact repository (#138)

### 问题修复

- verify draft runtime assets via API (#139)

### 体验优化

- reduce companion renderer overhead (#140)

## [0.9.1] - 2026-08-27

### 问题修复

- allow desktop v* CI to bundle 0.0.0-dev runtime

## [0.9.0] - 2026-08-27

### 新功能

- host workflow runtime in an isolated process
- complete remaining runtime pack phases
- implement modular runtime pack architecture

### 问题修复

- refresh workflow tree after runtime-process start
- do not OS-sandbox local read-only delegated reviewers
- spawn Windows sandbox agent .cmd shims through the shell
- rate-limit host idempotency prune and index created_at
- steal stale install locks atomically and bound idempotency caches
- keep follow-up writes, crash on any unexpected exit, and own install locks
- close remaining runtime pack safety gaps before tagging
- make runtime publishes immutable and close remaining pack gaps

## [0.8.18] - 2026-08-26

### 问题修复

- preserve host owner admin context to prevent unexpected workspace isolation in local desktop runs

## [0.8.17] - 2026-08-26

### 问题修复

- resolve production gomoku white screen, collapsible move history and user avatar sync

## [0.8.16] - 2026-08-25

### 新功能

- display DEV badge in sidebar header and document title in dev mode
- isolate userData, app name, and window title for dev mode
- optimize arena layout, move history persistence and agent autonomy

### 问题修复

- filter out butler official agents from game selection
- default directory picker to parent of last selected folder
- remember last selected directory and avoid downloads fallback
- hide difficulty selector in dual-agent and engine modes
- guard hard-mode commentary prompt and fix captured tray side in dual-agent xiangqi

## [0.8.15] - 2026-08-24

### 问题修复

- resolve dsh-bash-local peer dependency conflict on Windows

## [0.8.14] - 2026-08-24

### 问题修复

- install dsh-bash-local on windows and clarify probe failure

## [0.8.13] - 2026-08-24

### 新功能

- upgrade Xiangqi engine search and add hard-mode AI commentary interaction
- improve game AI strength and reliability

## [0.8.12] - 2026-08-21

### 问题修复

- mount dsh-attachment-local and set default vision model for deepseek acp

## [0.8.11] - 2026-08-21

### 问题修复

- collapse project conversations by default and optimize tray icon

## [0.8.10] - 2026-08-21

### 问题修复

- load bundled boards in desktop and WebUI without workspace

## [0.8.9] - 2026-08-21

### 问题修复

- keep pwsh probe on Program Files, skip PATH
- prefer PowerShell 7 over hardcoded 5.1
- extract Game Arena strings and remove CJK literals from src

## [0.8.8] - 2026-08-21

### 新功能

- Revert "style(game): group captured pieces with inline counts and streamline turn indicator pill"
- display agent brand avatar and running model name badge in game header and dialogue
- add captured pieces graveyard tray to Xiangqi
- add UCCI algebraic coordinate axes to Xiangqi board
- add procedural Web Audio sound effects and mute toggle with local persistence
- add match summary share card with clipboard copy and download
- add Game Arena with Gomoku and Chinese Chess (Xiangqi)

### 问题修复

- auto seed missing builtin skills and refine narrow header flex layout
- fix speech banner avatar overflowing by setting explicit dimensions
- render captured pieces individually without blocking badge numbers
- ensure audio context is properly resumed on async agent moves
- remove duplicate audioCtx declaration in frontend game scripts

### 体验优化

- display logo and direct model name concisely in player card
- group captured pieces with inline counts and streamline turn indicator pill
- move mute button to footer next to share button for cleaner header layout
- move model badge to header line to keep captured pieces tray completely clean
- soften coordinates and keep only left and bottom axes
- make gameState snapshot lean to save tokens and add game_get_history MCP tool
- simplify in-game prompt texts and remove repetitive tool invocation hints

## [0.8.7] - 2026-08-20

### 问题修复

- handle Windows readonly attributes and locks on workspace removal

## [0.8.6] - 2026-08-20

### 新功能

- Improve browser compatibility and debug log exports

### 问题修复

- resolve sub-user web UI conversation list loading, image rendering and project grouping
- normalize cwd comparison and preserve manual entry in browserStore

## [0.8.5] - 2026-08-19

### 问题修复

- allow manual typing of BYOK model context window

## [0.8.4] - 2026-08-19

### 问题修复

- prevent stale URL cache and sync resolvedUrl on native browser tools

## [0.8.3] - 2026-08-19

### 新功能

- replace browser cookie import with isolated native view
- add native local Chrome/Edge SQLite cookie decryption and import engine
- add CDP session sync, cookie JSON import, and responsive viewport scale

### 问题修复

- resolve deepseek-harness-acp Windows install quoting and cordis composition

## [0.8.2] - 2026-08-17

### 新功能

- isolate official DeepSeek API key from custom BYOK API key
- add official DeepSeek API key input in default mode
- support BYOK for DeepSeek Harness (dsh-acp)
- fix CLI agent detection

### 问题修复

- sync workflow progress across conversations

## [0.8.1] - 2026-08-17

### 其他更新

- 常规维护与稳定性改进

## [0.8.0] - 2026-08-17

### 新功能

- harden delegation orchestration and activity UI
- dsh-acp support mcpservers
- pause/resume, finish notify, and keep streams alive
- pass verdict into wake orchestration
- branch wake prompts on structured verdict
- expose submit_verdict MCP tool
- add submit_verdict bridge action
- persist verdict fields on delegation events
- complete async orchestration bus (scheme B)
- per-role model pickers, session isolation, park+wake + queued concurrency
- async delegate+poll model (fixes MCP timeout)
- highlight active agent in roster card during run
- inject delegation MCP+skill on follow-up messages in delegation conversations
- show team roster card in the detail column
- subtle handoff divider between agents in chat
- inline write-approval card in the conversation chat
- navigate to conversation chat on run start; remove side run panel
- create conversation + user-goal message on delegation run start
- pass roleLabel + conversationId to agent run args
- stream each agent's output into a conversation message
- i18n keys for delegation UI
- live delegation-tree run view with write-approval gate + stop
- team picker, preview card, and start path
- add delegation team editor and settings routing
- add renderer client and team store
- add team CRUD + run-read IPC and preload bridge
- mirror renderer types and kind-scope getWorkflowTeam
- add delegation run IPC handlers and preload bridge
- type delegation context and inject freebuddy-delegate MCP into ACP sessions
- add DelegationRuntime (gate, context, run start, recovery)
- add real delegate runner (cliRun + harvest)
- add roster/task prompt builders
- add builtin delegation skill
- add delegate tool HTTP bridge and register handler
- add freebuddy-delegate MCP server (list_teammates + delegate)
- add testable delegation dispatch core with guards
- add inactivity-watchdog suppression API and guard armInactivityTimer
- seed builtin delegation teams on startup
- add delegation event CRUD for the runtime tree
- add delegation run creation
- add builtin delegation team and idempotent seeding
- add delegation team types and CRUD
- add kind columns and delegation_events table migration

### 问题修复

- harden verdict tests and summary overwrite
- mint unique cli task id per wake/follow-up turn
- English defaultValues + test assertions for async refactor + button merge
- dropdown options to 工作流团队/自组织团队
- merge new-team buttons into one dropdown
- align new delegation team button style with new team button
- remove preview card from new task page (consistent with normal mode)
- extract model from conversation messages config-options items (reuse active-agent-card mechanism)
- pass full member config to getCachedSessionConfigOptions (cache key match)
- resolve member model from cached session config options
- highlight entry agent via conversation live status (not just child events)
- guard displayRun null in isTeamLive (white screen)
- hide active-agent-card for delegation conversations (roster card handles it)
- show model in roster card member detail
- each roster member as its own side-card matching active-agent-card style
- use AgentAvatar (adapter brand icon) in roster card
- restyle roster card to match agent-lockup pattern
- set roleLabel on follow-up messages so entry agent keeps its role badge
- broadcast message updates so child agent output streams live
- lazy-load context from DB + ensureDelegationRuntime on follow-up (deps not configured)
- align team roster card with side-card style
- exclude delegation runs from workflow queries; harden followup agent id (white-screen)
- repair source-pattern tests (allTeams rename + preload namespace order)
- preserve killed status, i18n kind badge, roster validation
- key delegate mutex on caller session to allow recursive nesting (C1)
- classify delegation run/approval channels in remote policy
- return delegation runId immediately and run entry agent fire-and-forget
- recover blocked (approval-pending) delegation runs on restart
- summarize real AcpStreamItem shape (kind/content, tool-call)
- ref-counted inactivity suppression + AbortSignal on delegate timeout
- capture runId in tests, fix mutex leak + timer, document ok semantics
- clear inactivity suppression on ACP session finish
- type run status as WorkflowRunStatus, treat partial as terminal, add status tests
- inline builtin agent ids and audit-log delegation seeding
- wire delegation db test into test:handoff-db and align FK style

### 体验优化

- alias DelegationEventRow to DelegationEvent to avoid drift

## [0.7.17] - 2026-08-16

### 问题修复

- unblock updater restart on mac and disable intrusive task receipt auto-popup

## [0.7.16] - 2026-08-16

### 新功能

- display DSH performance and token metrics in run state card

## [0.7.15] - 2026-08-16

### 其他更新

- 常规维护与稳定性改进

## [0.7.14] - 2026-08-14

### 问题修复

- prefer standalone deepseek-harness-acp in dsh-acp adapter

## [0.7.13] - 2026-08-14

### 新功能

- sync clean cordis config and match installHint

### 问题修复

- support standalone deepseek-harness-acp probe on Windows and macOS

## [0.7.12] - 2026-08-14

### 问题修复

- fix Windows test assertions for DeepSeek ACP runtime

## [0.7.11] - 2026-08-14

### 其他更新

- 常规维护与稳定性改进

## [0.7.10] - 2026-08-14

### 新功能

- support deepseek-harness-acp standalone binary and enhance runtime error handling
- fix
- overlay a thin DeepSeek Harness fork on the official ACP runtime
- add DeepSeek Harness ACP adapter

### 问题修复

- wait for electron build before app start
- drop native sandbox for DeepSeek ACP on Windows to stop koffi crash
- spawn global dsh-acp-demo through node so koffi --import sticks
- keep DeepSeek sandbox enabled and prefer managed dsh-acp-demo
- stub koffi on DeepSeek ACP spawn and export runtime diagnostics
- overlay every DeepSeek JSONL copy and disable Windows ACL sandbox
- patch DeepSeek JSONL off koffi MoveFileExW on Windows
- stop DeepSeek ACP Windows access violation on session/prompt
- hide Node SQLite ExperimentalWarning from DeepSeek ACP
- install DeepSeek ACP into a local runtime and detect a bare bin
- install DeepSeek ACP composition plugins with the demo
- pass bundled cordis.yml when starting DeepSeek ACP
- treat dsh-acp-demo as installed without --version
- force skip koffi rebuild during DeepSeek ACP install
- skip koffi source rebuild when installing DeepSeek ACP
- install DeepSeek ACP from the next dist-tag

## [0.7.9] - 2026-08-11

### 新功能

- add show main window shortcut to desktop pet and keep unfocused task completions unread
- reuse orb styling in full-screen arcade
- add level volleys and ignore bomb misses
- enrich screen ball feedback and sound toggle
- add screen ball difficulty levels and bomb target
- add screen ball swipes and burst effects
- add full-screen ButlerBuddy screen ball game

### 问题修复

- increase full-screen arcade ball size
- enlarge full-screen arcade balls
- enable hover swipes and add light trails
- tune screen ball launch and remove duplicate pet

### 体验优化

- keep ButlerBuddy arcade full-screen only

## [0.7.8] - 2026-08-09

### 问题修复

- keep ButlerBuddy visible over macOS fullscreen

## [0.7.7] - 2026-08-09

### 新功能

- upgrade ButlerBuddy pet experience

## [0.7.6] - 2026-08-08

### 问题修复

- stabilize concurrent agent streaming

## [0.7.5] - 2026-08-07

### 其他更新

- 常规维护与稳定性改进

## [0.7.4] - 2026-08-07

### 新功能

- add app tray, native macOS menu, and unread badge

## [0.7.3] - 2026-08-07

### 问题修复

- fall back to session/new when saved ACP sessions are gone
- group selected skills above available in SkillPicker
- allow Cli Agents list to scroll when overflowed

## [0.7.2] - 2026-08-07

### 新功能

- add conversation_messages read tool
- hide-chat menu item removed and stop button during reply
- sync lists, fuzzy open, and pet theme
- add conversation and workspace navigation tools
- inject main window presence into butler prompts
- expose mainWindow on status_get
- publish main window UI presence
- add main window presence store

### 问题修复

- confirm quit when closing main window on macOS
- harden main window presence publishing
- route pet chat UI tools to main window

## [0.7.1] - 2026-08-07

### 问题修复

- repair failing release CI tests

## [0.7.0] - 2026-08-07

### 新功能

- smaller pet, avatar menu toggle, and preference sync
- pet interactions, global shortcut, and config-options merge fix
- add ButlerBuddy floating companion
- ButlerBuddy 配置面板 + freebuddy-butler 工具系统
- add ButlerBuddy agent profile

### 问题修复

- honor agent launch overrides

## [0.6.27] - 2026-08-05

### 新功能

- add Agent self-check log workflow

## [0.6.26] - 2026-08-05

### 问题修复

- preserve role skills across restarts

## [0.6.25] - 2026-08-05

### 新功能

- redesign unread conversation list
- open new-task home on startup and surface unread chats

### 问题修复

- surface codex retryable gateway errors as structured error items

## [0.6.24] - 2026-08-05

### 新功能

- generate changelog notes

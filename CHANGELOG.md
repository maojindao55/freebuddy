# Changelog

记录面向用户的版本变更。每次执行 `npm run release` 时，系统会从上一个 tag 之后的提交生成初稿；如需使用人工或 Agent 润色的文案，可传入 `--notes-file <路径>`。

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

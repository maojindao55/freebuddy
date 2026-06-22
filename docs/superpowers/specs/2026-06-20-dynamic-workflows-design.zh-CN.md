# 动态工作流设计

## 目标

为 FreeBuddy 增加 Dynamic Workflows：一个可控、可见的编排层，可以把多个现有 CLI/ACP agent 作为一个后台工作流来运行。

第一个工作流模板是 Review Loop Workflow。它是一个可重复的审查循环：一个或多个 reviewer agent 检查任务或变更，implementer agent 处理发现的问题，verifier agent 判断是否还需要继续下一轮循环。

产品目标不是创建一个 agent 聊天室，而是让用户启动复杂任务、审阅生成出来的计划、在后台运行它、按阶段和 agent 查看进度，并在当前对话中收到最终综合结果。

## 借鉴来源

Claude Code 的 Dynamic Workflows 把编排逻辑放进由 runtime 执行的工作流里，而不是把每个中间决策都留在主对话中。值得借鉴的核心点是：

- 计划是显式的，并且可以复用。
- Agent 在后台运行，主会话保持响应。
- 中间结果保存在主对话上下文之外。
- 用户可以查看进度，并停止、暂停或重启任务。
- 完成后的 workflow 可以保存并作为命令或模板复用。

FreeBuddy 应该借鉴这个心智模型，但第一版先使用更安全的受控 JSON 计划，而不是执行任意 JavaScript workflow 脚本。

参考：

- https://code.claude.com/docs/en/workflows
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/sub-agents

## 非目标

- 第一版不执行用户或模型生成的任意 JavaScript workflow 脚本。
- 第一版不做跨 worktree 的合并支持。
- 不替换普通单 agent 对话。
- 暂不实现 workflow marketplace 或插件系统。
- 不增加新的 agent 协议；workflow step 复用现有 CLI/ACP adapter。
- 不绕过现有权限模型自动允许高风险文件系统、shell 或 MCP 操作。
- 第一版不解决 app 重启后的长期 workflow 恢复能力。

## 当前架构适配

FreeBuddy 已经有合适的底层能力：

- `CLIMember` 定义可用的本地 agent。
- `cliRun()` 使用唯一 session id 启动一个 agent task。
- ACP 和 legacy runtime 会把 agent 输出归一化成 renderer 侧的 stream item 契约。
- `cli_tasks` 保存每个 task 的状态、prompt 摘要、日志路径、pid、退出码和 tool session id。
- Conversations 和 messages 提供用户可见的聊天时间线。

Dynamic Workflows 应该位于这些底层能力之上。一个 workflow run 拥有 phases 和 steps。每个可执行 step 启动一个现有 agent task，并保存对应的 `cli_task_id`。

## 产品模型

### Workflow

Workflow 是一个协调多个 agent 的计划。它包含目标、工作目录、阶段、步骤、gate 和完成标准。

### Workflow Run

Workflow run 是某个 workflow plan 的一次执行。Run 可以处于 pending approval、running、paused、blocked、completed、failed、killed 或 partially completed 状态。

### Workflow Step

Step 是最小可执行单元。一个 step 包含一个指定 agent、一个 prompt、一个 mode、可选依赖和结果摘要。

Step mode：

- `research`：只读探索。
- `review`：只读审查或风险分析。
- `write`：实现或文件编辑。
- `verify`：测试、检查或验证。
- `summarize`：综合前面步骤的输出。

### Review Loop Workflow

Review Loop Workflow 是第一个内置模板。

默认阶段：

1. `baseline`：理解任务、目标文件、当前状态和成功标准。
2. `review`：让一个或多个 reviewer 针对当前状态或拟议变更进行审查。
3. `implement`：让 implementer 处理已接受的发现项。
4. `verify`：运行检查，并让 verifier 判断发现项是否已解决。
5. `loop_or_finish`：如果 verifier 报告仍有可执行的未解决问题，并且循环次数未超过限制，则重复 review/implement/verify；否则综合最终结果。

默认限制：

- 最多 3 轮 review loop。
- 最多 3 个并发只读 step。
- 同一时间最多 1 个 write step。
- 第一个 write step 之前需要人工确认。

## 计划结构

使用可序列化的受控计划：

```ts
export interface WorkflowPlan {
  name: string;
  goal: string;
  cwd?: string;
  template?: "review-loop" | "custom";
  maxLoops?: number;
  phases: WorkflowPhase[];
}

export interface WorkflowPhase {
  id: string;
  title: string;
  description?: string;
  parallelism: number;
  steps: WorkflowStep[];
  gate?: WorkflowGate;
}

export interface WorkflowStep {
  id: string;
  title: string;
  agentId: string;
  mode: "research" | "review" | "write" | "verify" | "summarize";
  prompt: string;
  dependsOn?: string[];
  targetPaths?: string[];
  consumes?: string[];
}

export type WorkflowGate =
  | { type: "all_done" }
  | { type: "manual_approval"; reason: string }
  | { type: "review_required"; reviewerStepId: string };
```

计划由 agent 生成，但 runtime 必须在运行前校验它。

校验规则：

- 每个 phase 和 step id 在 plan 内唯一。
- 每个 `agentId` 都能映射到已启用的 `CLIMember`。
- 每个依赖都引用更早的 step。
- `parallelism` 必须在 1 到 3 之间。
- 一个 phase 不能包含超过一个 `write` step。
- Runtime 记录了该 step 或该 phase 的明确审批之前，write step 不能启动。
- Prompt 去掉首尾空白后必须非空。

## 数据模型

在 `electron/cli/db.ts` 中新增 workflow 表。

### `workflow_runs`

- `id TEXT PRIMARY KEY`
- `conversation_id TEXT`
- `name TEXT NOT NULL`
- `goal TEXT NOT NULL`
- `status TEXT NOT NULL`
- `cwd TEXT`
- `template TEXT`
- `loop_index INTEGER NOT NULL DEFAULT 0`
- `max_loops INTEGER NOT NULL DEFAULT 1`
- `plan_json TEXT NOT NULL`
- `summary TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `ended_at TEXT`

### `workflow_steps`

- `id TEXT PRIMARY KEY`
- `workflow_run_id TEXT NOT NULL`
- `phase_id TEXT NOT NULL`
- `step_id TEXT NOT NULL`
- `title TEXT NOT NULL`
- `agent_id TEXT NOT NULL`
- `agent_name TEXT NOT NULL`
- `adapter TEXT NOT NULL`
- `mode TEXT NOT NULL`
- `status TEXT NOT NULL`
- `prompt TEXT NOT NULL`
- `depends_on TEXT`
- `target_paths TEXT`
- `summary TEXT`
- `result_json TEXT`
- `cli_task_id TEXT`
- `started_at TEXT`
- `ended_at TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE`

索引：

- `idx_workflow_runs_conversation ON workflow_runs(conversation_id, created_at DESC)`
- `idx_workflow_steps_run ON workflow_steps(workflow_run_id, phase_id, created_at)`
- `idx_workflow_steps_task ON workflow_steps(cli_task_id)`

## Runtime 架构

增加一个 Electron main-process workflow runtime：

- `electron/cli/workflows.ts`：持久化和 row mapping。
- `electron/cli/workflowRuntime.ts`：plan 校验、调度、step 执行、pause/resume/stop、loop 处理。
- `electron/cli/workflowIpc.ts`：renderer action 对应的 IPC handler。

Runtime 不直接解析 ACP 或 CLI 输出。它通过现有 task runner 启动每个 step，并监听完成状态。Step summary 从最终 assistant stream items 或 summarizer step 中生成。

Runtime 职责：

1. 持久化计划中的 run。
2. 执行前校验 plan。
3. 按每个 phase 的并发限制启动未阻塞 step。
4. 阻止并行 write step。
5. 记录每个 step 的 `cli_task_id`。
6. 更新 step 和 run 状态。
7. 在 manual gate 暂停。
8. 支持 stop 和失败 step retry。
9. 对 Review Loop Workflow，根据 verifier 输出和配置的循环上限决定是否继续下一轮。
10. 向 conversation 追加最终 workflow summary message。

## Renderer 架构

在 conversation store 和 CLI executor store 旁边新增 workflow store。

Renderer 职责：

- 请求生成 plan。
- 执行前渲染 plan preview card。
- 启动、暂停、继续、停止、重试 workflow run。
- 在 side panel 展示 workflow 进度。
- 允许用户查看某个 step 的 prompt、状态、summary 和关联 task 输出。
- 保持主聊天区域简洁，只显示 workflow milestone 和最终 summary，不展示每个中间 stream item。

建议组件：

- `WorkflowPlanCard`
- `WorkflowRunPanel`
- `WorkflowPhaseList`
- `WorkflowStepRow`
- `WorkflowStepDetails`
- `ReviewLoopSummary`

## 用户流程

### 新建 Workflow

1. 用户输入任务，并启用 Workflow mode，或选择内置 Review Loop 模板。
2. 如有需要，FreeBuddy 创建一个普通 conversation。
3. Coordinator agent 生成 `WorkflowPlan`。
4. FreeBuddy 校验 plan。
5. UI 展示 plan preview，包括 agents、phases、write steps、gates 和预估风险。
6. 用户选择 Run、Edit Prompt 或 Cancel。
7. Runtime 执行 workflow。
8. 用户可以在 side panel 查看进度。
9. 最终 summary 被追加到 conversation。

### Review Loop

1. 用户选择 Review Loop Workflow。
2. Baseline step 总结目标任务或当前变更。
3. Reviewers 产出 findings。
4. 如果 workflow 涉及编辑文件，用户确认哪些 findings 应该被处理。
5. Implementer 处理已批准的 findings。
6. Verifier 检查变更。
7. 如果仍有未解决 findings 且未达到 `maxLoops`，runtime 继续下一轮。
8. 最终 summary 包含已解决 findings、未解决 findings、涉及文件和已运行检查。

## 安全和权限

第一版安全默认值：

- Workflow 启动前必须展示 plan preview。
- Workflow 只有在用户确认后才开始执行。
- Write steps 需要可见 gate。
- 同一时间只运行一个 write step。
- 只读 mode 第一版先通过 prompt 和 policy 约束实现；更深的 per-tool enforcement 后续再做。
- 现有 ACP permission request 继续走当前 permission flow。
- Stop 会 kill 底层正在运行的 CLI tasks。
- Retry 会为失败 step 启动新的 CLI task，而不是修改旧 task record。

后续安全增强：

- Per-step tool restrictions。
- Write step 的 worktree isolation。
- 从隔离 worktree 应用变更前展示 diff preview。
- App 重启后的 workflow 持久恢复。

## 错误处理

- 生成的 plan 无效时，返回明确错误，并且不启动 run。
- 如果某个 step 失败，workflow run 变为 `blocked`，除非该 step 被标记为 retryable。
- 如果非关键 review step 失败，用户可以跳过它并继续。
- 如果 write 或 verify step 失败，workflow 暂停并等待用户决定。
- 如果 app 在 workflow 运行中关闭，活动 child processes 遵循现有 task lifecycle。完整恢复能力是后续功能。
- 如果 workflow 达到 `maxLoops` 后仍有未解决 review findings，则以 `partial` 状态完成并报告未解决项。

## 测试

为 workflow runtime 增加聚焦的 Node tests：

- Plan validation 接受有效的 Review Loop plans。
- Plan validation 拒绝 unknown agents、duplicate ids、bad dependencies、empty prompts、excessive parallelism 和 parallel write steps。
- Scheduler 只启动未阻塞 step。
- Scheduler 遵守 phase parallelism。
- Scheduler 不会同时运行两个 write steps。
- Manual gates 会暂停执行。
- Failed steps 可以作为新的 task execution 重试。
- Review Loop 会在 `maxLoops` 停止。

为 renderer/main wiring 增加静态集成测试：

- Workflow IPC methods 通过 preload 暴露，并在 `src/types/freebuddy.d.ts` 中有类型。
- Workflow store 调用 typed client methods。
- Workflow UI 渲染 plan preview、running steps、failed steps 和 final summary states。

构建验证：

- `npm test`
- `npm run typecheck`
- `npm run build:renderer`

## 迁移计划

1. 增加 renderer 和 Electron main 共用的 workflow types。
2. 增加 workflow database tables 和 persistence helpers。
3. 增加 plan validation。
4. 增加 workflow IPC 和 client methods。
5. 增加 phases、dependencies、stop 和 retry 的 runtime scheduling。
6. 增加 Review Loop Workflow template generation prompt。
7. 增加 plan preview UI。
8. 增加 workflow progress side panel。
9. 向 conversation messages 追加最终 workflow summary。
10. 增加 validation、scheduling、IPC wiring 和 UI state coverage 测试。

## 已决定事项

- 第一版使用受控 JSON plans，不执行任意 JavaScript。
- Review Loop Workflow 是第一个内置模板。
- Workflow steps 复用现有本地 agents 和现有 ACP/CLI task execution。
- Workflow progress 在 side panel 中可见；主聊天区域以 summary 为主。
- 在 worktree isolation 存在之前，write operations 保持保守策略。
- Saved reusable workflows 等 runtime 和 Review Loop template 稳定后再做。

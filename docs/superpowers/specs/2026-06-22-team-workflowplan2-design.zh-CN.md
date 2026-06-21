# 团队驱动的 WorkflowPlan2 设计

## 目标

为 FreeBuddy 增加 Team Management，并把 WorkflowPlan2 的专业图计划能力收进团队配置里。

用户心智从“新建对话时选择 workflow mode，并审阅一份计划”调整为：

> 先创建一支团队。团队已经知道谁负责规划、审查、实现、验证，以及应该按什么流程协作。新建对话时用户只选择团队、输入目标、确认路线，然后团队开始执行。

这让高级 GraphFlow 风格能力仍然存在，但默认不暴露给普通任务入口。普通用户看到的是团队、路线、审批点和结果；高级用户在团队编辑里查看或编辑图计划。

## 背景

当前 FreeBuddy 已经具备这些基础能力：

- `CLIMember` 定义可用本地 agent，包括 Codex、ClaudeCode、OpenCode、Cursor 和 Kimi。
- Workflow runtime 可以创建 run、seed steps、按 phase/step 执行，并复用现有 `cliRun()`。
- Review Loop 模板已经有 `reviewer`、`implementer`、`verifier` 的临时角色分工。
- Workflow UI 已经有新任务页的 workflow mode、plan preview card 和右侧 run panel。

现有问题是产品心智仍偏技术化：

- 用户在新任务入口需要理解 workflow mode。
- Plan preview 直接展示 phases、steps、write step、gates 等工程结构。
- reviewer/implementer/verifier 只是一次模板生成的入参，不是用户可管理的团队资产。
- GraphFlow 风格的节点、边、条件、循环如果直接放到新建对话，会让主流程过重。

Team Management 的职责是把“角色分工 + 工作流模板 + 安全策略”保存成一个可复用对象，让新建对话只消费团队。

## 非目标

- 不在第一版实现 marketplace 或团队分享。
- 不执行任意用户脚本或模型生成的 JavaScript/Python workflow。
- 不在新建对话主流程里提供完整图编辑器。
- 不要求第一版支持复杂可视化画布拖拽。
- 不替换普通单 agent 对话。
- 不改变 ACP/legacy agent runtime 协议层；团队步骤仍复用现有 CLI/ACP task execution。
- 不在第一版解决 app 重启后长期恢复正在运行团队任务的问题。

## 产品模型

### Team

Team 是用户保存的一支本地 agent 团队。它包含成员角色、工作流模板、执行策略和默认展示方式。

示例：

- 快速实现团队：Planner -> Implementer -> Verifier。
- 代码审查团队：Researcher -> Reviewer -> 用户确认 -> Implementer -> Verifier -> Summarizer。
- 只读分析团队：Researcher + Reviewer -> Summarizer，不允许写文件。

Team 不是一次运行。Team 是可复用模板。

### Team Role

Role 是团队里的岗位，不是 agent 本身。

内置角色：

- `planner`：拆解目标，生成或填充本次执行路线。
- `researcher`：只读探索代码、文档和上下文。
- `reviewer`：审查风险、问题和可执行 findings。
- `implementer`：执行写入修改。
- `verifier`：运行检查并判断是否完成。
- `summarizer`：汇总结果，输出给主对话。

每个 role 绑定一个默认 `agentId`。运行前可以临时覆盖，但不会修改团队默认配置。

### Team Workflow Template

Workflow template 是团队固定的协作骨架。它定义节点、边、条件、审批点和策略，但不固定本次任务的目标文本。

团队模板应包含占位变量：

- `{{goal}}`
- `{{cwd}}`
- `{{targetPaths}}`
- `{{attachments}}`
- `{{approvedFindings}}`
- `{{previousStepSummary:<nodeId>}}`

运行时根据用户输入和上游 step 输出填充这些变量，生成本次 WorkflowPlan2 run snapshot。

### WorkflowPlan2

WorkflowPlan2 是可序列化、安全受控的图计划。它是 Team template 在某次任务上的运行快照。

WorkflowPlan2 取代当前 phase-first 的 WorkflowPlan 作为下一代内部结构，但第一阶段可以提供兼容转换，让现有 Review Loop 继续运行。

### Run

Run 是一次团队执行。Run 保存：

- 使用的 team id 和 team snapshot。
- 用户目标、工作目录和本次输入。
- 展开后的 WorkflowPlan2。
- 节点状态、审批状态、关联 CLI task id 和最终 summary。

Run 必须保存团队快照，而不是只保存 `team_id`。这样团队后续被编辑时，历史 run 仍然可复盘。

## 用户流程

### 创建团队

1. 用户进入 Settings 或侧边栏中的 Teams。
2. 点击 New Team。
3. 选择一个起点：
   - 快速实现团队。
   - 代码审查团队。
   - 只读分析团队。
   - 空白高级团队。
4. 填写团队名称、描述和默认工作模式。
5. 为每个角色选择 agent。
6. 选择或编辑 workflow template。
7. 设置安全策略。
8. 保存团队。

默认视图应是表单式，不是图编辑器。

### 编辑团队

团队编辑分两层：

#### 基础模式

基础模式展示：

- 团队名称和用途。
- 角色列表。
- 每个角色绑定的 agent。
- 工作流模板摘要。
- 安全策略。

用户可以调整角色绑定、是否允许写文件、是否需要写前确认、最大循环次数和最大并发。

#### 专业模式

专业模式展示：

- 查看图计划。
- 编辑节点。
- 编辑条件边。
- 设置 join 语义。
- 设置循环和退出条件。
- 设置每个节点的角色、mode、prompt 模板、目标路径约束和 retry 策略。

专业模式属于团队编辑器，不属于新建对话主流程。

### 新建对话

新建对话页保留两个顶层入口：

- 直接对话：选择单个 agent，像现在一样发送消息。
- 团队执行：选择一个 team。

团队执行流程：

1. 用户选择团队。
2. 输入任务目标。
3. 选择工作目录和附件。
4. 点击生成路线。
5. FreeBuddy 用 team template + 用户目标生成 WorkflowPlan2 run preview。
6. 用户看到托管式摘要：
   - 这支团队准备怎么做。
   - 谁负责哪些阶段。
   - 哪些步骤会改文件。
   - 哪些步骤需要用户批准。
   - 最多会循环几轮。
7. 用户点击开始执行。

新建对话页不显示 raw graph editor。它只提供“查看详情”展开团队路线。

### 运行中

运行中右侧 panel 从“任务列表”升级为“团队状态”：

- 当前团队。
- 当前阶段或当前节点。
- 正在工作的角色和 agent。
- 下一步。
- 等待用户确认的事项。
- 最近输出摘要。
- 失败节点的重试、跳过或停止操作。

高级用户可以展开图计划详情，但默认看到的是自然语言状态。

### 完成后

主聊天区追加最终结果：

- 团队名称。
- 完成状态。
- 做了什么。
- 改了哪些文件。
- 运行了哪些检查。
- 未解决问题。
- 可点击查看完整 run。

## 默认团队

第一版内置三个团队。

### 快速实现团队

用途：中小型明确实现任务。

角色：

- Planner：默认 Codex。
- Implementer：默认 ClaudeCode 或 Codex。
- Verifier：默认 OpenCode 或 Codex。
- Summarizer：默认 Codex。

策略：

- 允许写文件。
- 第一个 write 节点前需要确认。
- 同时最多一个 write 节点。
- 最多一轮 verify retry。

模板：

1. `plan-task`
2. `implement`
3. `verify`
4. `summarize`

### 代码审查团队

用途：风险高、需要先审查再改的任务。

角色：

- Researcher：默认 Codex。
- Reviewer：默认 ClaudeCode 或 Codex。
- Implementer：默认 ClaudeCode。
- Verifier：默认 OpenCode 或 Codex。
- Summarizer：默认 Codex。

策略：

- 允许写文件。
- Review 结束后必须用户确认 findings。
- 最多 3 轮 review loop。
- verify 失败后进入 blocked，等待用户决定。

模板：

1. `baseline`
2. `review`
3. `approve-findings`
4. `implement`
5. `verify`
6. 条件循环到 `review` 或进入 `summarize`

### 只读分析团队

用途：理解代码、比较方案、生成报告，不改文件。

角色：

- Researcher：默认 Codex。
- Reviewer：默认 ClaudeCode。
- Summarizer：默认 Codex。

策略：

- 禁止写文件。
- 并发只读节点最多 3 个。
- 不需要写前确认，因为不会写。

模板：

1. `research-context`
2. `review-risks`
3. `summarize`

## 数据结构

### Team 类型

```ts
export interface WorkflowTeam {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  enabled: boolean;
  source: "builtin" | "user";
  roles: WorkflowTeamRole[];
  template: WorkflowTemplate2;
  policy: WorkflowTeamPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTeamRole {
  id: string;
  label: string;
  kind:
    | "planner"
    | "researcher"
    | "reviewer"
    | "implementer"
    | "verifier"
    | "summarizer"
    | "custom";
  agentId: string;
  required: boolean;
  canWrite: boolean;
  description?: string;
}

export interface WorkflowTeamPolicy {
  allowWrites: boolean;
  requireApprovalBeforeWrite: boolean;
  requireApprovalAfterReview: boolean;
  maxParallelReadSteps: number;
  maxParallelWriteSteps: 1;
  maxLoops: number;
  stopOnVerifyFailure: boolean;
}
```

### WorkflowTemplate2 类型

```ts
export interface WorkflowTemplate2 {
  id: string;
  name: string;
  description?: string;
  version: 1;
  nodes: WorkflowTemplateNode[];
  edges: WorkflowTemplateEdge[];
  startNodeIds: string[];
  finalNodeIds: string[];
}

export interface WorkflowTemplateNode {
  id: string;
  title: string;
  roleId?: string;
  mode: "research" | "review" | "write" | "verify" | "summarize" | "approval";
  promptTemplate?: string;
  targetPathTemplates?: string[];
  retry?: {
    maxAttempts: number;
    onFailure: "block" | "skip" | "continue";
  };
}

export interface WorkflowTemplateEdge {
  id: string;
  from: string;
  to: string;
  activation?: "all" | "any";
  condition?: WorkflowEdgeCondition;
}

export type WorkflowEdgeCondition =
  | { type: "always" }
  | { type: "status"; nodeId: string; equals: "done" | "failed" | "skipped" }
  | { type: "summary_contains"; nodeId: string; text: string }
  | { type: "summary_regex"; nodeId: string; pattern: string }
  | { type: "approval"; approvalId: string; equals: "approved" | "rejected" };
```

### WorkflowPlan2 类型

```ts
export interface WorkflowPlan2 {
  id: string;
  name: string;
  goal: string;
  cwd?: string;
  teamId: string;
  teamSnapshot: WorkflowTeam;
  templateId: string;
  nodes: WorkflowPlanNode[];
  edges: WorkflowPlanEdge[];
  startNodeIds: string[];
  finalNodeIds: string[];
  policy: WorkflowTeamPolicy;
  maxLoops: number;
}

export interface WorkflowPlanNode {
  id: string;
  title: string;
  roleId?: string;
  agentId?: string;
  mode: WorkflowTemplateNode["mode"];
  prompt: string;
  targetPaths?: string[];
  approvalId?: string;
  retry?: WorkflowTemplateNode["retry"];
}

export interface WorkflowPlanEdge extends WorkflowTemplateEdge {}
```

## 数据库

新增团队表。

### `workflow_teams`

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `description TEXT`
- `icon TEXT`
- `enabled INTEGER NOT NULL DEFAULT 1`
- `source TEXT NOT NULL`
- `roles_json TEXT NOT NULL`
- `template_json TEXT NOT NULL`
- `policy_json TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### `workflow_runs` 扩展

保留现有字段，新增：

- `team_id TEXT`
- `team_snapshot_json TEXT`
- `plan_version INTEGER NOT NULL DEFAULT 1`

第一阶段兼容规则：

- `plan_version = 1`：按现有 `WorkflowPlan` 解析。
- `plan_version = 2`：按 `WorkflowPlan2` 解析。

也可以先不迁移旧 run，只让新团队 run 使用 `plan_version = 2`。

## IPC 和服务边界

新增 `electron/cli/workflowTeams.ts`：

- `listWorkflowTeams()`
- `getWorkflowTeam(id)`
- `createWorkflowTeam(input)`
- `updateWorkflowTeam(id, patch)`
- `deleteWorkflowTeam(id)`
- `seedBuiltinWorkflowTeams()`

新增或扩展 `electron/cli/workflowIpc.ts` handlers：

- `workflowTeams:list`
- `workflowTeams:get`
- `workflowTeams:create`
- `workflowTeams:update`
- `workflowTeams:delete`
- `workflow:previewTeamRun`
- `workflow:createTeamRun`

Renderer 侧新增：

- `src/services/workflowTeams/types.ts`
- `src/services/workflowTeams/client.ts`
- `src/store/workflowTeamStore.ts`

现有 `workflowStore` 继续负责 run 状态；`workflowTeamStore` 负责团队配置。

## Runtime 设计

### Plan2 展开

`previewTeamRun` 做这些事情：

1. 读取 team。
2. 校验 team roles 是否能映射到已启用 `CLIMember`。
3. 将 template node 中的变量替换成本次 goal、cwd、target paths 和 attachments。
4. 应用 policy。
5. 生成 `WorkflowPlan2`。
6. 校验图结构。
7. 返回托管式预览模型。

### Plan2 调度

第一阶段有两种实现路径：

- 适配器路径：将常见 Plan2 图转换为现有 phase/step WorkflowPlan，再交给当前 runtime。
- 原生路径：新增 graph scheduler，直接根据 nodes/edges/conditions 选择 runnable nodes。

推荐第一阶段使用适配器路径完成 Team Management 的产品闭环，同时为原生 graph scheduler 保留数据结构和验证规则。

### Graph Scheduler 后续规则

原生 scheduler 需要：

- 从 `startNodeIds` 开始。
- node 可运行条件：所有 required incoming edges 满足，或同一 activation group 中任一 `any` 条件满足。
- write node 必须满足 policy 和 approval。
- 同时只允许一个 write node。
- loop 必须受 `maxLoops` 或明确退出条件限制。
- failed node 根据 retry policy 进入 retry、skipped 或 blocked。
- final nodes 完成后 run 完成。

## Validation

Team validation：

- team name 非空。
- roles id 唯一。
- required roles 必须绑定已启用 agent。
- `allowWrites = false` 时，template 中不得有 write nodes。
- `maxParallelReadSteps` 在 1 到 3 之间。
- `maxParallelWriteSteps` 第一版必须为 1。

Template validation：

- node id 唯一。
- edge id 唯一。
- edge from/to 引用存在的 node。
- start/final node 引用存在。
- 每个非 approval node 必须绑定存在 role。
- write node 必须绑定 `canWrite = true` 的 role。
- 循环必须有条件边，并受 `maxLoops` 限制。
- prompt 模板不能为空，approval node 可以没有 prompt。
- condition 只能引用更早可达节点或明确允许的 loop 节点。

Run validation：

- 展开后的 prompt 非空。
- 每个非 approval node 都能解析到 agent。
- policy 不允许的写入节点不能运行。
- 需要审批的节点必须有 approval id。

## UI 设计

### Teams 入口

第一版建议放在 Settings 中，与 Cli Agents 并列：

- Cli Agents：管理单个 agent 能力和命令。
- Teams：管理团队、角色、模板和策略。

后续可以在 sidebar 增加 Teams 快捷入口。

### Team List

列表展示：

- 团队名称。
- 简短描述。
- 角色数量。
- 是否允许写文件。
- 模板类型。
- 最近更新。

操作：

- New Team。
- Duplicate。
- Edit。
- Disable。
- Delete user team。

内置团队可复制和禁用，但不可直接删除。

### Team Editor

使用单页分区：

1. Overview：名称、描述、图标、启用状态。
2. Roles：角色和 agent 绑定。
3. Workflow：模板摘要。
4. Policy：写入、审批、并发、循环。
5. Advanced：查看图计划、编辑节点和边。

Advanced 默认折叠。

### 新建对话页

新任务页改为：

- 直接对话。
- 团队执行。

团队执行模式下：

- 团队 selector 是第一优先级。
- agent selector 不再出现，除非用户展开“本次临时替换角色”。
- 输入框仍然是任务目标。
- 工作目录、附件、权限保留。
- 发送按钮文案在 tooltip/aria 上改为“生成执行路线”。

### Preview Card

Team run preview card 第一层展示：

- 团队名称。
- 路线摘要。
- 角色分工。
- 写入风险。
- 审批点。
- 预计循环上限。

展开详情展示：

- 节点列表。
- 条件边。
- 原始 prompt。
- Graph JSON。

### Run Panel

Run panel 第一层展示：

- 当前团队。
- 当前状态。
- 正在执行的角色。
- 下一个节点。
- 最近摘要。
- 待用户处理事项。

节点详情保留 prompt、summary、retry 等专业信息。

## 安全策略

- 新建团队时默认安全。
- 内置只读团队完全禁止 write node。
- 允许写入的团队默认第一个 write node 前需要审批。
- Review 后审批和 write 前审批是两个不同开关。
- graph editor 中新增 write node 时，如果团队 policy 不允许写入，保存失败。
- 团队 run 启动时仍必须显示 preview。
- 运行时仍沿用现有 ACP permission flow。
- Stop 必须停止当前 active CLI task。

## 迁移策略

### 阶段 1：团队和模板产品化

- 新增 Team 数据模型和数据库表。
- Seed 三个内置团队。
- Settings 增加 Teams tab。
- 新建对话团队执行模式选择团队。
- Team template 先生成兼容当前 WorkflowPlan 的 run。

### 阶段 2：WorkflowPlan2 预览和持久化

- 引入 `WorkflowPlan2` 类型。
- Run 存储 team snapshot 和 plan_version。
- Preview card 使用 Team-oriented 信息层级。
- Plan2 可转换为现有 WorkflowPlan 执行。

### 阶段 3：专业模式图编辑

- Team Editor Advanced 增加 node/edge 表格式编辑。
- 支持条件边和 loop 设置。
- 增加 template validation。
- 暂不做拖拽画布。

### 阶段 4：原生 Graph Scheduler

- Runtime 支持直接执行 WorkflowPlan2。
- 支持 `all` / `any` join。
- 支持条件边。
- 支持 bounded loop。
- 旧 WorkflowPlan 继续通过兼容层运行。

## 测试计划

### Unit tests

- Team validation 接受三个内置团队。
- Team validation 拒绝 unknown agent、duplicate roles、非法 write policy。
- Template validation 拒绝 unknown nodes、bad edges、unbounded loops。
- Plan2 expansion 正确替换 `{{goal}}`、`{{cwd}}` 和 role agent。
- Plan2 to WorkflowPlan adapter 输出兼容现有 runtime 的 phase/step 结构。

### IPC 和 persistence tests

- `workflow_teams` 表创建成功。
- 内置 teams seed 幂等。
- team create/update/list/get/delete 可用。
- `workflow:previewTeamRun` 返回 preview 和 plan。
- `workflow:createTeamRun` 存储 `team_id`、`team_snapshot_json` 和 `plan_version`。

### Renderer static tests

- Settings 有 Teams tab。
- Team list 显示内置团队。
- Team editor 有 Overview、Roles、Workflow、Policy、Advanced sections。
- New task 团队执行模式显示 team selector。
- WorkflowPlanCard 第一层使用 team-oriented labels。
- Advanced graph details 默认折叠。

### Runtime tests

- 使用快速实现团队可以生成并执行兼容 plan。
- 只读团队生成的 plan 不包含 write steps。
- 代码审查团队保留 review approval gate。
- stop、retry、approve gate 继续可用。

## 验证命令

实现完成后运行：

- `npm run typecheck`
- `npm test`
- `npm run build:renderer`
- 如果修改 Electron main 或 preload：`npm run build`

本设计文档本身是产品和架构 spec，不包含代码实现。

## 已决定事项

- 专业模式放在团队编辑器里，不放在新建对话主流程里。
- 新建对话只消费团队：选择团队、输入目标、生成路线、确认执行。
- Team 固定 workflow template 骨架；每次 run 动态填充 goal、cwd、附件和上下文。
- Run 保存 team snapshot，保证历史可复盘。
- 第一版可以把 Plan2 转换为现有 WorkflowPlan 执行，避免一次性重写 runtime。
- GraphFlow 风格能力作为 Team Advanced 的长期方向。

## 待确认事项

- Teams 入口第一版是否只放 Settings，还是同时放 sidebar 快捷入口。
- 内置团队默认 agent 分配是否固定为 Codex/ClaudeCode/OpenCode，还是按已安装状态自动选择。
- 专业模式第一版是只读 graph preview，还是允许表格式编辑节点和边。

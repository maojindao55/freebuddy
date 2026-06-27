# 业务空间多仓库 Agent 协同设计

## 目标

为 FreeBuddy 增加面向真实业务交付的多仓库协同能力。

用户心智从“选择一个工作目录，让一个 Agent 做事”升级为：

> 先配置一个业务空间。业务空间知道这个业务由哪些端组成，每个端在哪个仓库、默认由哪个 Agent 负责、可以运行哪些验证。用户输入一个需求后，FreeBuddy 先生成跨端认领计划和接口契约草案，用户确认后，各端 Agent 在各自仓库并行工作，最后统一审查 diff、验证结果并批量提交。

这个能力服务于常见的多项目业务结构，例如 C 端、服务端、管理后台、共享组件库、文档或测试仓库。它不是为了暴露 Git 拓扑，而是为了让用户按“业务”派发需求。

## 非目标

- 不在第一版自动 push。
- 不在第一版自动创建 PR。
- 不在第一版解决远程 CI 编排。
- 不让某个 Surface Agent 随意写入其他仓库。
- 不替换现有单 Agent 普通对话。
- 不把业务空间和 Team 合并成同一个对象。
- 不要求第一版启动完整联调环境。
- 不在新建需求主流程里暴露底层图编辑器。

## 设计原则

- 业务优先：用户选择业务空间，而不是手动选择多个 repo。
- 端内自治：每个端绑定自己的仓库、Agent、验证命令和允许写入范围。
- 半自动认领：系统生成建议，用户确认或调整后才执行。
- 契约先行：跨端需求先生成接口/数据契约草案，再并行实现。
- 统一提交闸口：Agent 可以并行改代码，但 commit 必须经过一次总确认。
- 可审计：每次运行保存业务空间快照、认领计划、契约草案、diff 摘要和提交结果。

## 产品模型

### Business Workspace

Business Workspace 是一组相关代码仓库的业务协作单元。它保存业务名称、端列表、默认团队和运行策略。

示例：

- 会员业务
- 订单业务
- 内容审核业务
- 营销活动业务

业务空间不是一次运行。它是可复用配置。

### Business Surface

Business Surface 是业务空间里的一个端或子项目。

常见 Surface：

- C 端前端
- 服务端
- 管理后台
- 小程序
- 共享组件库
- 文档仓库
- 自动化测试仓库

每个 Surface 包含：

- 名称和类型。
- 本地仓库路径。
- 默认 Agent。
- 可选的允许写入路径。
- 可选的验证命令。
- 该端职责说明。
- 契约角色：provider、consumer、both 或 none。

### Team

Team 继续表达“怎么协作”：角色、流程、审批、安全策略。

Business Workspace 表达“在哪些仓库协作”：端、仓库路径、默认 Agent、验证命令和允许范围。

二者保持分离。业务空间可以引用默认 Team。这样同一个业务空间可以使用不同团队执行：

- 快速实现团队。
- 稳定审查团队。
- 只读分析团队。
- 多端联调团队。

### Requirement Run

Requirement Run 是一次业务需求执行。它保存：

- 使用的业务空间 id 和快照。
- 用户输入的需求。
- 认领计划。
- 接口/数据契约草案。
- 每个 Surface 的执行状态。
- 每个仓库的验证结果、diff 摘要、风险和提交信息。
- 最终交付报告。

## 用户流程

### 配置业务空间

1. 用户进入 Settings 或侧边栏中的 Business Workspaces。
2. 新建业务空间。
3. 添加 Surface。
4. 为每个 Surface 选择本地仓库。
5. 为每个 Surface 选择默认 Agent。
6. 配置允许写入路径和验证命令。
7. 选择默认 Team。
8. 保存业务空间。

基础视图应是表单式，避免用户直接编辑 JSON 或图结构。

### 创建业务需求

新建任务页可以在现有模式基础上演进为：

- 普通对话。
- 团队执行。
- 业务需求。

业务需求模式下：

1. 用户选择业务空间。
2. 输入需求。
3. 可选添加附件和补充上下文。
4. 点击生成认领计划。
5. FreeBuddy 读取业务空间和默认 Team，生成本次运行预览。

### 认领计划

认领计划以“先按端分组，再显示依赖链路”为主视图。

每个 Surface 卡片展示：

- 端名称。
- 目标仓库。
- 推荐 Agent。
- 建议任务。
- 是否写入。
- 验证命令。
- 与其他端的依赖关系。

跨端依赖在卡片之间展示，例如：

- C 端依赖服务端接口。
- 管理后台配置影响服务端校验。
- 服务端 schema 变更影响 C 端字段展示。

用户可以在执行前调整：

- 参与的 Surface。
- 每个 Surface 的 Agent。
- 每个 Surface 的任务文本。
- 是否需要契约草案。
- 是否允许某个 Surface 写入。

### 契约草案

如果需求涉及 provider 和 consumer，Planner 先生成接口/数据契约草案。

契约草案包含：

- 接口路径和方法。
- 请求参数。
- 响应结构。
- 错误码。
- 字段含义。
- 权限规则。
- 数据状态或枚举。
- 与 UI 表现相关的约束。

服务端通常是 provider，C 端和管理后台通常是 consumer。各端 Agent 使用同一份契约草案并行实现。后续如果服务端实现调整，依赖端再局部修正。

### 并行实现

用户确认认领计划后，各端 Agent 开始执行。

执行规则：

- 每个 Surface Agent 的 `cwd` 固定为该端 `repoPath`。
- 每个 Surface Agent 只允许写自己的仓库。
- 跨端上下文通过契约草案、上游 summary 和运行状态传递。
- 每个 Surface 可以独立进入等待、实现、验证、失败或完成状态。
- Coordinator 负责汇总状态和发现阻塞。

主聊天区展示关键决策、契约草案、用户确认点和最终报告。每个 Surface 的详细日志在对应卡片中展开查看。

### 联调验证

第一版不要求真正启动全链路环境，但必须做两类验证：

- 端内验证：运行每个 Surface 配置的验证命令。
- 契约一致性审查：Planner 或 Verifier 对照契约草案检查各端输出是否一致。

如果某个 Surface 没有验证命令，UI 要显示为“未配置验证”，不能伪装为通过。

### 统一提交闸口

所有 Surface 完成后进入统一提交确认页。

提交闸口展示：

- 每个仓库的 diff 摘要。
- 每个仓库的验证结果。
- 每个仓库的建议分支名。
- 每个仓库的建议 commit message。
- 风险和未解决项。
- 契约一致性结果。

用户确认后，FreeBuddy 在每个涉及仓库：

1. 创建分支。
2. 暂存本次运行产生的改动。
3. 创建 commit。
4. 保存提交结果。

第一版只做本地 branch 和 commit，不自动 push，不自动 PR。

## 数据模型

### BusinessWorkspace

```ts
export interface BusinessWorkspace {
  id: string;
  name: string;
  description?: string;
  surfaces: BusinessSurface[];
  defaultTeamId?: string;
  policy: BusinessWorkspacePolicy;
  createdAt: string;
  updatedAt: string;
}
```

### BusinessSurface

```ts
export type BusinessSurfaceKind =
  | "client"
  | "server"
  | "admin"
  | "shared"
  | "docs"
  | "test"
  | "custom";

export type ContractRole = "provider" | "consumer" | "both" | "none";

export interface BusinessSurface {
  id: string;
  name: string;
  kind: BusinessSurfaceKind;
  repoPath: string;
  defaultAgentId: string;
  allowedPaths: string[];
  verifyCommands: string[];
  responsibilities: string[];
  contractRole: ContractRole;
  enabled: boolean;
}
```

### BusinessWorkspacePolicy

```ts
export interface BusinessWorkspacePolicy {
  requireAssignmentApproval: true;
  requireCommitApproval: true;
  blockCommitOnVerificationFailure: boolean;
  requireCleanRepoBeforeRun: boolean;
  branchNameTemplate: string;
}
```

第一版默认：

- `requireAssignmentApproval = true`
- `requireCommitApproval = true`
- `blockCommitOnVerificationFailure = true`
- `requireCleanRepoBeforeRun = true`
- `branchNameTemplate = "fb/{{runSlug}}/{{surfaceKey}}"`

### BusinessRequirementRun

```ts
export interface BusinessRequirementRun {
  id: string;
  workspaceId: string;
  workspaceSnapshot: BusinessWorkspace;
  teamId?: string;
  goal: string;
  status:
    | "draft"
    | "planning"
    | "awaiting_assignment_approval"
    | "running"
    | "verifying"
    | "awaiting_commit_approval"
    | "committing"
    | "done"
    | "failed"
    | "cancelled";
  assignmentPlan?: BusinessAssignmentPlan;
  contractDraft?: BusinessContractDraft;
  surfaceRuns: BusinessSurfaceRun[];
  commitGate?: BusinessCommitGate;
  createdAt: string;
  updatedAt: string;
}
```

### BusinessAssignmentPlan

```ts
export interface BusinessAssignmentPlan {
  surfaces: Array<{
    surfaceId: string;
    agentId: string;
    repoPath: string;
    tasks: string[];
    dependsOnSurfaceIds: string[];
    writes: boolean;
    verifyCommands: string[];
  }>;
  dependencies: Array<{
    fromSurfaceId: string;
    toSurfaceId: string;
    reason: string;
  }>;
  needsContractDraft: boolean;
  summary: string;
}
```

### BusinessContractDraft

```ts
export interface BusinessContractDraft {
  id: string;
  title: string;
  providerSurfaceIds: string[];
  consumerSurfaceIds: string[];
  endpoints: Array<{
    method: string;
    path: string;
    request: string;
    response: string;
    errors: string[];
  }>;
  dataRules: string[];
  permissionRules: string[];
  notes: string[];
}
```

### BusinessSurfaceRun

```ts
export interface BusinessSurfaceRun {
  id: string;
  surfaceId: string;
  agentId: string;
  repoPath: string;
  status:
    | "pending"
    | "waiting_contract"
    | "running"
    | "verifying"
    | "done"
    | "failed"
    | "blocked";
  taskSummary: string;
  verificationResults: BusinessVerificationResult[];
  diffSummary?: string;
  riskSummary?: string;
  branchName?: string;
  commitMessage?: string;
  commitSha?: string;
}
```

### BusinessVerificationResult

```ts
export interface BusinessVerificationResult {
  command: string;
  cwd: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  summary: string;
  startedAt?: string;
  endedAt?: string;
}
```

### BusinessCommitGate

```ts
export interface BusinessCommitGate {
  status: "pending" | "approved" | "rejected" | "committed";
  repositories: Array<{
    surfaceId: string;
    repoPath: string;
    branchName: string;
    commitMessage: string;
    diffFiles: string[];
    diffSummary: string;
    verificationResults: BusinessVerificationResult[];
    risks: string[];
    commitSha?: string;
  }>;
  contractConsistency: {
    status: "passed" | "failed" | "unknown";
    summary: string;
  };
  allowCommitWithFailures: boolean;
  approvedAt?: string;
}
```

## 数据库

新增业务空间表。

### `business_workspaces`

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `description TEXT`
- `surfaces_json TEXT NOT NULL`
- `default_team_id TEXT`
- `policy_json TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

新增业务需求运行表。

### `business_requirement_runs`

- `id TEXT PRIMARY KEY`
- `workspace_id TEXT NOT NULL`
- `workspace_snapshot_json TEXT NOT NULL`
- `team_id TEXT`
- `goal TEXT NOT NULL`
- `status TEXT NOT NULL`
- `assignment_plan_json TEXT`
- `contract_draft_json TEXT`
- `surface_runs_json TEXT NOT NULL`
- `commit_gate_json TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

第一版可以把 `surface_runs` 放在 JSON 字段中，避免过早拆成多张表。后续如果要支持复杂筛选和恢复，再拆独立 surface run 表。

## IPC 和服务边界

新增 `electron/cli/businessWorkspaces.ts`：

- `listBusinessWorkspaces()`
- `getBusinessWorkspace(id)`
- `createBusinessWorkspace(input)`
- `updateBusinessWorkspace(id, patch)`
- `deleteBusinessWorkspace(id)`
- `validateBusinessWorkspace(workspace)`

新增 `electron/cli/businessRequirementRuns.ts`：

- `createBusinessRequirementRun(input)`
- `previewBusinessAssignment(input)`
- `approveBusinessAssignment(runId, patch)`
- `startBusinessRequirementRun(runId)`
- `refreshBusinessRequirementRun(runId)`
- `previewBusinessCommitGate(runId)`
- `approveBusinessCommitGate(runId, patch)`

Renderer 侧新增：

- `src/services/businessWorkspaces/types.ts`
- `src/services/businessWorkspaces/client.ts`
- `src/store/businessWorkspaceStore.ts`
- `src/store/businessRequirementRunStore.ts`

现有 workflow runtime 可以继续作为单 Surface 执行基础。业务需求运行层负责多 Surface 编排、契约草案和提交闸口。

## Runtime 设计

### 阶段 1：需求拆解

Coordinator 根据业务空间、用户需求和默认 Team 生成认领计划。

输出必须是结构化 JSON，不从自然语言中猜测执行状态。

### 阶段 2：契约草案

如果 `needsContractDraft = true`，Coordinator 生成契约草案。用户可以确认或编辑草案。确认后的契约草案会注入每个相关 Surface Agent 的 prompt。

### 阶段 3：Surface 执行

每个 Surface 被转换成一个受约束的 agent task：

- `cwd = surface.repoPath`
- prompt 包含该 Surface 任务、契约草案、依赖关系和允许范围。
- 执行前检查仓库状态。
- 写入范围受 `allowedPaths` 约束。

第一版可以顺序调度 provider，再并行调度 consumers；也可以在契约草案确认后直接并行调度。默认采用契约草案并行调度。

### 阶段 4：验证

每个 Surface 运行自己的验证命令。Verifier 汇总结果，并做契约一致性审查。

### 阶段 5：提交闸口

提交前收集：

- `git diff --stat`
- `git diff --name-only`
- 验证结果。
- 风险摘要。
- 建议分支名。
- 建议 commit message。

用户确认后执行本地分支和 commit。

## 安全策略

- 没有 `repoPath` 的 Surface 不能参与写入。
- `repoPath` 必须是本地绝对路径。
- 默认要求仓库在执行前是干净的。
- `allowedPaths` 为空时允许整个仓库，但 UI 必须提示风险。
- 任何验证失败时默认禁止批量 commit。
- 用户可以显式选择带失败项提交，但必须二次确认。
- 每个 Surface Agent 只能写自己的仓库。
- commit 前必须统一确认。
- 第一版不自动 push，不自动 PR。
- 每次运行保存业务空间快照，避免后续配置变更影响历史记录。

## UI 设计

### Settings / Business Workspaces

业务空间列表展示：

- 业务名称。
- Surface 数量。
- 默认 Team。
- 最近使用时间。
- 是否有未配置仓库或未配置 Agent 的 Surface。

业务空间编辑器包含：

- 基本信息。
- Surface 列表。
- 每个 Surface 的仓库路径、默认 Agent、允许路径、验证命令、职责和契约角色。
- 默认 Team。
- 安全策略。

### 新建任务页 / 业务需求

新增业务需求模式：

- 选择业务空间。
- 输入需求。
- 添加附件。
- 生成认领计划。

认领计划预览包含：

- Surface 分组卡片。
- 依赖链路。
- 契约草案摘要。
- 写入和验证风险。
- 确认执行按钮。

### 运行中面板

右侧面板按 Surface 展示状态：

- 等待契约。
- 实现中。
- 验证中。
- 待提交。
- 已提交。
- 失败或阻塞。

每个 Surface 可以展开查看：

- 当前 Agent。
- 仓库路径。
- 子任务。
- 最近输出摘要。
- 验证结果。
- diff 摘要。

### 统一提交页

提交页展示：

- 每个仓库的分支名。
- 每个仓库的 commit message。
- 改动文件列表。
- diff 摘要。
- 验证结果。
- 风险和未解决项。

用户可以编辑 commit message，然后一次确认批量提交。

## 测试计划

### 单元测试

- Business workspace validation 接受有效配置。
- 缺少 repoPath 的写入 Surface 被拒绝。
- unknown agent 被拒绝。
- duplicate surface id 被拒绝。
- invalid verify command shape 被拒绝。
- branch name template 能正确填充 run slug 和 surface key。
- assignment plan 必须引用存在的 surface。
- contract draft 的 provider 和 consumer 必须引用存在的 surface。

### Runtime 合约测试

- 业务需求 run 生成 assignment plan。
- 用户未确认 assignment plan 时不启动 Surface Agent。
- Surface Agent 使用自己的 repoPath 作为 cwd。
- Surface Agent 不能写其他 Surface 的 repoPath。
- 验证失败时默认阻止 commit gate。
- 用户确认 commit gate 后，每个仓库创建独立分支和 commit。
- 有未提交改动的仓库默认阻止运行。

### UI 合约测试

- Settings 显示 Business Workspaces tab。
- 业务空间编辑器显示 Surface 列表。
- 新建任务页显示业务需求模式。
- 业务需求模式显示业务空间 selector。
- assignment preview 按 Surface 分组。
- preview 展示跨端依赖。
- commit gate 展示每个仓库的 diff 和验证状态。

## 迁移计划

### 阶段 1：业务空间配置

- 新增 Business Workspace 数据模型和 IPC。
- Settings 增加业务空间入口。
- 支持配置 Surface、repoPath、Agent、验证命令和默认 Team。

### 阶段 2：认领计划预览

- 新建任务页增加业务需求模式。
- 生成按 Surface 分组的 assignment plan。
- 支持用户确认或调整认领计划。
- 生成契约草案。

### 阶段 3：多 Surface 执行

- 将 Surface task 转为受约束 agent task。
- 支持并行执行。
- 右侧面板展示 Surface 状态。
- 运行每个 Surface 的验证命令。

### 阶段 4：统一提交闸口

- 汇总 diff、验证结果和风险。
- 支持用户编辑 commit message。
- 用户确认后为每个仓库创建分支和 commit。

### 阶段 5：增强交付

- 可选 push。
- 可选 PR 草案。
- 更完整的联调环境编排。
- 更细粒度的 Surface run 恢复。

## 决策

- 第一版采用半自动认领，不做全自动派发。
- 认领计划先按端分组，再展示依赖链路。
- 第一版默认每个涉及仓库创建独立分支和 commit。
- commit 前统一展示 diff 和验证结果，用户一次确认后批量提交。
- 跨端协作先生成契约草案，各端按草案并行执行，最后联调修正。
- Business Workspace 和 Team 分离：前者表示业务和仓库，后者表示协作方式。
- 第一版只做本地 branch 和 commit，不自动 push，不自动 PR。

## 开放问题

- 业务空间入口第一版只放 Settings，还是同时放侧边栏快捷入口。
- Surface 的 `allowedPaths` 是否需要支持 glob。
- 业务需求模式是否替代当前团队执行模式，还是与团队执行长期并列。
- 多仓库 commit gate 是否需要支持部分仓库先提交。
- 未来 PR 草案应该由 FreeBuddy 内置生成，还是交给各仓库 Agent 生成。

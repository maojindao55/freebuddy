# Dynamic Workflows Design

## Goal

Add FreeBuddy Dynamic Workflows: a controlled, visible orchestration layer that can run multiple existing CLI/ACP agents as one background workflow.

The first workflow template is Review Loop Workflow, a repeatable review cycle where one or more reviewer agents inspect a task or change, an implementer agent addresses findings, and a verifier agent decides whether another loop is needed.

The product goal is not to create an agent chat room. It is to let users start a complex task, review the generated plan, run it in the background, inspect progress by phase and agent, and receive a final synthesized result in the conversation.

## Inspiration

Claude Code's Dynamic Workflows move orchestration into a runtime-executed workflow instead of keeping every intermediate decision inside the main conversation. The important ideas to borrow are:

- The plan is explicit and repeatable.
- Agents run in the background while the main session stays responsive.
- Intermediate results are tracked outside the main conversation context.
- Users can inspect progress and stop, pause, or restart work.
- A completed workflow can be saved and reused as a command/template.

FreeBuddy should borrow that mental model, but start with a safer controlled JSON plan rather than arbitrary JavaScript workflow scripts.

References:

- https://code.claude.com/docs/en/workflows
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/sub-agents

## Non-Goals

- Do not execute arbitrary user- or model-generated JavaScript workflow scripts in the first version.
- Do not build cross-worktree merge support in the first version.
- Do not replace normal single-agent conversations.
- Do not implement a marketplace or plugin system for workflows yet.
- Do not add a new agent protocol; workflow steps reuse existing CLI/ACP adapters.
- Do not automatically allow risky filesystem, shell, or MCP actions beyond the existing permission model.
- Do not solve long-term workflow resumability across app restarts in the first pass.

## Current Architecture Fit

FreeBuddy already has the right low-level primitives:

- `CLIMember` defines available local agents.
- `cliRun()` starts one agent task with a unique session id.
- ACP and legacy runtimes normalize agent output into the renderer's stream item contract.
- `cli_tasks` stores each task, status, prompt summary, log path, pid, exit code, and tool session id.
- Conversations and messages provide the user-facing chat timeline.

Dynamic Workflows should sit above those primitives. A workflow run owns phases and steps. Each executable step starts one existing agent task and stores the resulting `cli_task_id`.

## Product Model

### Workflow

A workflow is a plan for coordinating agents. It has a goal, working directory, phases, steps, gates, and completion criteria.

### Workflow Run

A workflow run is one execution of a workflow plan. Runs can be pending approval, running, paused, blocked, completed, failed, killed, or partially completed.

### Workflow Step

A step is the smallest executable unit. A step has one assigned agent, one prompt, one mode, optional dependencies, and a result summary.

Step modes:

- `research`: read-only exploration.
- `review`: read-only critique or risk analysis.
- `write`: implementation or file edits.
- `verify`: tests, checks, or validation.
- `summarize`: synthesis of prior outputs.

### Review Loop Workflow

Review Loop Workflow is the first built-in template.

Default phases:

1. `baseline`: understand the task, target files, current state, and success criteria.
2. `review`: run one or more reviewers against the current state or proposed change.
3. `implement`: ask an implementer to address accepted findings.
4. `verify`: run checks and ask a verifier whether findings are resolved.
5. `loop_or_finish`: if verifier reports unresolved actionable issues and the loop count is below the limit, repeat review/implement/verify. Otherwise synthesize the final result.

Default limits:

- Maximum 3 review loops.
- Maximum 3 concurrent read-only steps.
- Maximum 1 write step at a time.
- Manual approval before the first write step.

## Plan Shape

Use a serializable controlled plan:

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

The plan is generated by an agent, but the runtime validates it before it can run.

Validation rules:

- Every phase and step id is unique within the plan.
- Every `agentId` maps to a known enabled `CLIMember`.
- Every dependency references an earlier step.
- `parallelism` is between 1 and 3.
- A phase cannot contain more than one `write` step.
- A write step cannot start until the runtime has recorded explicit approval for that step or its phase.
- Prompts must be non-empty after trimming.

## Data Model

Add workflow tables in `electron/cli/db.ts`.

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

Indexes:

- `idx_workflow_runs_conversation ON workflow_runs(conversation_id, created_at DESC)`
- `idx_workflow_steps_run ON workflow_steps(workflow_run_id, phase_id, created_at)`
- `idx_workflow_steps_task ON workflow_steps(cli_task_id)`

## Runtime Architecture

Add an Electron main-process workflow runtime:

- `electron/cli/workflows.ts`: persistence and row mapping.
- `electron/cli/workflowRuntime.ts`: plan validation, scheduling, step execution, pause/resume/stop, loop handling.
- `electron/cli/workflowIpc.ts`: IPC handlers for renderer actions.

The runtime does not parse ACP or CLI output directly. It starts each step through the existing task runner and listens for completion. Step summaries are derived from the final assistant stream items or a summarizer step.

Runtime responsibilities:

1. Persist a planned run.
2. Validate the plan before execution.
3. Start unblocked steps up to each phase's concurrency limit.
4. Prevent parallel write steps.
5. Record each step's `cli_task_id`.
6. Update step and run status.
7. Pause at manual gates.
8. Support stop and failed-step retry.
9. For Review Loop Workflow, decide whether to repeat the loop based on verifier output and the configured loop limit.
10. Append a final workflow summary message to the conversation.

## Renderer Architecture

Add a workflow store next to the conversation and CLI executor stores.

Renderer responsibilities:

- Request plan generation.
- Render a plan preview card before execution.
- Start, pause, resume, stop, and retry workflow runs.
- Show workflow progress in the side panel.
- Let users inspect a step's prompt, status, summary, and linked task output.
- Keep the main chat readable by showing workflow milestones and the final summary, not every intermediate stream item.

Suggested components:

- `WorkflowPlanCard`
- `WorkflowRunPanel`
- `WorkflowPhaseList`
- `WorkflowStepRow`
- `WorkflowStepDetails`
- `ReviewLoopSummary`

## User Flow

### New Workflow

1. User enters a task and enables Workflow mode, or selects a built-in Review Loop template.
2. FreeBuddy creates a normal conversation if needed.
3. Coordinator agent generates a `WorkflowPlan`.
4. FreeBuddy validates the plan.
5. UI shows the plan preview, including agents, phases, write steps, gates, and estimated risk.
6. User chooses Run, Edit Prompt, or Cancel.
7. Runtime executes the workflow.
8. User can monitor progress from the side panel.
9. Final summary is appended to the conversation.

### Review Loop

1. User selects Review Loop Workflow.
2. Baseline step summarizes target task or current changes.
3. Reviewers produce findings.
4. User confirms which findings should be addressed if the workflow is about editing files.
5. Implementer addresses approved findings.
6. Verifier checks the changes.
7. Runtime loops if unresolved findings remain and `maxLoops` is not reached.
8. Final summary includes resolved findings, unresolved findings, files touched, and checks run.

## Safety and Permissions

First version safety defaults:

- Plan preview is mandatory before a workflow starts.
- Workflow execution starts only after user approval.
- Write steps require a visible gate.
- Only one write step runs at a time.
- Read-only modes are implemented as prompt and policy constraints first; deeper per-tool enforcement can come later.
- Existing ACP permission requests still surface through the current permission flow.
- Stop kills active underlying CLI tasks.
- Retry starts a new CLI task for the failed step rather than mutating old task records.

Future hardening:

- Per-step tool restrictions.
- Worktree isolation for write steps.
- Diff preview before applying changes from isolated worktrees.
- Persistent workflow resume after app restart.

## Error Handling

- Invalid generated plans are rejected with an explanatory error and no run starts.
- If a step fails, the workflow run becomes `blocked` unless the step is marked retryable.
- If a non-critical review step fails, the user can skip it and continue.
- If a write or verify step fails, the workflow pauses for user decision.
- If the app closes while a workflow is running, active child processes follow the existing task lifecycle. Full recovery is a later feature.
- If a workflow reaches `maxLoops` with unresolved review findings, it completes as `partial` and reports the unresolved items.

## Testing

Use focused Node tests for the workflow runtime:

- Plan validation accepts valid Review Loop plans.
- Plan validation rejects unknown agents, duplicate ids, bad dependencies, empty prompts, excessive parallelism, and parallel write steps.
- Scheduler starts only unblocked steps.
- Scheduler respects phase parallelism.
- Scheduler never runs two write steps at once.
- Manual gates pause execution.
- Failed steps can be retried as new task executions.
- Review Loop stops at `maxLoops`.

Use static integration tests for renderer/main wiring:

- Workflow IPC methods are exposed through preload and typed in `src/types/freebuddy.d.ts`.
- Workflow store calls the typed client methods.
- Workflow UI renders plan preview, running steps, failed steps, and final summary states.

Build verification:

- `npm test`
- `npm run typecheck`
- `npm run build:renderer`

## Migration Plan

1. Add workflow types shared by renderer and Electron main.
2. Add workflow database tables and persistence helpers.
3. Add plan validation.
4. Add workflow IPC and client methods.
5. Add runtime scheduling for phases, dependencies, stop, and retry.
6. Add Review Loop Workflow template generation prompt.
7. Add plan preview UI.
8. Add workflow progress side panel.
9. Append final workflow summary to conversation messages.
10. Add tests for validation, scheduling, IPC wiring, and UI state coverage.

## Decisions

- The first version uses controlled JSON plans, not arbitrary JavaScript.
- Review Loop Workflow is the first built-in template.
- Workflow steps reuse existing local agents and existing ACP/CLI task execution.
- Workflow progress is visible in a side panel; the main chat remains summary-oriented.
- Write operations are deliberately conservative until worktree isolation exists.
- Saved reusable workflows are a follow-up after the runtime and Review Loop template are stable.

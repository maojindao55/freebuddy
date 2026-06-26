export type WorkflowStepMode =
  | "research"
  | "review"
  | "write"
  | "verify"
  | "summarize";

export type WorkflowGate =
  | { type: "all_done" }
  | { type: "manual_approval"; reason: string }
  | { type: "review_required"; reviewerStepId: string };

export interface WorkflowStep {
  id: string;
  title: string;
  agentId: string;
  mode: WorkflowStepMode;
  prompt: string;
  dependsOn?: string[];
  targetPaths?: string[];
  consumes?: string[];
}

export interface WorkflowPhase {
  id: string;
  title: string;
  description?: string;
  parallelism: number;
  steps: WorkflowStep[];
  gate?: WorkflowGate;
}

export interface WorkflowPlan {
  name: string;
  goal: string;
  cwd?: string;
  template?: "review-loop" | "implement-review-loop" | "custom";
  maxLoops?: number;
  phases: WorkflowPhase[];
}

export type WorkflowRunStatus =
  | "pending_approval"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "killed"
  | "partial";

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "blocked";

export interface WorkflowRunRow {
  id: string;
  conversationId?: string;
  name: string;
  goal: string;
  status: WorkflowRunStatus;
  cwd?: string;
  template?: string;
  loopIndex: number;
  maxLoops: number;
  planJson: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkflowStepRow {
  id: string;
  workflowRunId: string;
  phaseId: string;
  stepId: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  mode: WorkflowStepMode;
  status: WorkflowStepStatus;
  prompt: string;
  dependsOn?: string[];
  targetPaths?: string[];
  summary?: string;
  resultJson?: string;
  cliTaskId?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowAgentRef {
  id: string;
  name: string;
  adapter: string;
  enabled: boolean;
}

export interface WorkflowValidationResult {
  ok: boolean;
  errors: string[];
}

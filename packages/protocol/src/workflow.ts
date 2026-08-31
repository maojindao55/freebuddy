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
  model?: string;
  configOptionOverrides?: Record<string, string>;
  skillIds?: string[];
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
  teamId?: string;
  teamSnapshotJson?: string;
  planVersion?: number;
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
  runtimeVersion?: string | null;
  runtimeApiVersion?: string | null;
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
  toolSessionId?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

function failureMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const message = value.trim();
    return message || undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : undefined;
}

/** Extract the original agent/provider failure from a persisted workflow step. */
export function workflowStepFailureReason(
  step: Pick<WorkflowStepRow, "status" | "resultJson">
): string | undefined {
  if (step.status !== "failed" || !step.resultJson) return undefined;
  try {
    const result = JSON.parse(step.resultJson) as {
      error?: unknown;
      items?: unknown[];
    };
    const direct = failureMessage(result.error);
    if (direct) return direct;
    if (!Array.isArray(result.items)) return undefined;
    for (let index = result.items.length - 1; index >= 0; index -= 1) {
      const item = result.items[index];
      if (!item || typeof item !== "object") continue;
      const candidate = item as { kind?: unknown; message?: unknown };
      if (candidate.kind !== "error") continue;
      const message = failureMessage(candidate.message);
      if (message) return message;
    }
  } catch {
    // Older or interrupted rows may not contain valid result JSON.
  }
  return undefined;
}

export interface WorkflowAgentRef {
  id: string;
  name: string;
  adapter: string;
  enabled: boolean;
  skillIds?: string[];
}

export interface WorkflowValidationResult {
  ok: boolean;
  errors: string[];
}

export type WorkflowTeamRoleKind =
  | "planner"
  | "researcher"
  | "reviewer"
  | "implementer"
  | "verifier"
  | "summarizer"
  | "custom";

export interface WorkflowTeamRole {
  id: string;
  label: string;
  kind: WorkflowTeamRoleKind;
  agentId: string;
  model?: string;
  modelOptionId?: string;
  required: boolean;
  canWrite: boolean;
  description?: string;
  skillIds?: string[];
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

export type WorkflowTemplateNodeMode =
  | "research"
  | "review"
  | "write"
  | "verify"
  | "summarize"
  | "approval";

export type WorkflowNodeContract =
  | "plan"
  | "approval"
  | "implement"
  | "review"
  | "verify"
  | "summarize"
  | "research"
  | "report"
  | "custom";

export interface WorkflowTemplateNodeGate {
  id: string;
  type: "manual_approval";
  placement: "before" | "after";
  label?: string;
  reason?: string;
  blocks?: string;
}

export interface WorkflowTemplateNode {
  id: string;
  title: string;
  roleId?: string;
  mode: WorkflowTemplateNodeMode;
  contract?: WorkflowNodeContract;
  gates?: WorkflowTemplateNodeGate[];
  promptTemplate?: string;
  targetPathTemplates?: string[];
  retry?: {
    maxAttempts: number;
    onFailure: "block" | "skip" | "continue";
  };
}

export type WorkflowEdgeCondition =
  | { type: "always" }
  | { type: "status"; nodeId: string; equals: "done" | "failed" | "skipped" }
  | { type: "summary_contains"; nodeId: string; text: string }
  | { type: "summary_regex"; nodeId: string; pattern: string }
  | { type: "approval"; approvalId: string; equals: "approved" | "rejected" };

export interface WorkflowTemplateEdge {
  id: string;
  from: string;
  to: string;
  activation?: "all" | "any";
  condition?: WorkflowEdgeCondition;
}

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

export interface WorkflowTeamPreview {
  teamId: string;
  teamName: string;
  goal: string;
  cwd?: string;
  roleSummary: Array<{
    roleId: string;
    roleLabel: string;
    kind: WorkflowTeamRoleKind;
    agentId: string;
    agentName: string;
  }>;
  routeSummary: Array<{
    nodeId: string;
    title: string;
    mode: WorkflowTemplateNodeMode;
    roleLabel?: string;
    agentName?: string;
  }>;
  writeNodeCount: number;
  approvalNodeCount: number;
  maxLoops: number;
  plan: WorkflowPlan;
}

export interface WorkflowTeamValidationResult {
  ok: boolean;
  errors: string[];
}

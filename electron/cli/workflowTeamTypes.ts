import type { WorkflowPlan, WorkflowStepMode } from "./workflowTypes.js";

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

export type WorkflowTemplateNodeMode =
  | "research"
  | "review"
  | "write"
  | "verify"
  | "summarize"
  | "approval";

export interface WorkflowTemplateNode {
  id: string;
  title: string;
  roleId?: string;
  mode: WorkflowTemplateNodeMode;
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

export type { WorkflowStepMode };

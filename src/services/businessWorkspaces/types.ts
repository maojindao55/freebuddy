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

export interface BusinessWorkspacePolicy {
  requireAssignmentApproval: true;
  requireCommitApproval: true;
  blockCommitOnVerificationFailure: boolean;
  requireCleanRepoBeforeRun: boolean;
  branchNameTemplate: string;
}

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

export interface BusinessVerificationResult {
  command: string;
  cwd: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  summary: string;
  startedAt?: string;
  endedAt?: string;
}

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

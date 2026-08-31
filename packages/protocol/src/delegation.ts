export interface DelegationRosterEntry {
  id: string;
  label: string;
  agentId: string;
  model?: string;
  modelOptionId?: string;
  capability: string;
  /** Instructions this role must follow whenever it executes a turn. */
  instructions?: string;
  canWrite: boolean;
  skillIds?: string[];
}

export interface DelegationPolicy {
  allowWrites: boolean;
  requireApprovalBeforeDelegateWrite: boolean;
  maxDepth: number;
  delegateTimeoutMs: number;
  maxConcurrentDelegates: number;
  stopOnDelegateFailure: boolean;
}

export interface DelegationTeam {
  id: string;
  name: string;
  description?: string;
  /** Instructions applied to every role on every turn in this team. */
  sharedInstructions?: string;
  icon?: string;
  enabled: boolean;
  source: "builtin" | "user";
  kind: "delegation";
  entryRoleId: string;
  roster: DelegationRosterEntry[];
  policy: DelegationPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationTeamValidationResult {
  ok: boolean;
  errors: string[];
}

const DELEGATION_ROLE_LIMIT = 16;

/** Structural policy invariants shared by every delegation-team write path. */
export function validateDelegationTeam(
  team: Pick<DelegationTeam, "name" | "entryRoleId" | "roster" | "policy">
): DelegationTeamValidationResult {
  const errors: string[] = [];
  if (typeof team.name !== "string" || !team.name.trim()) {
    errors.push("Team name is required.");
  }
  if (!Array.isArray(team.roster) || team.roster.length === 0) {
    errors.push("At least one team role is required.");
  } else if (team.roster.length > DELEGATION_ROLE_LIMIT) {
    errors.push(`A team can contain at most ${DELEGATION_ROLE_LIMIT} roles.`);
  }

  const roleIds = new Set<string>();
  for (const rawRole of Array.isArray(team.roster) ? team.roster : []) {
    if (!rawRole || typeof rawRole !== "object") {
      errors.push("Every team role must be an object.");
      continue;
    }
    const role = rawRole as DelegationRosterEntry;
    const id = typeof role.id === "string" ? role.id.trim() : "";
    const label = typeof role.label === "string" ? role.label.trim() : "";
    const agentId = typeof role.agentId === "string" ? role.agentId.trim() : "";
    const capability = typeof role.capability === "string" ? role.capability.trim() : "";
    if (!id || !label || !agentId || !capability) {
      errors.push("Every role requires id, label, agentId, and capability.");
      continue;
    }
    if (roleIds.has(id)) errors.push(`Duplicate role id: ${id}.`);
    roleIds.add(id);
    if (typeof role.canWrite !== "boolean") {
      errors.push(`Role ${id} must declare canWrite.`);
    }
    if (
      role.skillIds !== undefined &&
      (!Array.isArray(role.skillIds) ||
        role.skillIds.some((skillId) => typeof skillId !== "string"))
    ) {
      errors.push(`Role ${id} has invalid skillIds.`);
    }
  }

  const entryRoleId =
    typeof team.entryRoleId === "string" ? team.entryRoleId.trim() : "";
  if (!entryRoleId || !roleIds.has(entryRoleId)) {
    errors.push("entryRoleId must reference one of the configured role ids.");
  }

  const policy = team.policy;
  if (!policy || typeof policy !== "object") {
    errors.push("Delegation policy is required.");
  } else {
    if (typeof policy.allowWrites !== "boolean") {
      errors.push("policy.allowWrites must be a boolean.");
    }
    if (typeof policy.requireApprovalBeforeDelegateWrite !== "boolean") {
      errors.push("policy.requireApprovalBeforeDelegateWrite must be a boolean.");
    }
    if (typeof policy.stopOnDelegateFailure !== "boolean") {
      errors.push("policy.stopOnDelegateFailure must be a boolean.");
    }
    if (!Number.isInteger(policy.maxDepth) || policy.maxDepth < 1 || policy.maxDepth > 6) {
      errors.push("policy.maxDepth must be an integer between 1 and 6.");
    }
    if (
      !Number.isInteger(policy.delegateTimeoutMs) ||
      policy.delegateTimeoutMs < 1 ||
      policy.delegateTimeoutMs > 86_400_000
    ) {
      errors.push("policy.delegateTimeoutMs must be an integer between 1 and 86400000.");
    }
    if (
      !Number.isInteger(policy.maxConcurrentDelegates) ||
      policy.maxConcurrentDelegates < 1 ||
      policy.maxConcurrentDelegates > 8
    ) {
      errors.push("policy.maxConcurrentDelegates must be an integer between 1 and 8.");
    }
    if (
      policy.allowWrites === false &&
      (Array.isArray(team.roster) ? team.roster : []).some(
        (role) => role && typeof role === "object" && role.canWrite === true
      )
    ) {
      errors.push("Writable roles require policy.allowWrites to be true.");
    }
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/** Policy is the hard ceiling even when old/corrupt data marks a role writable. */
export function effectiveDelegationRoleCanWrite(
  policy: DelegationPolicy,
  role: Pick<DelegationRosterEntry, "canWrite">
): boolean {
  return policy.allowWrites === true && role.canWrite === true;
}

export type DelegationEventStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "cancelled";

export type DelegationVerdict = "pass" | "needs_changes" | "fail";

export interface DelegationArtifact {
  kind: "file" | "url" | "text";
  label: string;
  uri?: string;
}

/** Versioned terminal result contract; resultSummary remains as a v0 compatibility field. */
export interface DelegationResult {
  schemaVersion: 1;
  status: Exclude<DelegationEventStatus, "pending" | "running">;
  summary: string;
  exitCode: number | null;
  error: {
    code: "delegate_failed" | "delegate_timeout" | "delegate_cancelled";
    message: string;
    retryable: boolean;
  } | null;
  artifacts: DelegationArtifact[];
  verdict: DelegationVerdict | null;
  verdictSummary: string | null;
}

export interface DelegationEvent {
  id: string;
  runId: string;
  parentEventId: string | null;
  agentId: string;
  agentName: string;
  roleLabel: string;
  taskText: string;
  depth: number;
  status: DelegationEventStatus;
  resultSummary: string | null;
  result: DelegationResult | null;
  canWrite: boolean;
  acceptedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  verdict: DelegationVerdict | null;
  verdictSummary: string | null;
}

export interface DelegationRunRow {
  id: string;
  kind: "delegation";
  conversationId: string | null;
  name?: string;
  goal: string;
  status: string;
  cwd: string | null;
  teamId: string | null;
  teamSnapshotJson: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  runtimeVersion?: string | null;
  runtimeApiVersion?: string | null;
}

export type DelegationEventRow = DelegationEvent;

export type DelegationRunFinishedEvent = {
  runId: string;
  conversationId?: string;
  status: string;
  name: string;
};

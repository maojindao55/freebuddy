import type {
  DelegationPolicy,
  DelegationRosterEntry
} from "./delegationTeamTypes.js";
import { defaultDelegationPolicy } from "./delegationTeamTypes.js";

export interface ButlerDelegationAgent {
  id: string;
  enabled?: boolean;
}

export interface ButlerDelegationTeamInput {
  name: string;
  description?: string;
  sharedInstructions?: string;
  enabled: boolean;
  entryRoleId: string;
  roster: DelegationRosterEntry[];
  policy: DelegationPolicy;
}

export type ButlerDelegationTeamValidation =
  | { ok: true; input: ButlerDelegationTeamInput }
  | { ok: false; error: string };

const ROLE_LIMIT = 16;

function optionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function integerInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string
): number | string {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    return `${label} must be an integer between ${min} and ${max}.`;
  }
  return Number(value);
}

/**
 * Normalize the self-organizing-team payload exposed to ButlerBuddy.
 * Keep this validation independent from Electron/SQLite so the tool boundary
 * can be tested without granting a caller direct storage access.
 */
export function normalizeButlerDelegationTeamInput(
  params: Record<string, unknown>,
  agents: ButlerDelegationAgent[]
): ButlerDelegationTeamValidation {
  const name = optionalText(params.name);
  if (!name) return { ok: false, error: "Team name is required." };

  const rawRoster = params.roster;
  if (!Array.isArray(rawRoster) || rawRoster.length === 0) {
    return { ok: false, error: "At least one team role is required." };
  }
  if (rawRoster.length > ROLE_LIMIT) {
    return { ok: false, error: `A team can contain at most ${ROLE_LIMIT} roles.` };
  }

  const enabledAgents = new Set(
    agents.filter((agent) => agent.enabled !== false).map((agent) => agent.id)
  );
  const roleIds = new Set<string>();
  const roster: DelegationRosterEntry[] = [];

  for (const rawRole of rawRoster) {
    if (!rawRole || typeof rawRole !== "object" || Array.isArray(rawRole)) {
      return { ok: false, error: "Every team role must be an object." };
    }
    const role = rawRole as Record<string, unknown>;
    const id = optionalText(role.id);
    const label = optionalText(role.label);
    const agentId = optionalText(role.agentId);
    const capability = optionalText(role.capability);
    if (!id || !label || !agentId || !capability) {
      return {
        ok: false,
        error: "Every role requires id, label, agentId, and capability."
      };
    }
    if (roleIds.has(id)) {
      return { ok: false, error: `Duplicate role id: ${id}.` };
    }
    if (!enabledAgents.has(agentId)) {
      return {
        ok: false,
        error: `Role ${id} references an unavailable or disabled agent: ${agentId}.`
      };
    }
    if (typeof role.canWrite !== "boolean") {
      return { ok: false, error: `Role ${id} must declare canWrite.` };
    }
    if (
      role.skillIds !== undefined &&
      (!Array.isArray(role.skillIds) ||
        role.skillIds.some((skillId) => typeof skillId !== "string"))
    ) {
      return { ok: false, error: `Role ${id} has invalid skillIds.` };
    }

    const model = optionalText(role.model);
    const modelOptionId = optionalText(role.modelOptionId);
    const instructions = optionalText(role.instructions);
    roleIds.add(id);
    roster.push({
      id,
      label,
      agentId,
      ...(model ? { model } : {}),
      ...(modelOptionId ? { modelOptionId } : {}),
      capability,
      ...(instructions ? { instructions } : {}),
      canWrite: role.canWrite,
      skillIds: Array.from(
        new Set(
          (Array.isArray(role.skillIds) ? role.skillIds : [])
            .map((skillId) => String(skillId).trim())
            .filter(Boolean)
        )
      )
    });
  }

  const entryRoleId = optionalText(params.entryRoleId);
  if (!entryRoleId || !roleIds.has(entryRoleId)) {
    return {
      ok: false,
      error: "entryRoleId must reference one of the configured role ids."
    };
  }

  const rawPolicy =
    params.policy && typeof params.policy === "object" && !Array.isArray(params.policy)
      ? (params.policy as Record<string, unknown>)
      : {};
  const defaults = defaultDelegationPolicy();
  const maxDepth = integerInRange(
    rawPolicy.maxDepth,
    defaults.maxDepth,
    1,
    6,
    "policy.maxDepth"
  );
  if (typeof maxDepth === "string") return { ok: false, error: maxDepth };
  const timeoutMinutes = integerInRange(
    rawPolicy.delegateTimeoutMinutes,
    Math.round(defaults.delegateTimeoutMs / 60_000),
    1,
    1440,
    "policy.delegateTimeoutMinutes"
  );
  if (typeof timeoutMinutes === "string") {
    return { ok: false, error: timeoutMinutes };
  }
  const maxConcurrentDelegates = integerInRange(
    rawPolicy.maxConcurrentDelegates,
    defaults.maxConcurrentDelegates,
    1,
    8,
    "policy.maxConcurrentDelegates"
  );
  if (typeof maxConcurrentDelegates === "string") {
    return { ok: false, error: maxConcurrentDelegates };
  }

  const allowWrites =
    typeof rawPolicy.allowWrites === "boolean"
      ? rawPolicy.allowWrites
      : defaults.allowWrites;
  if (!allowWrites && roster.some((role) => role.canWrite)) {
    return {
      ok: false,
      error: "Writable roles require policy.allowWrites to be true."
    };
  }

  return {
    ok: true,
    input: {
      name,
      description: optionalText(params.description),
      sharedInstructions: optionalText(params.sharedInstructions),
      enabled: params.enabled !== false,
      entryRoleId,
      roster,
      policy: {
        allowWrites,
        requireApprovalBeforeDelegateWrite:
          typeof rawPolicy.requireApprovalBeforeDelegateWrite === "boolean"
            ? rawPolicy.requireApprovalBeforeDelegateWrite
            : defaults.requireApprovalBeforeDelegateWrite,
        maxDepth,
        delegateTimeoutMs: timeoutMinutes * 60_000,
        maxConcurrentDelegates,
        stopOnDelegateFailure:
          typeof rawPolicy.stopOnDelegateFailure === "boolean"
            ? rawPolicy.stopOnDelegateFailure
            : defaults.stopOnDelegateFailure
      }
    }
  };
}

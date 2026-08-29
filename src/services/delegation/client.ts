import type {
  DelegationTeam,
  DelegationRosterEntry,
  DelegationPolicy
} from "@/services/workflowTeams/types";
import type {
  DelegationEvent as DelegationEventRow,
  DelegationRunFinishedEvent,
  DelegationRunRow
} from "@freebuddy/protocol/delegation";

export type {
  DelegationEvent as DelegationEventRow,
  DelegationEventStatus,
  DelegationResult,
  DelegationRunFinishedEvent,
  DelegationRunRow
} from "@freebuddy/protocol/delegation";

export interface UpsertDelegationTeamInput {
  id: string;
  name: string;
  description?: string;
  sharedInstructions?: string;
  icon?: string;
  enabled: boolean;
  source: "builtin" | "user";
  entryRoleId: string;
  roster: DelegationRosterEntry[];
  policy: DelegationPolicy;
}

export interface UpdateDelegationTeamPatch {
  name?: string;
  description?: string | null;
  sharedInstructions?: string | null;
  icon?: string | null;
  enabled?: boolean;
  entryRoleId?: string;
  roster?: DelegationRosterEntry[];
  policy?: DelegationPolicy;
}

function api() {
  const delegation = window.freebuddy?.delegation;
  if (!delegation) throw new Error("delegation bridge unavailable");
  return delegation;
}

function wfApi() {
  const wf = window.freebuddy?.workflow;
  if (!wf) throw new Error("workflow bridge unavailable");
  return wf;
}

export const delegationClient = {
  isAvailable(): boolean {
    return Boolean(window.freebuddy?.delegation);
  },

  async list(): Promise<DelegationTeam[]> {
    if (!this.isAvailable()) return [];
    return api().listTeams();
  },

  async get(id: string): Promise<DelegationTeam | undefined> {
    if (!this.isAvailable()) return undefined;
    return api().getTeam(id);
  },

  async create(input: UpsertDelegationTeamInput): Promise<DelegationTeam> {
    return api().createTeam(input);
  },

  async update(
    id: string,
    patch: UpdateDelegationTeamPatch
  ): Promise<DelegationTeam | undefined> {
    return api().updateTeam(id, patch);
  },

  async delete(id: string): Promise<boolean> {
    return api().deleteTeam(id);
  },

  async createRun(input: {
    teamId: string;
    goal: string;
    cwd?: string;
    conversationId?: string;
  }): Promise<
    | { ok: true; runId: string; conversationId: string }
    | { ok: false; error: string }
  > {
    return wfApi().createDelegationRun(input);
  },

  async approveWrite(input: {
    runId: string;
    approvalId: string;
    approved: boolean;
  }): Promise<boolean> {
    return wfApi().approveDelegateWrite(input);
  },

  async getRun(id: string): Promise<unknown> {
    if (!this.isAvailable()) return undefined;
    return api().getRun(id);
  },

  async getRunByConversation(
    conversationId: string
  ): Promise<DelegationRunRow | undefined> {
    if (!this.isAvailable()) return undefined;
    return api().getRunByConversation(conversationId);
  },

  async listEvents(runId: string): Promise<DelegationEventRow[]> {
    if (!this.isAvailable()) return [];
    return api().listEvents(runId);
  },

  async listPendingApprovals(
    runId: string
  ): Promise<Array<{ approvalId: string; runId: string }>> {
    if (!this.isAvailable()) return [];
    return api().listPendingApprovals(runId);
  },

  async stopRun(runId: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return api().stopRun(runId);
  },

  async pauseRun(runId: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return api().pauseRun(runId);
  },

  async resumeRun(runId: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return api().resumeRun(runId);
  },

  async hasRunForConversation(conversationId: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return api().hasRunForConversation(conversationId);
  },

  async followUp(input: {
    conversationId: string;
    prompt: string;
  }): Promise<
    { ok: true; runId: string } | { ok: false; error: string; code?: string }
  > {
    return api().followUp(input);
  },

  onChanged(cb: () => void): (() => void) | undefined {
    return window.freebuddy?.delegation?.onChanged?.(cb);
  },

  onRunFinished(
    cb: (event: DelegationRunFinishedEvent) => void
  ): (() => void) | undefined {
    return window.freebuddy?.delegation?.onRunFinished?.(cb);
  }
};

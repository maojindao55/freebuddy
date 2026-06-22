import type {
  WorkflowTeam,
  WorkflowTeamPolicy,
  WorkflowTeamPreview,
  WorkflowTeamRole,
  WorkflowTemplate2
} from "./types";
import type { WorkflowRunRow } from "@/services/workflows/types";

function api() {
  const teams = window.freebuddy?.workflowTeams;
  if (!teams) throw new Error("workflowTeams bridge unavailable");
  return teams;
}

function wfApi() {
  const wf = window.freebuddy?.workflow;
  if (!wf) throw new Error("workflow bridge unavailable");
  return wf;
}

export const workflowTeamsClient = {
  isAvailable(): boolean {
    return Boolean(window.freebuddy?.workflowTeams);
  },

  list(): Promise<WorkflowTeam[]> {
    return api().list();
  },

  get(id: string): Promise<WorkflowTeam | undefined> {
    return api().get(id);
  },

  create(input: {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    enabled: boolean;
    roles: WorkflowTeamRole[];
    template: WorkflowTemplate2;
    policy: WorkflowTeamPolicy;
  }) {
    return api().create({ ...input, source: "user" });
  },

  update(args: {
    id: string;
    patch: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      enabled?: boolean;
      roles?: WorkflowTeamRole[];
      template?: WorkflowTemplate2;
      policy?: WorkflowTeamPolicy;
    };
  }) {
    return api().update(args);
  },

  delete(id: string): Promise<boolean> {
    return api().delete(id);
  },

  seedBuiltins(): Promise<WorkflowTeam[]> {
    return api().seedBuiltins();
  },

  previewTeamRun(input: {
    teamId: string;
    goal: string;
    cwd?: string;
    targetPaths?: string[];
  }): Promise<
    | { ok: true; preview: WorkflowTeamPreview }
    | { ok: false; errors: string[] }
  > {
    return wfApi().previewTeamRun(input);
  },

  createTeamRun(input: {
    teamId: string;
    conversationId?: string;
    goal: string;
    cwd?: string;
    targetPaths?: string[];
  }): Promise<
    | { ok: true; run: WorkflowRunRow }
    | { ok: false; errors: string[] }
  > {
    return wfApi().createTeamRun(input);
  }
};

import type {
  BusinessWorkspace,
  BusinessAssignmentPlan,
  BusinessContractDraft,
  BusinessRequirementRun
} from "./types";

function api() {
  const business = window.freebuddy?.businessWorkspaces;
  if (!business) throw new Error("businessWorkspaces bridge unavailable");
  return business;
}

export const businessWorkspacesClient = {
  isAvailable(): boolean {
    return Boolean(window.freebuddy?.businessWorkspaces);
  },
  list(): Promise<BusinessWorkspace[]> {
    return api().list();
  },
  get(id: string): Promise<BusinessWorkspace | undefined> {
    return api().get(id);
  },
  create(input: Omit<BusinessWorkspace, "createdAt" | "updatedAt">) {
    return api().create(input);
  },
  update(args: { id: string; patch: Partial<Omit<BusinessWorkspace, "id" | "createdAt" | "updatedAt">> }) {
    return api().update(args);
  },
  delete(id: string): Promise<boolean> {
    return api().delete(id);
  },
  previewAssignment(input: { workspaceId: string; goal: string }) {
    return api().previewAssignment(input);
  },
  createRun(input: {
    workspaceId: string;
    workspaceSnapshot: BusinessWorkspace;
    teamId?: string;
    goal: string;
    assignmentPlan: BusinessAssignmentPlan;
    contractDraft?: BusinessContractDraft;
  }) {
    return api().createRun(input);
  },
  startRun(runId: string) {
    return api().startRun(runId);
  },
  getRun(runId: string): Promise<BusinessRequirementRun | undefined> {
    return api().getRun(runId);
  }
};

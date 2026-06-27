import { create } from "zustand";
import { businessWorkspacesClient } from "@/services/businessWorkspaces/client";
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft,
  BusinessRequirementRun,
  BusinessWorkspace
} from "@/services/businessWorkspaces/types";

interface State {
  pendingAssignmentPlan: BusinessAssignmentPlan | null;
  pendingContractDraft: BusinessContractDraft | null;
  pendingErrors: string[];
  activeRun: BusinessRequirementRun | null;
  previewAssignment(input: { workspaceId: string; goal: string }): Promise<void>;
  clearPreview(): void;
  approveAndStart(input: {
    workspaceId: string;
    workspaceSnapshot: BusinessWorkspace;
    teamId?: string;
    goal: string;
    assignmentPlan: BusinessAssignmentPlan;
    contractDraft?: BusinessContractDraft;
  }): Promise<boolean>;
  refreshActiveRun(runId: string): Promise<void>;
  clearActiveRun(): void;
}

export const useBusinessRequirementRunStore = create<State>((set) => ({
  pendingAssignmentPlan: null,
  pendingContractDraft: null,
  pendingErrors: [],
  activeRun: null,
  async previewAssignment(input) {
    const res = await businessWorkspacesClient.previewAssignment(input);
    if (res.ok) {
      set({
        pendingAssignmentPlan: res.assignmentPlan,
        pendingContractDraft: res.contractDraft ?? null,
        pendingErrors: []
      });
    } else {
      set({
        pendingAssignmentPlan: null,
        pendingContractDraft: null,
        pendingErrors: res.errors
      });
    }
  },
  clearPreview() {
    set({ pendingAssignmentPlan: null, pendingContractDraft: null, pendingErrors: [] });
  },
  async approveAndStart(input) {
    const createRes = await businessWorkspacesClient.createRun(input);
    if (!createRes.ok) {
      set({ pendingErrors: createRes.errors });
      return false;
    }
    set({
      activeRun: createRes.run,
      pendingAssignmentPlan: null,
      pendingContractDraft: null
    });
    const startRes = await businessWorkspacesClient.startRun(createRes.run.id);
    if (!startRes.ok) {
      set({ pendingErrors: startRes.errors });
      return false;
    }
    set({ activeRun: startRes.run });
    return true;
  },
  async refreshActiveRun(runId) {
    const run = await businessWorkspacesClient.getRun(runId);
    if (run) set({ activeRun: run });
  },
  clearActiveRun() {
    set({ activeRun: null });
  }
}));

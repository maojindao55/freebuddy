import { create } from "zustand";
import { businessWorkspacesClient } from "@/services/businessWorkspaces/client";
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft
} from "@/services/businessWorkspaces/types";

interface State {
  pendingAssignmentPlan: BusinessAssignmentPlan | null;
  pendingContractDraft: BusinessContractDraft | null;
  pendingErrors: string[];
  previewAssignment(input: { workspaceId: string; goal: string }): Promise<void>;
  clearPreview(): void;
}

export const useBusinessRequirementRunStore = create<State>((set) => ({
  pendingAssignmentPlan: null,
  pendingContractDraft: null,
  pendingErrors: [],
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
  }
}));

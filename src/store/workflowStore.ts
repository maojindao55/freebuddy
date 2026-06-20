import { create } from "zustand";

import { workflowClient } from "@/services/workflows/client";
import type {
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowStepRow,
  WorkflowValidationResult
} from "@/services/workflows/types";

interface State {
  pendingPlan: WorkflowPlan | null;
  pendingErrors: string[];
  activeRun: WorkflowRunRow | null;
  steps: WorkflowStepRow[];
  loadedConversations: Set<string>;

  loadForConversation(conversationId: string): Promise<void>;
  previewReviewLoop(input: {
    goal: string;
    cwd?: string;
    targetPaths?: string[];
  }): Promise<void>;
  clearPending(): void;
  createAndStart(input: {
    conversationId?: string;
    plan: WorkflowPlan;
  }): Promise<boolean>;
  refresh(runId: string): Promise<void>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  retryStep(runId: string, stepRowId: string): Promise<void>;
  approveGate(runId: string, phaseId: string): Promise<void>;
  validate(plan: WorkflowPlan): Promise<WorkflowValidationResult>;
}

export const useWorkflowStore = create<State>((set, get) => ({
  pendingPlan: null,
  pendingErrors: [],
  activeRun: null,
  steps: [],
  loadedConversations: new Set(),

  async loadForConversation(conversationId) {
    if (!workflowClient.isAvailable()) return;
    const runs = await workflowClient.listRuns(conversationId);
    const latestRunning = runs.find((r) =>
      ["running", "paused", "blocked", "pending_approval"].includes(r.status)
    );
    if (latestRunning) {
      const steps = await workflowClient.getSteps(latestRunning.id);
      set({
        activeRun: latestRunning,
        steps,
        loadedConversations: new Set([conversationId])
      });
    } else {
      set({
        activeRun: null,
        steps: [],
        loadedConversations: new Set([conversationId])
      });
    }
  },

  async previewReviewLoop(input) {
    if (!workflowClient.isAvailable()) return;
    const res = await workflowClient.previewReviewLoop(input);
    if (res.ok) {
      set({ pendingPlan: res.plan, pendingErrors: [] });
    } else {
      set({ pendingErrors: res.errors });
    }
  },

  clearPending() {
    set({ pendingPlan: null, pendingErrors: [] });
  },

  async createAndStart(input) {
    if (!workflowClient.isAvailable()) return false;
    const res = await workflowClient.createRun(input);
    if (!res.ok) {
      set({ pendingErrors: res.errors });
      return false;
    }
    set({ pendingPlan: null, pendingErrors: [], activeRun: res.run, steps: [] });
    await workflowClient.start(res.run.id);
    await get().refresh(res.run.id);
    return true;
  },

  async refresh(runId) {
    if (!workflowClient.isAvailable()) return;
    const [run, steps] = await Promise.all([
      workflowClient.getRun(runId),
      workflowClient.getSteps(runId)
    ]);
    if (run) set({ activeRun: run, steps });
  },

  async pause(runId) {
    await workflowClient.pause(runId);
    await get().refresh(runId);
  },
  async resume(runId) {
    await workflowClient.resume(runId);
    await get().refresh(runId);
  },
  async stop(runId) {
    await workflowClient.stop(runId);
    await get().refresh(runId);
  },
  async retryStep(runId, stepRowId) {
    await workflowClient.retryStep({ runId, stepRowId });
    await get().refresh(runId);
  },
  async approveGate(runId, phaseId) {
    await workflowClient.approveGate({ runId, phaseId });
    await get().refresh(runId);
  },
  async validate(plan) {
    return workflowClient.validate(plan);
  }
}));

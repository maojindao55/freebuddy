import { create } from "zustand";

import { workflowClient } from "@/services/workflows/client";
import { workflowTeamsClient } from "@/services/workflowTeams/client";
import { useConversationStore } from "@/store/conversationStore";
import type {
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowStepRow,
  WorkflowValidationResult
} from "@/services/workflows/types";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface State {
  pendingPlan: WorkflowPlan | null;
  pendingErrors: string[];
  activeRun: WorkflowRunRow | null;
  activeRuns: WorkflowRunRow[];
  steps: WorkflowStepRow[];

  loadForConversation(conversationId: string): Promise<void>;
  loadActiveRuns(): Promise<void>;
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
  createAndStartTeam(input: {
    teamId: string;
    conversationId?: string;
    goal: string;
    cwd?: string;
    targetPaths?: string[];
  }): Promise<boolean>;
  refresh(runId: string): Promise<void>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  retryStep(runId: string, stepRowId: string): Promise<void>;
  approveGate(runId: string, phaseId: string): Promise<boolean>;
  requestGateChanges(
    runId: string,
    phaseId: string,
    feedback: string
  ): Promise<boolean>;
  continueImplementReview(runId: string): Promise<void>;
  validate(plan: WorkflowPlan): Promise<WorkflowValidationResult>;
}

export const useWorkflowStore = create<State>((set, get) => ({
  pendingPlan: null,
  pendingErrors: [],
  activeRun: null,
  activeRuns: [],
  steps: [],

  async loadForConversation(conversationId) {
    if (!workflowClient.isAvailable()) return;
    const runs = await workflowClient.listRuns(conversationId);
    const latest =
      runs.find((r) =>
        ["running", "paused", "blocked", "pending_approval"].includes(r.status)
      ) ?? runs[0];
    if (latest) {
      const steps = await workflowClient.getSteps(latest.id);
      set({
        activeRun: latest,
        steps
      });
    } else {
      set({
        activeRun: null,
        steps: []
      });
    }
    void get().loadActiveRuns();
  },

  async loadActiveRuns() {
    if (!workflowClient.isAvailable()) return;
    const activeRuns = await workflowClient.listActiveRuns();
    set({ activeRuns });
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
    await get().loadActiveRuns();
    await workflowClient.start(res.run.id);
    await get().refresh(res.run.id);
    return true;
  },

  async createAndStartTeam(input) {
    if (!workflowTeamsClient.isAvailable()) return false;
    const res = await workflowTeamsClient.createTeamRun(input);
    if (!res.ok) {
      set({ pendingErrors: res.errors });
      return false;
    }
    set({ pendingPlan: null, pendingErrors: [], activeRun: res.run, steps: [] });
    await get().loadActiveRuns();
    await workflowClient.start(res.run.id);
    await get().refresh(res.run.id);
    return true;
  },

  async refresh(runId) {
    if (!workflowClient.isAvailable()) return;
    const previousRun = get().activeRun?.id === runId ? get().activeRun : undefined;
    const [run, steps] = await Promise.all([
      workflowClient.getRun(runId),
      workflowClient.getSteps(runId)
    ]);
    if (run) {
      set({ activeRun: run, steps });
      const wasLive =
        previousRun &&
        ["running", "paused", "blocked", "pending_approval"].includes(previousRun.status);
      const isFinished = ["completed", "partial", "failed", "killed"].includes(run.status);
      if (wasLive && isFinished && run.conversationId) {
        useConversationStore.getState().markConversationUnread(run.conversationId);
      }
    }
    void get().loadActiveRuns();
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
    const ok = await workflowClient.approveGate({ runId, phaseId });
    await get().refresh(runId);
    if (!ok) return false;

    for (let i = 0; i < 6; i += 1) {
      await delay(250);
      await get().refresh(runId);
      const { activeRun, steps } = get();
      if (activeRun?.id !== runId) break;
      const phaseSteps = steps.filter((step) => step.phaseId === phaseId);
      if (
        activeRun.status !== "paused" ||
        phaseSteps.some((step) => step.status !== "pending")
      ) {
        break;
      }
    }
    return true;
  },
  async requestGateChanges(runId, phaseId, feedback) {
    const ok = await workflowClient.requestGateChanges({
      runId,
      phaseId,
      feedback
    });
    await get().refresh(runId);
    return ok;
  },
  async continueImplementReview(runId) {
    await workflowClient.continueImplementReview(runId);
    await get().refresh(runId);
  },
  async validate(plan) {
    return workflowClient.validate(plan);
  }
}));

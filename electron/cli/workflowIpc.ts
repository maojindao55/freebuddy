import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from "electron";

import { builtinCliMembers } from "./members.js";
import {
  buildReviewLoopPlan,
  reviewLoopCoordinatorPrompt
} from "./workflowTemplates.js";
import { createCliStepExecutor, WorkflowRuntime } from "./workflowRuntime.js";
import {
  getWorkflowRun,
  getWorkflowSteps,
  listWorkflowRunsByConversation
} from "./workflows.js";
import type {
  WorkflowAgentRef,
  WorkflowPlan
} from "./workflowTypes.js";
import { validateWorkflowPlan } from "./workflowValidate.js";

let runtime: WorkflowRuntime | null = null;

function ensureRuntime(event: IpcMainInvokeEvent): WorkflowRuntime {
  if (runtime) return runtime;
  const win = BrowserWindow.fromWebContents(event.sender);
  const executor = createCliStepExecutor(win?.webContents);
  runtime = new WorkflowRuntime({
    executor,
    webContents: win?.webContents,
    resolveAgent(agentId) {
      const member = builtinCliMembers.find((m) => m.id === agentId);
      if (!member) return undefined;
      return {
        adapter: member.cli.adapter,
        agentName: member.name,
        binary: member.cli.binary,
        extraArgs: member.cli.extraArgs
      };
    }
  });
  return runtime;
}

export function registerWorkflowIpc() {
  ipcMain.handle("workflow:validate", (_e, plan: WorkflowPlan) =>
    validateWorkflowPlan(plan, workflowAgents())
  );

  ipcMain.handle(
    "workflow:previewReviewLoop",
    (_e, input: { goal: string; cwd?: string; targetPaths?: string[] }) => {
      const agents = workflowAgents();
      const reviewer = agents[0];
      const implementer = agents[1 % agents.length];
      const verifier = agents[2 % agents.length];
      if (!reviewer || !implementer || !verifier) {
        return { ok: false as const, errors: ["not enough enabled agents"] };
      }
      const plan = buildReviewLoopPlan({
        goal: input.goal,
        cwd: input.cwd,
        targetPaths: input.targetPaths,
        reviewer,
        implementer,
        verifier
      });
      const validation = validateWorkflowPlan(plan, agents);
      if (!validation.ok) return { ok: false as const, errors: validation.errors };
      return { ok: true as const, plan };
    }
  );

  ipcMain.handle(
    "workflow:coordinatorPrompt",
    (_e, input: { goal: string; cwd?: string; targetPaths?: string[] }) =>
      reviewLoopCoordinatorPrompt({
        goal: input.goal,
        cwd: input.cwd,
        agents: workflowAgents(),
        targetPaths: input.targetPaths
      })
  );

  ipcMain.handle(
    "workflow:createRun",
    (event, input: { conversationId?: string; plan: WorkflowPlan }) => {
      const rt = ensureRuntime(event);
      return rt.createPendingRun({
        conversationId: input.conversationId,
        plan: input.plan,
        agents: workflowAgents()
      });
    }
  );

  ipcMain.handle("workflow:start", (event, runId: string) => {
    void ensureRuntime(event).start(runId);
    return true;
  });
  ipcMain.handle("workflow:pause", (event, runId: string) => {
    ensureRuntime(event).pause(runId);
    return true;
  });
  ipcMain.handle("workflow:resume", (event, runId: string) =>
    ensureRuntime(event).resume(runId)
  );
  ipcMain.handle("workflow:stop", (event, runId: string) => {
    ensureRuntime(event).stop(runId);
    return true;
  });
  ipcMain.handle(
    "workflow:retryStep",
    (event, args: { runId: string; stepRowId: string }) =>
      ensureRuntime(event).retryStep(args.runId, args.stepRowId)
  );
  ipcMain.handle(
    "workflow:approveGate",
    (event, args: { runId: string; phaseId: string }) => {
      ensureRuntime(event).approveGate(args.runId, args.phaseId);
      return true;
    }
  );

  ipcMain.handle("workflow:getRun", (_e, runId: string) => getWorkflowRun(runId));
  ipcMain.handle("workflow:getSteps", (_e, runId: string) =>
    getWorkflowSteps(runId)
  );
  ipcMain.handle(
    "workflow:listRuns",
    (_e, conversationId: string) =>
      listWorkflowRunsByConversation(conversationId)
  );
}

function workflowAgents(): WorkflowAgentRef[] {
  return builtinCliMembers.map((m) => ({
    id: m.id,
    name: m.name,
    adapter: m.cli.adapter,
    enabled: m.enabled !== false
  }));
}

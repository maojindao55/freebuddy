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
  listActiveWorkflowRuns,
  listWorkflowRunsByConversation,
  recoverInterruptedWorkflowRuns
} from "./workflows.js";
import type {
  WorkflowAgentRef,
  WorkflowPlan
} from "./workflowTypes.js";
import { validateWorkflowPlan } from "./workflowValidate.js";
import {
  deleteWorkflowTeam,
  getWorkflowTeam,
  insertWorkflowTeam,
  listWorkflowTeams,
  updateWorkflowTeam,
  seedBuiltinWorkflowTeams,
  type UpsertWorkflowTeamInput,
  type UpdateWorkflowTeamPatch
} from "./workflowTeams.js";
import { validateWorkflowTeam } from "./workflowTeamValidate.js";
import { expandTeamToPlan } from "./workflowTeamAdapter.js";
import type { WorkflowTeam } from "./workflowTeamTypes.js";

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
  recoverInterruptedWorkflowRuns();

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
  ipcMain.handle("workflow:resume", (event, runId: string) => {
    void ensureRuntime(event).resume(runId);
    return true;
  });
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
    (event, args: { runId: string; phaseId: string }) =>
      ensureRuntime(event).approveGate(args.runId, args.phaseId)
  );
  ipcMain.handle(
    "workflow:requestGateChanges",
    (event, args: { runId: string; phaseId: string; feedback: string }) =>
      ensureRuntime(event).requestGateChanges(
        args.runId,
        args.phaseId,
        args.feedback
      )
  );
  ipcMain.handle("workflow:continueImplementReview", (event, runId: string) =>
    ensureRuntime(event).continueImplementReview(runId)
  );

  ipcMain.handle("workflow:getRun", (_e, runId: string) => getWorkflowRun(runId));
  ipcMain.handle("workflow:listActiveRuns", () => listActiveWorkflowRuns());
  ipcMain.handle("workflow:getSteps", (_e, runId: string) =>
    getWorkflowSteps(runId)
  );
  ipcMain.handle(
    "workflow:listRuns",
    (_e, conversationId: string) =>
      listWorkflowRunsByConversation(conversationId)
  );

  ipcMain.handle("workflowTeams:list", () => listWorkflowTeams());
  ipcMain.handle("workflowTeams:get", (_e, id: string) => getWorkflowTeam(id));
  ipcMain.handle(
    "workflowTeams:create",
    (_e, input: UpsertWorkflowTeamInput) => {
      const validation = validateWorkflowTeam(
        { ...input, createdAt: "", updatedAt: "" } as WorkflowTeam,
        workflowAgents()
      );
      if (!validation.ok) return { ok: false as const, errors: validation.errors };
      const team = insertWorkflowTeam({ ...input, source: "user" });
      return { ok: true as const, team };
    }
  );
  ipcMain.handle(
    "workflowTeams:update",
    (_e, args: { id: string; patch: UpdateWorkflowTeamPatch }) => {
      const existing = getWorkflowTeam(args.id);
      if (!existing) return { ok: false as const, errors: ["team not found"] };
      const merged: WorkflowTeam = {
        ...existing,
        ...args.patch,
        roles: args.patch.roles ?? existing.roles,
        template: args.patch.template ?? existing.template,
        policy: args.patch.policy ?? existing.policy,
        description:
          args.patch.description === null
            ? undefined
            : args.patch.description ?? existing.description,
        icon: args.patch.icon === null ? undefined : args.patch.icon ?? existing.icon
      };
      const validation = validateWorkflowTeam(merged, workflowAgents());
      if (!validation.ok) return { ok: false as const, errors: validation.errors };
      const team = updateWorkflowTeam(args.id, args.patch);
      return team
        ? { ok: true as const, team }
        : { ok: false as const, errors: ["team not found"] };
    }
  );
  ipcMain.handle(
    "workflowTeams:delete",
    (_e, id: string) => deleteWorkflowTeam(id)
  );
  ipcMain.handle("workflowTeams:seedBuiltins", () => {
    seedBuiltinWorkflowTeams();
    return listWorkflowTeams();
  });

  ipcMain.handle(
    "workflow:previewTeamRun",
    (
      _e,
      input: {
        teamId: string;
        goal: string;
        cwd?: string;
        targetPaths?: string[];
      }
    ) => {
      const team = getWorkflowTeam(input.teamId);
      if (!team) return { ok: false as const, errors: ["team not found"] };
      const agents = workflowAgents();
      const teamValidation = validateWorkflowTeam(team, agents);
      if (!teamValidation.ok) {
        return { ok: false as const, errors: teamValidation.errors };
      }
      const result = expandTeamToPlan(
        team,
        { goal: input.goal, cwd: input.cwd, targetPaths: input.targetPaths },
        agents
      );
      if (!result.ok || !result.preview) {
        return { ok: false as const, errors: result.errors ?? ["expansion failed"] };
      }
      const planValidation = validateWorkflowPlan(result.preview.plan, agents);
      if (!planValidation.ok) {
        return { ok: false as const, errors: planValidation.errors };
      }
      return { ok: true as const, preview: result.preview };
    }
  );

  ipcMain.handle(
    "workflow:createTeamRun",
    (
      event,
      input: {
        teamId: string;
        conversationId?: string;
        goal: string;
        cwd?: string;
        targetPaths?: string[];
      }
    ) => {
      const team = getWorkflowTeam(input.teamId);
      if (!team) return { ok: false as const, errors: ["team not found"] };
      const agents = workflowAgents();
      const result = expandTeamToPlan(
        team,
        { goal: input.goal, cwd: input.cwd, targetPaths: input.targetPaths },
        agents
      );
      if (!result.ok || !result.preview) {
        return { ok: false as const, errors: result.errors ?? ["expansion failed"] };
      }
      const rt = ensureRuntime(event);
      return rt.createPendingRun({
        conversationId: input.conversationId,
        teamId: team.id,
        teamSnapshotJson: JSON.stringify(team),
        planVersion: team.template.version,
        plan: result.preview.plan,
        agents
      });
    }
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

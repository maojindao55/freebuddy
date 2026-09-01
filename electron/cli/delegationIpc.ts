import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { registerHandler } from "../invokeRegistry.js";
import { listCliMembers } from "./members.js";
import {
  appendMessage,
  createConversation,
  notifyConversationsChanged,
  requireOwnedConversation
} from "./conversations.js";
import { getDelegationTeam } from "./delegationTeams.js";
import {
  DelegationRuntime,
  recoverInterruptedDelegationRuns
} from "./delegationRuntime.js";
import { callerCanAccessDelegationRun } from "./delegationRuns.js";
import { createDelegateAgentRunner } from "./delegationRunner.js";
import {
  conversationHasDelegationRun,
  handleDelegationFollowUp
} from "./delegation/adapter/ipcFollowUp.js";
import {
  createDelegationRuntimeHandle,
  shouldUseDelegationRuntimeProcess
} from "../runtime/delegationRuntimeClient.js";
import {
  listHostPendingApprovals,
  resolveHostWriteApproval
} from "../runtime/runtimeHostApi.js";

let runtime: DelegationRuntime | null = null;

export function ensureDelegationRuntime(event: IpcMainInvokeEvent): DelegationRuntime {
  if (runtime) return runtime;
  const win = BrowserWindow.fromWebContents(event.sender);
  runtime = new DelegationRuntime({
    webContents: win?.webContents,
    resolveAgent(agentId) {
      const member = listCliMembers().find((m) => m.id === agentId);
      if (!member) return undefined;
      return {
        adapter: member.cli.adapter,
        agentName: member.name,
        binary: member.cli.binary,
        extraArgs: member.cli.extraArgs,
        env: member.cli.env,
        skillIds: member.cli.skillIds
      };
    },
    runAgent: createDelegateAgentRunner(win?.webContents)
  });
  return runtime;
}

export function registerDelegationIpc(): void {
  recoverInterruptedDelegationRuns();

  registerHandler(
    "workflow:createDelegationRun",
    async (
      event,
      input: { teamId: string; goal: string; cwd?: string; conversationId?: string }
    ) => {
      const team = getDelegationTeam(input.teamId);
      if (!team) return { ok: false as const, error: "team not found" };
      const entry =
        team.roster.find((r) => r.id === team.entryRoleId) ?? team.roster[0];
      if (!entry) {
        return { ok: false as const, error: "team has no entry role" };
      }
      const member = listCliMembers().find((m) => m.id === entry.agentId);
      const agentName = member?.name ?? entry.label;
      const adapter = member?.cli.adapter ?? "claude";

      const conversationId = randomUUID();
      const title =
        input.goal.length > 100
          ? `${input.goal.slice(0, 97)}…`
          : input.goal;
      createConversation({
        id: conversationId,
        title,
        titleSource: "prompt",
        agentId: entry.agentId,
        agentName,
        adapter,
        cwd: input.cwd,
        approvalMode: "auto"
      });
      appendMessage({
        id: randomUUID(),
        conversationId,
        role: "user",
        status: "done",
        content: input.goal,
        agentId: entry.agentId,
        agentName,
        adapter
      });
      notifyConversationsChanged();

      const rt = createDelegationRuntimeHandle(event, () => ensureDelegationRuntime(event));
      const runId = await rt.prepareRun({
        goal: input.goal,
        teamId: input.teamId,
        teamSnapshot: {
          roster: team.roster,
          sharedInstructions: team.sharedInstructions,
          policy: team.policy,
          entryRoleId: team.entryRoleId
        },
        cwd: input.cwd,
        conversationId
      });
      void rt.runEntry(runId, input.goal);
      return { ok: true as const, runId, conversationId };
    }
  );

  registerHandler(
    "workflow:approveDelegateWrite",
    (event, args: { runId: string; approvalId: string; approved: boolean }) => {
      if (!callerCanAccessDelegationRun(args.runId)) return false;
      if (shouldUseDelegationRuntimeProcess()) {
        return resolveHostWriteApproval(args.approvalId, args.approved);
      }
      const rt = ensureDelegationRuntime(event);
      const ownsApproval = rt
        .listPendingApprovals()
        .some((approval) =>
          approval.runId === args.runId && approval.approvalId === args.approvalId
        );
      if (!ownsApproval) return false;
      rt.resolveWriteApproval(
        args.approvalId,
        args.approved
      );
      return true;
    }
  );

  registerHandler(
    "delegation:listPendingApprovals",
    (event, runId: string) => {
      if (!callerCanAccessDelegationRun(runId)) return [];
      if (shouldUseDelegationRuntimeProcess()) {
        return listHostPendingApprovals(runId);
      }
      return ensureDelegationRuntime(event)
        .listPendingApprovals()
        .filter((p) => p.runId === runId);
    }
  );

  registerHandler(
    "delegation:stopRun",
    (event, runId: string) => {
      if (!callerCanAccessDelegationRun(runId)) return false;
      createDelegationRuntimeHandle(event, () => ensureDelegationRuntime(event)).stopRun(runId);
      return true;
    }
  );

  registerHandler(
    "delegation:pauseRun",
    async (event, runId: string) => {
      if (!callerCanAccessDelegationRun(runId)) return false;
      return createDelegationRuntimeHandle(event, () => ensureDelegationRuntime(event)).pauseRun(
        runId
      );
    }
  );

  registerHandler(
    "delegation:resumeRun",
    async (event, runId: string) => {
      if (!callerCanAccessDelegationRun(runId)) return false;
      const ok = await createDelegationRuntimeHandle(event, () =>
        ensureDelegationRuntime(event)
      ).resumeRun(runId);
      return ok;
    }
  );

  registerHandler(
    "delegation:hasRunForConversation",
    (_event, conversationId: string) =>
      Boolean(requireOwnedConversation(conversationId)) &&
      conversationHasDelegationRun(conversationId)
  );

  registerHandler(
    "delegation:followUp",
    async (
      event,
      input: { conversationId: string; prompt: string }
    ) => {
      if (!requireOwnedConversation(input.conversationId)) {
        return { ok: false as const, error: "conversation_not_found" };
      }
      const rt = createDelegationRuntimeHandle(event, () => ensureDelegationRuntime(event));
      return handleDelegationFollowUp(rt, input);
    }
  );
}

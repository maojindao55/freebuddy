import { BrowserWindow, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { RuntimeHostApi, RuntimeHostInvokeMeta } from "@freebuddy/runtime-host";
import { createHostIdempotency, publicAgentProfile, trustedAgentExecution } from "@freebuddy/runtime-host";
import { getHostIdempotencyResult, putHostIdempotencyResult } from "@freebuddy/storage-sqlite";
import { sqliteContext } from "../cli/sqliteContext.js";
import { runAsCaller } from "../cli/callerContext.js";
import { getOwnerUser } from "../cli/users.js";
import { listCliMembers } from "../cli/members.js";
import {
  appendMessage,
  listMessages,
  requireOwnedConversation,
  updateMessage
} from "../cli/conversations.js";
import { applyAgentLanguagePreference } from "../cli/agentLanguage.js";
import { getLanguage } from "../cli/settings.js";
import { getToolSession } from "../cli/store.js";
import { cliKill } from "../cli/runtime.js";
import { trackTelemetryEvent } from "../telemetry.js";
import { safeSendToWebContents } from "../cli/ipcSend.js";
import {
  createWorkflowRun,
  createWorkflowStep,
  getWorkflowRun,
  getWorkflowSteps,
  resetWorkflowStepsForLoop,
  updateWorkflowRun,
  updateWorkflowStep
} from "../cli/workflows.js";
import { createCliStepExecutor } from "./adapters.js";
import { electronDelegationRepository } from "./adapters/delegationRepository.js";
import { getDelegationTeam } from "../cli/delegationTeams.js";
import { resolveSkillSnapshots } from "../cli/skills.js";

let executionWebContents: WebContents | undefined;
const pendingWriteApprovals = new Map<
  string,
  { runId: string; resolve: (approved: boolean) => void }
>();
const hostIdempotency = createHostIdempotency({
  get(key) {
    try {
      return getHostIdempotencyResult(sqliteContext(), key);
    } catch {
      return { found: false };
    }
  },
  put(key, value) {
    try {
      putHostIdempotencyResult(sqliteContext(), key, value);
    } catch {
      /* persistence is best-effort */
    }
  }
});

export function setRuntimeExecutionWebContents(webContents: WebContents | undefined): void {
  executionWebContents = webContents;
}

function activeWebContents(): WebContents | undefined {
  if (executionWebContents && !executionWebContents.isDestroyed()) return executionWebContents;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.webContents.isDestroyed()) return focused.webContents;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) return win.webContents;
  }
  return undefined;
}

function argsOf(params: unknown): unknown[] {
  return Array.isArray(params) ? params : [params];
}

function workflowRepository(op: string, args: unknown[], meta?: RuntimeHostInvokeMeta) {
  switch (op) {
    case "createRun": {
      const input = { ...(args[0] as Record<string, unknown>) };
      if (input.runtimeVersion == null) {
        input.runtimeVersion = meta?.runtimeVersion ?? "bundled";
      }
      if (input.runtimeApiVersion == null) input.runtimeApiVersion = "1.0.0";
      return createWorkflowRun(input as never);
    }
    case "getRun":
      return getWorkflowRun(String(args[0])) ?? null;
    case "updateRun":
      updateWorkflowRun(String(args[0]), args[1] as never);
      return true;
    case "createStep":
      createWorkflowStep(args[0] as never);
      return true;
    case "getSteps":
      return getWorkflowSteps(String(args[0]));
    case "updateStep":
      updateWorkflowStep(String(args[0]), args[1] as never);
      return true;
    case "resetStepsForLoop":
      resetWorkflowStepsForLoop(String(args[0]), args[1] as string[]);
      return true;
    default:
      throw new Error(`unknown workflow repository method: ${op}`);
  }
}

function delegationRepository(op: string, args: unknown[]) {
  const repo = electronDelegationRepository() as unknown as Record<
    string,
    (...params: unknown[]) => unknown
  >;
  const fn = repo[op];
  if (typeof fn !== "function") throw new Error(`unknown delegation repository method: ${op}`);
  return fn(...args);
}

export function listHostPendingApprovals(runId: string): Array<{ approvalId: string; runId: string }> {
  return [...pendingWriteApprovals.entries()]
    .filter(([, pending]) => pending.runId === runId)
    .map(([approvalId, pending]) => ({ approvalId, runId: pending.runId }));
}

export function resolveHostWriteApproval(approvalId: string, approved: boolean): boolean {
  const pending = pendingWriteApprovals.get(approvalId);
  if (!pending) return false;
  pendingWriteApprovals.delete(approvalId);
  pending.resolve(approved);
  return true;
}

export function createDesktopRuntimeHostApi(): RuntimeHostApi {
  return {
    async invoke(method, params, meta) {
      const args = argsOf(params);
      const run = () =>
        hostIdempotency.run(meta?.idempotencyKey, () => dispatchHostInvoke(method, args, meta));
      const owner = getOwnerUser()?.id ?? null;
      return owner ? runAsCaller(owner, run, true) : run();
    }
  };
}

async function dispatchHostInvoke(
  method: string,
  args: unknown[],
  meta?: RuntimeHostInvokeMeta
): Promise<unknown> {
  if (method.startsWith("workflow.repository.v1.")) {
    return workflowRepository(method.slice("workflow.repository.v1.".length), args, meta);
  }
  if (method.startsWith("delegation.repository.v1.")) {
    return delegationRepository(method.slice("delegation.repository.v1.".length), args);
  }
  switch (method) {
        case "agent.list.v1":
          return listCliMembers().map((member) =>
            publicAgentProfile({
              id: member.id,
              adapter: member.cli.adapter,
              agentName: member.name,
              skillIds: member.cli.skillIds
            })
          );
        case "agent.resolve.v1": {
          const agentId = String((args[0] as { agentId?: string })?.agentId ?? args[0]);
          const member = listCliMembers().find((item) => item.id === agentId);
          if (!member) return null;
          return publicAgentProfile({
            id: member.id,
            adapter: member.cli.adapter,
            agentName: member.name,
            skillIds: member.cli.skillIds
          });
        }
        case "agent.execute.v1": {
          const payload = (args[0] ?? {}) as {
            requestId?: string;
            sessionId: string;
            conversationId?: string;
            agentId: string;
            agentName: string;
            adapter: string;
            binary?: string;
            extraArgs?: string[];
            env?: Record<string, string>;
            configOptionOverrides?: Record<string, string>;
            skillIds?: string[];
            prompt: string;
            promptAttachments?: unknown[];
            toolSessionScope?: string;
            toolSessionId?: string;
            resumeToolSession?: boolean;
            cwd?: string;
            workspaceAccess?: "read-only" | "read-write";
          };
          const member = listCliMembers().find((item) => item.id === payload.agentId);
          const webContents = activeWebContents();
          const executor = createCliStepExecutor(webContents);
          try {
            const trusted = trustedAgentExecution(
              member
                ? {
                    id: member.id,
                    adapter: member.cli.adapter,
                    agentName: member.name,
                    binary: member.cli.binary,
                    extraArgs: member.cli.extraArgs,
                    env: member.cli.env,
                    skillIds: member.cli.skillIds
                  }
                : undefined,
              payload
            );
            await executor.run({
              ...trusted,
              promptAttachments: payload.promptAttachments as never,
              onEvent(event) {
                meta?.emit?.("agent.event", {
                  requestId: payload.requestId ?? payload.sessionId,
                  event
                });
              }
            });
            const toolSessionId = payload.toolSessionScope
              ? getToolSession(payload.agentId, payload.toolSessionScope)?.sessionId
              : undefined;
            return { ok: true, toolSessionId };
          } catch (error) {
            return { ok: false, error: (error as Error).message };
          }
        }
        case "agent.kill.v1": {
          const sessionId = String((args[0] as { sessionId?: string })?.sessionId ?? args[0]);
          cliKill(sessionId);
          return true;
        }
        case "workflow.conversations.v1.requireOwned":
          return Boolean(requireOwnedConversation(String(args[0])));
        case "workflow.conversations.v1.listMessages":
          return listMessages(String(args[0]));
        case "workflow.conversations.v1.appendMessage":
          return appendMessage(args[0] as never);
        case "workflow.conversations.v1.updateMessage":
          updateMessage(args[0] as never);
          return true;
        case "events.publish.v1": {
          const body = (args[0] ?? {}) as { channel?: string; payload?: unknown };
          if (body.channel) safeSendToWebContents(activeWebContents(), body.channel, body.payload);
          return true;
        }
        case "telemetry.track.v1": {
          const body = (args[0] ?? {}) as { event?: string; properties?: Record<string, unknown> };
          if (body.event) trackTelemetryEvent(body.event as never, (body.properties ?? {}) as never);
          return true;
        }
        case "language.get.v1":
          return getLanguage();
        case "language.applyPreference.v1": {
          const body = (args[0] ?? {}) as { prompt?: string; language?: string };
          return applyAgentLanguagePreference(String(body.prompt ?? ""), body.language);
        }
        case "toolSession.get.v1": {
          const body = (args[0] ?? {}) as { agentId?: string; scope?: string };
          const row = getToolSession(String(body.agentId), String(body.scope));
          return row ? { sessionId: row.sessionId } : null;
        }
        case "delegation.team.v1.get":
          return getDelegationTeam(String((args[0] as { id?: string })?.id ?? args[0])) ?? null;
        case "delegation.approval.v1.request": {
          const input = (args[0] ?? {}) as { runId?: string; teammate?: unknown };
          const runId = String(input.runId ?? "");
          const approvalId = randomUUID();
          safeSendToWebContents(activeWebContents(), `delegation://approval/${runId}`, {
            runId,
            approvalId,
            teammate: input.teammate
          });
          return await new Promise<boolean>((resolve) => {
            pendingWriteApprovals.set(approvalId, { runId, resolve });
          });
        }
        case "skills.resolve.v1":
          return resolveSkillSnapshots(((args[0] as { skillIds?: string[] })?.skillIds ?? args[0] ?? []) as string[]);
        default:
          throw new Error(`unknown host api: ${method}`);
      }
}

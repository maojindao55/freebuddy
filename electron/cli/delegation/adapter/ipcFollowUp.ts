import { randomUUID } from "node:crypto";
import {
  appendMessage,
  updateConversationAgentBinding,
  notifyConversationsChanged
} from "../../conversations.js";
import { getDelegationRunByConversation } from "../../delegationRuns.js";
import { getDelegationTeam } from "../../delegationTeams.js";
import { listCliMembers } from "../../members.js";
import type { DelegationRuntimeHandle } from "../../../runtime/delegationRuntimeClient.js";

export interface DelegationFollowUpInput {
  conversationId: string;
  prompt: string;
}

export type DelegationFollowUpResult =
  | { ok: true; runId: string }
  | { ok: false; error: string; code?: "no_run" | "not_delegation" };

/**
 * Route a conversation follow-up onto the delegation bus (park/wake),
 * instead of the bare cli:run MCP-injection bypass.
 */
export async function handleDelegationFollowUp(
  runtime: Pick<DelegationRuntimeHandle, "followUp">,
  input: DelegationFollowUpInput
): Promise<DelegationFollowUpResult> {
  const run = getDelegationRunByConversation(input.conversationId);
  if (!run) return { ok: false, error: "no delegation run for conversation", code: "no_run" };
  if (!run.teamId) {
    return { ok: false, error: "delegation run missing team", code: "not_delegation" };
  }

  const team = getDelegationTeam(run.teamId);
  const entry =
    team?.roster.find((r) => r.id === team.entryRoleId) ?? team?.roster[0];
  const member = entry
    ? listCliMembers().find((m) => m.id === entry.agentId)
    : undefined;
  if (!team || !entry || !member) {
    return { ok: false, error: "Team entry agent is unavailable. Select a valid entry agent in team settings." };
  }
  updateConversationAgentBinding(input.conversationId, member);

  appendMessage({
    id: randomUUID(),
    conversationId: input.conversationId,
    role: "user",
    status: "done",
    content: input.prompt,
    agentId: entry?.agentId,
    agentName: member?.name ?? entry?.label,
    adapter: member?.cli.adapter
  });
  notifyConversationsChanged();

  // Fire-and-forget bus follow-up so IPC returns quickly; streaming mirrors via runner.
  void runtime.followUp(run.id, input.prompt);
  return { ok: true, runId: run.id };
}

/** True when this conversation should use the bus follow-up path. */
export function conversationHasDelegationRun(conversationId: string): boolean {
  const run = getDelegationRunByConversation(conversationId);
  return Boolean(run?.teamId);
}

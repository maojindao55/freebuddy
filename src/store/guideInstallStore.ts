/**
 * Request channel from Settings → CLI Agent management to the App shell:
 * "hand these missing built-in agents to GuideBuddy and open its chat".
 *
 * The renderer-side widgets (banner + per-row sparkle button) only record the
 * request here; App.tsx consumes it because closing Settings and switching to
 * the chat workspace is App-level state. The hand-off itself (readiness
 * pre-checks, find-or-create the GuideBuddy conversation, send the install
 * prompt) lives in executeGuideInstall so it stays testable without React.
 */

import { create } from "zustand";
import i18next from "i18next";

import { ONBOARDING_GUIDE_AGENT_ID } from "@/config/agentProfiles";
import type { CLIAdapterDefinition } from "@/config/cliAdapters";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useConversationStore } from "@/store/conversationStore";
import { useProviderStore } from "@/store/providerStore";

export type GuideInstallFailureReason =
  | "no_member"
  | "runtime_missing"
  | "model_missing"
  | "busy"
  | "nothing_to_do"
  | "send_failed";

export type GuideInstallOutcome =
  | { ok: true }
  | { ok: false; reason: GuideInstallFailureReason };

interface GuideInstallState {
  /** Latest unconsumed request; null once App has picked it up. */
  pending: { token: number; agentIds: string[] } | null;
  /** Agents a hand-off asked GuideBuddy to install, awaiting a real probe. */
  awaitingVerification: { conversationId: string; agentIds: string[] } | null;
  requestGuideInstall(agentIds: readonly string[]): void;
  clearRequest(): void;
  /**
   * Re-probe the hand-off's requested agents through FreeBuddy's own check
   * pipeline. Called when a guide turn completes (and when the settings list
   * opens) so every surface shows the verified runtime state, not whatever
   * the assistant reported in chat.
   */
  settleGuideTurn(conversationId?: string): Promise<void>;
}

let requestToken = 0;

export const useGuideInstallStore = create<GuideInstallState>((set, get) => ({
  pending: null,
  awaitingVerification: null,
  requestGuideInstall(agentIds) {
    const ids = [...new Set(agentIds)];
    if (!ids.length) return;
    requestToken += 1;
    set({ pending: { token: requestToken, agentIds: ids } });
  },
  clearRequest() {
    set({ pending: null });
  },
  async settleGuideTurn(conversationId) {
    const awaiting = get().awaitingVerification;
    if (!awaiting) return;
    if (conversationId && awaiting.conversationId !== conversationId) return;
    // Clear first so a turn-end settle and a settings-mount settle cannot
    // double-probe the same hand-off.
    set({ awaitingVerification: null });
    const executorStore = useCliExecutorStore.getState();
    await Promise.allSettled(
      awaiting.agentIds.map((id) => executorStore.check(id))
    );
  }
}));

/**
 * Find (or create) the GuideBuddy conversation and ask it to install the
 * requested built-in agents. Readiness is checked first so a cold install
 * gets an actionable toast instead of a silent dead-end in chat.
 */
export async function executeGuideInstall(
  agentIds: readonly string[]
): Promise<GuideInstallOutcome> {
  const member = useConversationStore
    .getState()
    .members.find((m) => m.id === ONBOARDING_GUIDE_AGENT_ID);
  if (!member) return { ok: false, reason: "no_member" };

  // Readiness: the pi runtime (bundled extraResource or a global install)
  // must be present. A stale "not installed" gets one re-check first.
  const executorStore = useCliExecutorStore.getState();
  if (!executorStore.runtimes["pi-acp"]?.installed) {
    await executorStore.check("pi-acp");
  }
  if (!useCliExecutorStore.getState().runtimes["pi-acp"]?.installed) {
    return { ok: false, reason: "runtime_missing" };
  }

  // ...and the pi adapter needs model access (trial binding via BYOK, or any
  // configured provider the user can bind/log in with).
  const hasModelAccess =
    useCliExecutorStore.getState().overrides["pi-acp"]?.piByok?.enabled ||
    useProviderStore.getState().providers.some((p) => p.enabled);
  if (!hasModelAccess) return { ok: false, reason: "model_missing" };

  // Official install command for each requested agent, straight from the
  // adapter registry — the same commands the native Install button runs.
  const definitions = useCliExecutorStore.getState().adapters;
  const requested = agentIds
    .map((id) => definitions.find((d) => d.id === id))
    .filter((d): d is CLIAdapterDefinition => Boolean(d?.installHint));
  if (!requested.length) return { ok: false, reason: "nothing_to_do" };

  const items = requested
    .map((d) => `- ${d.label} (${d.defaultBinary}): \`${d.installHint}\``)
    .join("\n");
  const prompt = i18next.t("settings.cli.guideInstall.prompt", { items });

  // Reuse the newest GuideBuddy conversation so it keeps its context; create
  // one on first use (same shape as the onboarding welcome overlay).
  const conversation = useConversationStore
    .getState()
    .conversations.find((c) => c.agentId === ONBOARDING_GUIDE_AGENT_ID);
  let conversationId: string;
  if (conversation) {
    if (useConversationStore.getState().isRunning(conversation.id)) {
      return { ok: false, reason: "busy" };
    }
    conversationId = conversation.id;
    await useConversationStore.getState().setActive(conversationId);
  } else {
    const created = await useConversationStore.getState().newConversation({
      member,
      title: member.name
    });
    conversationId = created.id;
  }

  try {
    await useConversationStore.getState().sendMessage({
      conversationId,
      prompt
    });
  } catch {
    return { ok: false, reason: "send_failed" };
  }
  // Remember what this hand-off asked for: when the guide turn completes
  // (and when the settings list next opens) the ids are re-probed through
  // FreeBuddy's own check pipeline, so the CLI agent list reflects verified
  // state instead of the assistant's chat claim.
  useGuideInstallStore.setState({
    awaitingVerification: {
      conversationId,
      agentIds: requested.map((d) => d.id)
    }
  });
  return { ok: true };
}

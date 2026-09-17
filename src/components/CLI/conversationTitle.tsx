import { useTranslation } from "react-i18next";

import type { Conversation } from "@/services/cli/types";
import {
  displayConversationTitle,
  isDelegationConversation
} from "@/store/conversationUtils";

type TitleConversation = Pick<
  Conversation,
  "title" | "agentName" | "cwd" | "kind"
>;

export function conversationVisibleTitle(
  conversation: TitleConversation,
  fallback: string
): string {
  return displayConversationTitle(
    conversation,
    isDelegationConversation(conversation) ? fallback : undefined
  );
}

export function useConversationVisibleTitle(conversation: TitleConversation): string {
  const { t } = useTranslation();
  return conversationVisibleTitle(
    conversation,
    t("workflow.delegation.sessionTitleFallback")
  );
}

export function ConversationKindBadge({
  conversation
}: {
  conversation: Pick<Conversation, "kind" | "title">;
}) {
  const { t } = useTranslation();
  if (!isDelegationConversation(conversation)) return null;
  return (
    <span className="conversation-kind-badge">
      {t("workflow.delegation.kindBadge")}
    </span>
  );
}

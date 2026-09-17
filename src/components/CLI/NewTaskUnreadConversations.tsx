import { useMemo } from "react";
import { ChevronRight, Folder, LoaderCircle, MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";

import { displayAgentName } from "@/config/agentDisplay";
import { useConversationStore } from "@/store/conversationStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { formatDisplayPath } from "@/utils/projectPaths";

import { AgentAvatar } from "./AgentAvatar";
import { ConversationKindBadge, conversationVisibleTitle } from "./conversationTitle";
import {
  conversationActivityTime,
  conversationDisplayCwd,
  projectLabelFromCwd
} from "./conversationProjectGrouping";

const UNREAD_PREVIEW_LIMIT = 3;

function formatRelativeActivity(timestampMs: number, locale: string): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "";
  const diffSec = Math.round((timestampMs - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale || undefined, {
    numeric: "auto"
  });
  if (abs < 60) return rtf.format(diffSec, "second");
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return rtf.format(diffHour, "hour");
  const diffDay = Math.round(diffHour / 24);
  if (Math.abs(diffDay) < 30) return rtf.format(diffDay, "day");
  return new Date(timestampMs).toLocaleDateString(locale || undefined, {
    month: "short",
    day: "numeric"
  });
}

export function NewTaskUnreadConversations() {
  const { t, i18n } = useTranslation();
  const conversations = useConversationStore((s) => s.conversations);
  const unreadConversations = useConversationStore((s) => s.unreadConversations);
  const live = useConversationStore((s) => s.live);
  const setActive = useConversationStore((s) => s.setActive);
  const activeRuns = useWorkflowStore((s) => s.activeRuns);

  const unreadAll = useMemo(() => {
    return conversations
      .filter((conversation) => Boolean(unreadConversations[conversation.id]))
      .sort((a, b) => conversationActivityTime(b) - conversationActivityTime(a));
  }, [conversations, unreadConversations]);

  const unreadItems = unreadAll.slice(0, UNREAD_PREVIEW_LIMIT);

  if (unreadItems.length === 0) return null;

  return (
    <section
      className="new-task-unread"
      aria-label={t("chat.unreadConversationsAria")}
    >
      <div className="new-task-unread-header">
        <h2 className="new-task-unread-title">{t("chat.unreadConversations")}</h2>
        <span className="new-task-unread-count">{unreadAll.length}</span>
      </div>
      <ul className="new-task-unread-list">
        {unreadItems.map((conversation) => {
          const cwd = conversationDisplayCwd(conversation);
          const workspaceLabel = cwd ? projectLabelFromCwd(cwd) : "";
          const agentLabel = displayAgentName(
            conversation.agentName,
            conversation.adapter
          );
          const liveStatus = live[conversation.id]?.status;
          const isRunning =
            liveStatus === "running" || liveStatus === "starting";
          const isWorkflowRunning = activeRuns.some(
            (run) => run.conversationId === conversation.id
          );
          const isBusy = isRunning || isWorkflowRunning;
          const activityLabel = formatRelativeActivity(
            conversationActivityTime(conversation),
            i18n.language
          );
          const visibleTitle = conversationVisibleTitle(
            conversation,
            t("workflow.delegation.sessionTitleFallback")
          );

          return (
            <li key={conversation.id}>
              <button
                type="button"
                className={`new-task-unread-item${isBusy ? " busy" : ""}`}
                title={visibleTitle}
                onClick={() => void setActive(conversation.id)}
              >
                <AgentAvatar
                  adapter={conversation.adapter}
                  className="conv-item-avatar"
                  fallback={<MessageSquare aria-hidden="true" />}
                />
                <span className="new-task-unread-copy">
                  <strong>
                    <ConversationKindBadge conversation={conversation} />
                    <span>{visibleTitle}</span>
                  </strong>
                  <span className="new-task-unread-meta">
                    <span className="new-task-unread-agent">{agentLabel}</span>
                    {workspaceLabel ? (
                      <span
                        className="new-task-unread-workspace"
                        title={formatDisplayPath(cwd)}
                      >
                        <Folder aria-hidden="true" size={12} strokeWidth={1.8} />
                        {workspaceLabel}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="new-task-unread-side">
                  {activityLabel ? (
                    <span className="new-task-unread-time">{activityLabel}</span>
                  ) : null}
                  {isBusy ? (
                    <span
                      className="new-task-unread-running"
                      role="status"
                      aria-label={
                        isWorkflowRunning
                          ? t("workflow.runningIndicator")
                          : t("chat.agentRunning")
                      }
                      title={
                        isWorkflowRunning
                          ? t("workflow.runningIndicator")
                          : t("chat.agentRunning")
                      }
                    >
                      <LoaderCircle
                        aria-hidden="true"
                        size={14}
                        strokeWidth={1.75}
                      />
                    </span>
                  ) : (
                    <span
                      className="new-task-unread-dot"
                      role="status"
                      aria-label={t("conversations.unread")}
                      title={t("conversations.unread")}
                    />
                  )}
                  <ChevronRight
                    className="new-task-unread-chevron"
                    aria-hidden="true"
                    size={16}
                    strokeWidth={1.8}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

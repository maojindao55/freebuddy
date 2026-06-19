import { useConversationStore } from "@/store/conversationStore";
import type { Conversation } from "@/services/cli/types";
import { displayAgentName } from "@/config/agentDisplay";

function conversationTimeValue(conversation: Conversation) {
  return conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit"
    }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatConversationTimeTitle(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function ConversationList({
  onNew
}: {
  onNew: () => void;
}) {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const setActive = useConversationStore((s) => s.setActive);
  const live = useConversationStore((s) => s.live);
  const remove = useConversationStore((s) => s.deleteConversation);

  return (
    <div className="conv-list">
      <div className="conv-list-header">
        <h2>Conversations</h2>
        <button className="ghost" onClick={onNew}>
          + New
        </button>
      </div>
      <ul>
        {conversations.length === 0 && (
          <li className="conv-empty muted">No conversations yet.</li>
        )}
        {conversations.map((c) => {
          const running =
            live[c.id]?.status === "running" || live[c.id]?.status === "starting";
          const timeValue = conversationTimeValue(c);
          const timeLabel = formatConversationTime(timeValue);
          const agentName = displayAgentName(c.agentName, c.adapter);
          return (
            <li
              key={c.id}
              className={`conv-item${activeId === c.id ? " active" : ""}`}
              onClick={() => void setActive(c.id)}
            >
              {running && <span className="conv-running-dot" />}
              <div className="conv-item-main">
                <div className="conv-item-title-row">
                  <strong>{c.title}</strong>
                </div>
                <small>
                  {agentName}
                  {c.cwd ? ` · ${c.cwd.split(/[/\\]/).slice(-2).join("/")}` : ""}
                  {timeLabel && (
                    <>
                      {" · "}
                      <time dateTime={timeValue} title={formatConversationTimeTitle(timeValue)}>
                        {timeLabel}
                      </time>
                    </>
                  )}
                </small>
              </div>
              <div className="conv-item-side">
                <button
                  className="icon-btn danger"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete "${c.title}"?`))
                      void remove(c.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { Conversation } from "@/services/cli/types";
import { useConversationStore } from "@/store/conversationStore";
import {
  displayConversationTitle,
  isDelegationConversation,
  sanitizeUserConversationTitle,
  USER_CONVERSATION_TITLE_MAX
} from "@/store/conversationUtils";

type TitleConversation = Pick<
  Conversation,
  "id" | "title" | "agentName" | "cwd" | "kind" | "titleSource"
>;

export function conversationVisibleTitle(
  conversation: Omit<TitleConversation, "id">,
  fallback: string
): string {
  return displayConversationTitle(
    conversation,
    isDelegationConversation(conversation) ? fallback : undefined
  );
}

export function useConversationVisibleTitle(
  conversation: Omit<TitleConversation, "id">
): string {
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

export function EditableConversationTitle({
  conversation,
  variant
}: {
  conversation: TitleConversation;
  variant: "titlebar" | "list";
}) {
  const { t } = useTranslation();
  const renameConversation = useConversationStore((s) => s.renameConversation);
  const visibleTitle = useConversationVisibleTitle(conversation);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(visibleTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const finishRef = useRef(false);
  const editSessionRef = useRef<{
    id: string;
    visibleTitle: string;
    titleSource: TitleConversation["titleSource"];
  } | null>(null);
  const editing = editingId === conversation.id;

  useEffect(() => {
    if (editingId) return;
    setDraft(visibleTitle);
  }, [conversation.id, visibleTitle, editingId]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startEditing = (event?: MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    finishRef.current = false;
    editSessionRef.current = {
      id: conversation.id,
      visibleTitle,
      titleSource: conversation.titleSource
    };
    setDraft(visibleTitle);
    setEditingId(conversation.id);
  };

  const cancel = () => {
    if (finishRef.current) return;
    finishRef.current = true;
    editSessionRef.current = null;
    setEditingId(null);
    setDraft(visibleTitle);
  };

  const commit = async () => {
    if (finishRef.current) return;
    finishRef.current = true;
    const session = editSessionRef.current;
    editSessionRef.current = null;
    const next = sanitizeUserConversationTitle(draft);
    setEditingId(null);
    if (!next || !session) {
      setDraft(session?.visibleTitle ?? visibleTitle);
      return;
    }
    setDraft(next);
    if (next === session.visibleTitle && session.titleSource === "user") return;
    await renameConversation(session.id, next);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <div
      className={`conversation-title-editor ${variant}${variant === "titlebar" ? " breadcrumb" : ""}`}
      title={editing ? undefined : visibleTitle}
      onClick={editing ? (event) => event.stopPropagation() : undefined}
      onMouseDown={editing ? (event) => event.stopPropagation() : undefined}
    >
      <ConversationKindBadge conversation={conversation} />
      {editing ? (
        <input
          ref={inputRef}
          className="conversation-title-input"
          value={draft}
          maxLength={USER_CONVERSATION_TITLE_MAX}
          aria-label={t("conversations.renameTitle")}
          placeholder={t("conversations.titlePlaceholder")}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            void commit();
          }}
          onKeyDown={handleInputKeyDown}
        />
      ) : (
        <>
          {variant === "titlebar" ? (
            <button
              type="button"
              className="conversation-title-text"
              title={visibleTitle}
              onClick={startEditing}
            >
              <strong>{visibleTitle}</strong>
            </button>
          ) : (
            <strong onDoubleClick={startEditing}>
              {visibleTitle}
            </strong>
          )}
          <button
            type="button"
            className={
              variant === "titlebar"
                ? "titlebar-icon-button conversation-title-edit-btn"
                : "conversation-title-edit-btn icon-btn"
            }
            title={t("conversations.renameTitle")}
            aria-label={t("conversations.renameTitle")}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={startEditing}
          >
            <Pencil aria-hidden="true" size={14} strokeWidth={1.8} />
          </button>
        </>
      )}
    </div>
  );
}

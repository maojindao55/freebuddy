import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArchiveRestore,
  Bot,
  CircleAlert,
  LoaderCircle,
  MessageSquare,
  Search,
  Trash2
} from "lucide-react";

import type { Conversation } from "@/services/cli/types";
import { cliClient } from "@/services/cli/client";
import { useConversationStore } from "@/store/conversationStore";
import { AgentAvatar } from "@/components/CLI/AgentAvatar";

/**
 * Manage archived conversations. Loads the archived list on demand into local
 * state only — archived rows must never re-enter the main conversation store
 * until they are restored.
 */
export function ArchivedConversationsTab() {
  const { t, i18n } = useTranslation();
  const archiveConversation = useConversationStore((s) => s.archiveConversation);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");

  const reload = useCallback(async () => {
    setError(undefined);
    try {
      const rows = await cliClient.listConversations({
        archived: true,
        limit: 500
      });
      setItems(rows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((conversation) =>
      `${conversation.title} ${conversation.agentName}`
        .toLocaleLowerCase()
        .includes(needle)
    );
  }, [items, query]);

  const handleRestore = async (conversation: Conversation) => {
    setItems((current) =>
      current ? current.filter((entry) => entry.id !== conversation.id) : current
    );
    try {
      await archiveConversation(conversation.id, false, conversation);
    } catch (cause) {
      if (import.meta.env?.DEV) {
        console.warn("[FreeBuddy] Failed to restore conversation:", cause);
      }
      await reload();
    }
  };

  const handleDelete = async (conversation: Conversation) => {
    if (
      !window.confirm(t("conversations.deleteConfirm", { title: conversation.title }))
    ) {
      return;
    }
    setItems((current) =>
      current ? current.filter((entry) => entry.id !== conversation.id) : current
    );
    try {
      await deleteConversation(conversation.id);
    } catch (cause) {
      if (import.meta.env?.DEV) {
        console.warn("[FreeBuddy] Failed to delete archived conversation:", cause);
      }
      await reload();
    }
  };

  return (
    <div className="settings-tab archived-conversations-tab">
      <h3>{t("settings.archived.title")}</h3>
      <p className="muted">{t("settings.archived.subtitle")}</p>

      <div className="archived-conversations-toolbar">
        <div className="archived-conversations-search">
          <Search aria-hidden="true" size={15} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("settings.archived.searchPlaceholder")}
            aria-label={t("settings.archived.searchPlaceholder")}
          />
        </div>
        <span className="archived-conversations-count">
          {items
            ? t("settings.archived.count", { count: filtered.length })
            : ""}
        </span>
      </div>

      {error ? (
        <div className="archived-conversations-error" role="alert">
          <CircleAlert aria-hidden="true" size={15} />
          <span>{error}</span>
          <button type="button" onClick={() => void reload()}>
            {t("settings.archived.retry")}
          </button>
        </div>
      ) : items === null ? (
        <div className="archived-conversations-empty">
          <LoaderCircle className="spin" aria-hidden="true" size={18} />
          <span>{t("settings.archived.loading")}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="archived-conversations-empty">
          {items.length === 0 ? (
            <>
              <ArchiveRestore aria-hidden="true" size={26} strokeWidth={1.4} />
              <span>{t("settings.archived.empty")}</span>
            </>
          ) : (
            <span>{t("conversations.noResults")}</span>
          )}
        </div>
      ) : (
        <ul className="archived-conversations-list">
          {filtered.map((conversation) => (
            <li key={conversation.id} className="archived-conversation-item">
              <AgentAvatar
                adapter={conversation.adapter}
                agentId={conversation.agentId}
                className="archived-conversation-avatar"
                fallback={<MessageSquare aria-hidden="true" size={16} />}
              />
              <div className="archived-conversation-main">
                <span className="archived-conversation-title" title={conversation.title}>
                  {conversation.title}
                </span>
                <span className="archived-conversation-meta">
                  <Bot aria-hidden="true" size={12} />
                  <span>{conversation.agentName}</span>
                  <time dateTime={conversation.updatedAt}>
                    {new Date(conversation.updatedAt).toLocaleString(i18n.language)}
                  </time>
                </span>
              </div>
              <div className="archived-conversation-actions">
                <button
                  type="button"
                  className="archived-conversation-restore"
                  onClick={() => void handleRestore(conversation)}
                >
                  <ArchiveRestore aria-hidden="true" size={14} />
                  <span>{t("settings.archived.restore")}</span>
                </button>
                <button
                  type="button"
                  className="archived-conversation-delete"
                  onClick={() => void handleDelete(conversation)}
                >
                  <Trash2 aria-hidden="true" size={14} />
                  <span>{t("common.delete")}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

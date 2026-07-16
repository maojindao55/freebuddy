import { Fragment, memo, useCallback, useEffect, useMemo, useState } from "react";
import { useConversationStore } from "@/store/conversationStore";
import { useWorkflowStore } from "@/store/workflowStore";
import type { Conversation } from "@/services/cli/types";
import { displayAgentName } from "@/config/agentDisplay";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import { MessageSquare, Search, X } from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";

function conversationTimeValue(conversation: Conversation) {
  return conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt;
}

type TimeFormatVariant = "time" | "md" | "ymd" | "full";

// Intl.DateTimeFormat construction is expensive; cache one formatter per
// (language, variant). Previously the list rebuilt up to 4*N formatter
// objects on every render of the sidebar.
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormatter(lang: string, variant: TimeFormatVariant): Intl.DateTimeFormat {
  const key = `${lang}|${variant}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const options: Intl.DateTimeFormatOptions =
    variant === "time"
      ? { hour: "2-digit", minute: "2-digit" }
      : variant === "md"
        ? { month: "2-digit", day: "2-digit" }
        : variant === "ymd"
          ? { year: "numeric", month: "2-digit", day: "2-digit" }
          : {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit"
            };
  const formatter = new Intl.DateTimeFormat(lang, options);
  formatterCache.set(key, formatter);
  return formatter;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const lang = i18next.language || "en";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return dateTimeFormatter(lang, "time").format(date);
  if (date.getFullYear() === now.getFullYear())
    return dateTimeFormatter(lang, "md").format(date);
  return dateTimeFormatter(lang, "ymd").format(date);
}

function shortCwd(cwd: string) {
  return cwd.split(/[/\\]/).slice(-2).join("/");
}

interface ConvSection {
  key: string;
  label: string;
  items: Conversation[];
}

const SECTION_ORDER = ["today", "yesterday", "last7", "last30", "earlier"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bucket conversations into ordered recency sections. Items arrive pre-sorted
 * by recency (DESC) from the DB, so each bucket preserves that order.
 */
function groupConversationsByDate(
  items: Conversation[],
  labels: Record<string, string>
): ConvSection[] {
  const now = new Date();
  const startToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const buckets: Record<string, Conversation[]> = {
    today: [],
    yesterday: [],
    last7: [],
    last30: [],
    earlier: []
  };
  for (const c of items) {
    const ts = Date.parse(conversationTimeValue(c));
    let key: string;
    if (!Number.isFinite(ts)) key = "earlier";
    else if (ts >= startToday) key = "today";
    else if (ts >= startToday - DAY_MS) key = "yesterday";
    else if (ts >= startToday - 7 * DAY_MS) key = "last7";
    else if (ts >= startToday - 30 * DAY_MS) key = "last30";
    else key = "earlier";
    buckets[key].push(c);
  }
  const sections: ConvSection[] = [];
  for (const key of SECTION_ORDER) {
    if (buckets[key].length > 0) {
      sections.push({ key, label: labels[key], items: buckets[key] });
    }
  }
  return sections;
}

const ConversationRow = memo(function ConversationRow({
  conversation,
  isActive,
  isRunning,
  isWorkflowRunning,
  onSelect,
  onDelete
}: {
  conversation: Conversation;
  isActive: boolean;
  isRunning: boolean;
  isWorkflowRunning: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const timeValue = conversationTimeValue(conversation);
  const timeLabel = formatConversationTime(timeValue);
  const agentName = displayAgentName(conversation.agentName, conversation.adapter);
  const metadata = [
    agentName,
    conversation.cwd ? shortCwd(conversation.cwd) : "",
    timeLabel
  ].filter(Boolean).join(" · ");

  return (
    <li
      className={`conv-item${isActive ? " active" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      title={metadata}
      onClick={() => onSelect(conversation.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(conversation.id);
        }
      }}
    >
      {(isRunning || isWorkflowRunning) && (
        <span
          className={`conv-running-dot${isWorkflowRunning ? " workflow" : ""}`}
          title={isWorkflowRunning ? t("workflow.runningIndicator") : t("chat.agentRunning")}
        />
      )}
      <AgentAvatar
        adapter={conversation.adapter}
        className="conv-item-avatar"
        fallback={<MessageSquare aria-hidden="true" />}
      />
      <div className="conv-item-main">
        <div className="conv-item-title-row">
          <strong>{conversation.title}</strong>
        </div>
      </div>
      <div className="conv-item-side">
        <button
          className="icon-btn danger"
          title={t("common.delete")}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(conversation.id, conversation.title);
          }}
        >
          ✕
        </button>
      </div>
    </li>
  );
});

export function ConversationList() {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const setActive = useConversationStore((s) => s.setActive);
  // Subscribe to a stable signature of the running set instead of the whole
  // live map: this list re-renders only when a conversation starts or stops,
  // not on every streaming chunk emitted by an already-running agent.
  const runningSignature = useConversationStore((s) => {
    const ids: string[] = [];
    for (const c of s.conversations) {
      const st = s.live[c.id]?.status;
      if (st === "running" || st === "starting") ids.push(c.id);
    }
    return ids.join("\n");
  });
  const workflowActiveRuns = useWorkflowStore((s) => s.activeRuns);
  const loadWorkflowActiveRuns = useWorkflowStore((s) => s.loadActiveRuns);
  const remove = useConversationStore((s) => s.deleteConversation);
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const runningSet = new Set(runningSignature ? runningSignature.split("\n") : []);
  const workflowRunningSet = new Set(
    workflowActiveRuns
      .map((run) => run.conversationId)
      .filter((id): id is string => Boolean(id))
  );

  // Stable callbacks so memoized rows don't all re-render on every parent render.
  const handleSelect = useCallback(
    (id: string) => {
      void setActive(id);
    },
    [setActive]
  );
  const handleDelete = useCallback(
    (id: string, title: string) => {
      if (window.confirm(i18next.t("conversations.deleteConfirm", { title }))) {
        void remove(id);
      }
    },
    [remove]
  );

  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    void loadWorkflowActiveRuns();
  }, [loadWorkflowActiveRuns]);

  const filtered = useMemo(() => {
    if (!normalizedQuery) return conversations;
    return conversations.filter((c) => {
      if (c.title.toLowerCase().includes(normalizedQuery)) return true;
      return displayAgentName(c.agentName, c.adapter)
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [conversations, normalizedQuery]);

  const sections = useMemo(() => {
    const labels: Record<string, string> = {
      today: t("conversations.group.today"),
      yesterday: t("conversations.group.yesterday"),
      last7: t("conversations.group.last7Days"),
      last30: t("conversations.group.last30Days"),
      earlier: t("conversations.group.earlier")
    };
    return groupConversationsByDate(filtered, labels);
  }, [filtered, t]);

  return (
    <div className="conv-list">
      <div className="conv-list-header">
        <h2>{t("conversations.title")}</h2>
        <button
          type="button"
          className={`conv-list-search-toggle${searchOpen || query ? " active" : ""}`}
          title={t("conversations.searchPlaceholder")}
          aria-label={t("conversations.searchPlaceholder")}
          aria-expanded={searchOpen || Boolean(query)}
          onClick={() => {
            if (searchOpen && query) setQuery("");
            setSearchOpen((open) => !open);
          }}
        >
          {searchOpen || query ? <X aria-hidden="true" /> : <Search aria-hidden="true" />}
        </button>
      </div>
      {(searchOpen || query) && (
        <div className="conv-search">
          <input
            type="text"
            autoFocus
            value={query}
            enterKeyHint="search"
            placeholder={t("conversations.searchPlaceholder")}
            aria-label={t("conversations.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
                setSearchOpen(false);
              }
            }}
          />
        </div>
      )}
      <ul>
        {sections.length === 0 ? (
          <li className="conv-empty muted">
            {normalizedQuery
              ? t("conversations.noResults")
              : t("conversations.empty")}
          </li>
        ) : (
          sections.map((section) => (
            <Fragment key={section.key}>
              <li className="conv-group-header">
                <span>{section.label}</span>
              </li>
              {section.items.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  isActive={activeId === c.id}
                  isRunning={runningSet.has(c.id)}
                  isWorkflowRunning={workflowRunningSet.has(c.id)}
                  onSelect={handleSelect}
                  onDelete={handleDelete}
                />
              ))}
            </Fragment>
          ))
        )}
      </ul>
    </div>
  );
}

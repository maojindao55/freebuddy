import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileCode2, ListTree, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cliClient } from "@/services/cli/client";
import type {
  ConversationDigest,
  ConversationTopic,
  ConversationTopicStatus
} from "@/services/cli/types";

const STATUS_DOT_CLASS: Record<ConversationTopicStatus, string> = {
  open: "is-open",
  done: "is-done",
  blocked: "is-blocked",
  abandoned: "is-abandoned"
};

function fileBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

function topicMatchesQuery(topic: ConversationTopic, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    topic.title,
    topic.summary,
    topic.keywords.join(" "),
    topic.files.join(" ")
  ]
    .join("\n")
    .toLowerCase();
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export function ConversationDigestCard({
  conversationId,
  messageCount,
  onJumpToMessage
}: {
  conversationId: string;
  messageCount: number;
  onJumpToMessage?: (conversationId: string, messageId: string) => void;
}) {
  const { t } = useTranslation();
  const [digest, setDigest] = useState<ConversationDigest | null>(null);
  const [filter, setFilter] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  const loadDigest = useCallback(async () => {
    if (!cliClient.isAvailable() || !conversationId) {
      setDigest(null);
      return;
    }
    try {
      const next = await cliClient.getConversationDigest(conversationId);
      setDigest(next);
    } catch {
      // Keep the last rendered digest on transient IPC failures.
    }
  }, [conversationId]);

  useEffect(() => {
    setFilter("");
    setSearchOpen(false);
    setRefreshing(false);
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cliClient.isAvailable() || !conversationId) {
        if (!cancelled) setDigest(null);
        return;
      }
      try {
        const next = await cliClient.getConversationDigest(conversationId);
        if (!cancelled) setDigest(next);
      } catch {
        // Ignore transient read errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, messageCount]);

  useEffect(() => {
    if (!cliClient.isAvailable() || !conversationId) return;
    return cliClient.onConversationDigestChanged((event) => {
      if (event.conversationId !== conversationId) return;
      if (event.status === "ready" || event.status === "error") {
        setRefreshing(false);
      }
      void loadDigest();
    });
  }, [conversationId, loadDigest]);

  const topics = digest?.topics ?? [];
  const canFilter = topics.length >= 2;
  const effectiveFilter = canFilter ? filter : "";
  const filteredTopics = useMemo(
    () => topics.filter((topic) => topicMatchesQuery(topic, effectiveFilter)),
    [topics, effectiveFilter]
  );

  useEffect(() => {
    if (!canFilter && (searchOpen || filter)) {
      setSearchOpen(false);
      setFilter("");
    }
  }, [canFilter, searchOpen, filter]);

  useEffect(() => {
    if (!searchOpen || !canFilter) return;
    filterInputRef.current?.focus();
  }, [searchOpen, canFilter]);

  if (!digest || topics.length === 0) return null;

  const isBusy =
    refreshing || digest.status === "running" || digest.status === "queued";

  const onRefreshClick = async () => {
    if (isBusy || !cliClient.isAvailable()) return;
    setRefreshing(true);
    try {
      const next = await cliClient.refreshConversationDigest({
        conversationId,
        forceRebuild: true
      });
      if (next) setDigest(next);
    } finally {
      setRefreshing(false);
    }
  };

  const onToggleSearch = () => {
    if (searchOpen) {
      setSearchOpen(false);
      setFilter("");
    } else {
      setSearchOpen(true);
    }
  };

  const onClearOrCloseSearch = () => {
    if (filter) {
      setFilter("");
      filterInputRef.current?.focus();
    } else {
      setSearchOpen(false);
    }
  };

  return (
    <section className="side-card digest-card" aria-label={t("conversationDigest.title")}>
      <div className="digest-card-top">
        <div className="digest-card-header">
          <div className="digest-card-title-group">
            <h3 className="digest-card-title">{t("conversationDigest.title")}</h3>
            <span
              className={`digest-source-badge ${digest.source === "llm" ? "is-llm" : "is-rule"}`}
              title={
                digest.source === "llm"
                  ? t("conversationDigest.sourceLlmHint")
                  : t("conversationDigest.sourceRuleHint")
              }
            >
              {digest.source === "llm" ? (
                <>
                  <Sparkles size={11} aria-hidden="true" />
                  <span>{t("conversationDigest.sourceLlm")}</span>
                </>
              ) : (
                <>
                  <ListTree size={11} aria-hidden="true" />
                  <span>{t("conversationDigest.sourceRule")}</span>
                </>
              )}
            </span>
          </div>
          <div className="digest-header-actions">
            {canFilter && (
              <button
                type="button"
                className={`digest-icon-btn${searchOpen ? " is-active" : ""}`}
                onClick={onToggleSearch}
                aria-expanded={searchOpen}
                aria-label={
                  searchOpen
                    ? t("conversationDigest.closeFilter")
                    : t("conversationDigest.toggleFilter")
                }
                title={
                  searchOpen
                    ? t("conversationDigest.closeFilter")
                    : t("conversationDigest.toggleFilter")
                }
              >
                <Search size={13} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className={`digest-refresh-btn${isBusy ? " is-busy" : ""}`}
              disabled={isBusy}
              onClick={() => void onRefreshClick()}
              title={t("conversationDigest.refreshTitle")}
            >
              <RefreshCw
                size={12}
                className={isBusy ? "digest-spin" : undefined}
                aria-hidden="true"
              />
              <span>
                {isBusy
                  ? t("conversationDigest.organizing")
                  : digest.source === "llm"
                    ? t("conversationDigest.reorganize")
                    : t("conversationDigest.organize")}
              </span>
            </button>
          </div>
        </div>
        {canFilter && searchOpen && (
          <div className="digest-filter-wrap">
            <Search size={12} aria-hidden="true" />
            <input
              ref={filterInputRef}
              type="text"
              className="digest-filter-input"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setFilter("");
                  setSearchOpen(false);
                }
              }}
              placeholder={t("conversationDigest.filterPlaceholder")}
              aria-label={t("conversationDigest.filterPlaceholder")}
            />
            {filter.trim().length > 0 && (
              <span className="digest-filter-count">
                {filteredTopics.length}/{topics.length}
              </span>
            )}
            <button
              type="button"
              className="digest-filter-clear"
              onClick={onClearOrCloseSearch}
              aria-label={
                filter
                  ? t("conversationDigest.clearFilter")
                  : t("conversationDigest.closeFilter")
              }
              title={
                filter
                  ? t("conversationDigest.clearFilter")
                  : t("conversationDigest.closeFilter")
              }
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {digest.status === "error" && digest.error && (
        <p className="digest-error-hint" role="status">
          {digest.error === "no_provider"
            ? t("conversationDigest.errorNoProvider")
            : t("conversationDigest.errorGeneric", { error: digest.error })}
        </p>
      )}

      {filteredTopics.length === 0 ? (
        <p className="digest-empty-filter">{t("conversationDigest.noMatches")}</p>
      ) : (
        <ol className="digest-topic-list">
          {filteredTopics.map((topic) => {
            const showSummary =
              Boolean(topic.summary) && topic.summary !== topic.title;
            const visibleFiles = topic.files.slice(0, 2);
            const extraFileCount = Math.max(
              0,
              topic.files.length - visibleFiles.length
            );
            return (
              <li key={topic.id} className="digest-topic-item">
                <button
                  type="button"
                  className="digest-topic-btn"
                  onClick={() =>
                    onJumpToMessage?.(conversationId, topic.startMessageId)
                  }
                >
                  <div className="digest-topic-row-top">
                    <span
                      className={`digest-status-dot ${STATUS_DOT_CLASS[topic.status]}`}
                      aria-hidden="true"
                    />
                    <strong className="digest-topic-title">{topic.title}</strong>
                    {topic.turnCount > 1 && (
                      <span className="digest-turn-pill">
                        {t("conversationDigest.turnCount", {
                          count: topic.turnCount
                        })}
                      </span>
                    )}
                    <span className={`digest-status-label ${STATUS_DOT_CLASS[topic.status]}`}>
                      {t(`conversationDigest.status.${topic.status}`)}
                    </span>
                  </div>
                  {showSummary && (
                    <p className="digest-topic-summary">{topic.summary}</p>
                  )}
                  {topic.files.length > 0 && (
                    <div
                      className="digest-topic-files"
                      title={topic.files.join("\n")}
                    >
                      <FileCode2 size={11} aria-hidden="true" />
                      <span>
                        {visibleFiles.map(fileBasename).join(", ")}
                        {extraFileCount > 0 ? ` +${extraFileCount}` : ""}
                      </span>
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

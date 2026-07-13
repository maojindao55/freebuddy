import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw, Shuffle } from "lucide-react";

import type { FeedItem } from "@/services/feed/types";
import { useConversationStore } from "@/store/conversationStore";
import { useDetailLayoutStore } from "@/store/detailLayoutStore";
import { useDraftPreviewStore } from "@/store/draftPreviewStore";
import { useFeedStore } from "@/store/feedStore";
import {
  FEED_CARD_PAGE_SIZE,
  getSelectableFeedItems,
  selectFeedCardItems
} from "./feedCardSelection";
import {
  buildFeedInterpretPrompt,
  clipFeedTitle,
  isFeedInterpretConversation
} from "./feedInterpretation";

function formatFeedTime(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function FeedCard({ title }: { title?: string } = {}) {
  const { t } = useTranslation();
  const loaded = useFeedStore((s) => s.loaded);
  const loading = useFeedStore((s) => s.loading);
  const refreshing = useFeedStore((s) => s.refreshing);
  const sources = useFeedStore((s) => s.sources);
  const items = useFeedStore((s) => s.items);
  const load = useFeedStore((s) => s.load);
  const refreshAll = useFeedStore((s) => s.refreshAll);
  const markInterpreted = useFeedStore((s) => s.markInterpreted);
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  const conversationMessages = useConversationStore((s) => s.messages);
  const members = useConversationStore((s) => s.members);
  const newConversation = useConversationStore((s) => s.newConversation);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const [batchIndex, setBatchIndex] = useState(0);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [startingId, setStartingId] = useState<string | null>(null);
  const active = conversations.find((entry) => entry.id === activeId);
  const activeMessages = activeId ? conversationMessages[activeId] ?? [] : [];
  const isActiveFeedConversation = isFeedInterpretConversation(activeMessages);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const selectableItems = useMemo(
    () => getSelectableFeedItems(items, sources),
    [items, sources]
  );
  const sourceIdsWithUnread = useMemo(
    () => new Set(selectableItems.map((item) => item.sourceId)),
    [selectableItems]
  );
  const effectiveSourceId = sourceIdsWithUnread.has(selectedSourceId)
    ? selectedSourceId
    : "";
  const filteredItems = useMemo(
    () => getSelectableFeedItems(items, sources, effectiveSourceId),
    [items, sources, effectiveSourceId]
  );

  const visibleItems = useMemo(() => {
    return selectFeedCardItems({
      items,
      sources,
      sourceId: effectiveSourceId,
      pageIndex: batchIndex
    });
  }, [items, sources, effectiveSourceId, batchIndex]);

  const canShuffle = filteredItems.length > FEED_CARD_PAGE_SIZE;
  const enabledSourceCount = sources.filter((source) => source.enabled).length;

  useEffect(() => {
    if (selectedSourceId && !sourceIdsWithUnread.has(selectedSourceId)) {
      setSelectedSourceId("");
    }
  }, [selectedSourceId, sourceIdsWithUnread]);

  const handleShuffle = () => {
    if (!canShuffle) return;
    const maxBatch = Math.ceil(filteredItems.length / FEED_CARD_PAGE_SIZE);
    setBatchIndex((index) => (index + 1) % maxBatch);
  };

  function handlePreview(item: FeedItem) {
    if (!activeId) return;
    void useDraftPreviewStore
      .getState()
      .ensureFor(activeId, active?.cwd)
      .then(() => {
        useDraftPreviewStore.getState().setPreviewTarget(activeId, item.link);
        useDetailLayoutStore.getState().setActiveTab("preview");
      });
  }

  const handleInterpret = async (item: FeedItem) => {
    const member =
      members.find((entry) => entry.id === active?.agentId) ?? members[0];
    if (!member) return;
    setStartingId(item.id);
    try {
      const conv =
        active && isActiveFeedConversation
          ? active
          : await newConversation({
              member,
              cwd: active?.cwd,
              title: clipFeedTitle(item.title),
              approvalMode: active?.approvalMode ?? member.cli.approvalMode
            });
      await markInterpreted(item.id);
      await sendMessage({
        conversationId: conv.id,
        prompt: buildFeedInterpretPrompt(item, t),
        preserveConversationTitle: true
      });
    } finally {
      setStartingId(null);
    }
  };

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <section className="side-card feed-card">
      <div className="side-card-header feed-card-header">
        <span>{title || t("feed.cardTitle")}</span>
        <div className="feed-card-actions">
          <select
            className="feed-source-select"
            value={effectiveSourceId}
            aria-label={t("feed.sourceFilter")}
            onChange={(event) => {
              setSelectedSourceId(event.target.value);
              setBatchIndex(0);
            }}
          >
            <option value="">{t("feed.allSources")}</option>
            {sources
              .filter((source) => source.enabled && sourceIdsWithUnread.has(source.id))
              .map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="feed-card-action"
            disabled={loading || refreshing || enabledSourceCount === 0}
            onClick={() => void refreshAll()}
            title={refreshing ? t("feed.refreshing") : t("feed.refreshAll")}
            aria-label={refreshing ? t("feed.refreshing") : t("feed.refreshAll")}
          >
            <RefreshCw size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="feed-card-action"
            disabled={!canShuffle}
            onClick={handleShuffle}
            title={t("feed.nextBatch")}
            aria-label={t("feed.nextBatch")}
          >
            <Shuffle size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <ol className="feed-item-list">
        {visibleItems.map((item) => {
          const isRead = Boolean(item.interpretedAt);
          const buttonLabel =
            startingId === item.id
              ? t("feed.openingConversation")
              : isRead
                ? t("feed.interpreted")
                : t("feed.interpret");
          return (
            <li
              key={item.id}
              className={`feed-item${isRead ? " interpreted" : ""}`}
            >
              <div className="feed-item-main">
                <button
                  type="button"
                  className="feed-item-title"
                  title={item.title}
                  onClick={() => handlePreview(item)}
                >
                  <span>{item.title}</span>
                  <ExternalLink size={11} strokeWidth={1.8} />
                </button>
                <div className="feed-item-meta">
                  <span>{item.sourceTitle}</span>
                  {formatFeedTime(item.publishedAt ?? item.createdAt) && (
                    <span>{formatFeedTime(item.publishedAt ?? item.createdAt)}</span>
                  )}
                  {isRead && <span>{t("feed.interpreted")}</span>}
                </div>
              </div>
              <button
                type="button"
                className="feed-interpret-btn"
                disabled={startingId !== null || isRead}
                title={isRead ? t("feed.interpreted") : t("feed.interpret")}
                onClick={() => void handleInterpret(item)}
              >
                {buttonLabel}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { type TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw, Shuffle } from "lucide-react";

import type { FeedItem } from "@/services/feed/types";
import type { ConversationMessage } from "@/services/cli/types";
import { useConversationStore } from "@/store/conversationStore";
import { useFeedStore } from "@/store/feedStore";

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

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}...`;
}

function buildInterpretPrompt(item: FeedItem, t: TFunction): string {
  const lines = [
    t("feed.interpretPromptIntro"),
    "",
    t("feed.interpretPromptTitle", { title: item.title }),
    t("feed.interpretPromptSource", { source: item.sourceTitle }),
    t("feed.interpretPromptLink", { link: item.link })
  ];
  if (item.summary?.trim()) {
    lines.push("", t("feed.interpretPromptSummary"), item.summary.trim());
  }
  lines.push("", t("feed.interpretPromptOutput"));
  return lines.join("\n");
}

function isFeedInterpretPrompt(content: string): boolean {
  const hasTitle =
    content.includes("文章标题：") || content.includes("Article title:");
  const hasLink = content.includes("链接：") || content.includes("Link:");
  const hasOutput =
    content.includes("请输出：") || content.includes("Please output:");
  return hasTitle && hasLink && hasOutput;
}

function isFeedInterpretConversation(messages: ConversationMessage[]): boolean {
  return messages.some(
    (message) => message.role === "user" && isFeedInterpretPrompt(message.content)
  );
}

export function FeedCard() {
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
  const [startingId, setStartingId] = useState<string | null>(null);
  const active = conversations.find((entry) => entry.id === activeId);
  const activeMessages = activeId ? conversationMessages[activeId] ?? [] : [];
  const isActiveFeedConversation = isFeedInterpretConversation(activeMessages);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const unreadItems = useMemo(
    () => items.filter((item) => !item.interpretedAt),
    [items]
  );

  const visibleItems = useMemo(() => {
    const offset = batchIndex * 5;
    const batch = unreadItems.slice(offset, offset + 5);
    if (batch.length || offset === 0) return batch;
    return unreadItems.slice(0, 5);
  }, [unreadItems, batchIndex]);

  const canShuffle = unreadItems.length > 5;
  const enabledSourceCount = sources.filter((source) => source.enabled).length;

  const handleShuffle = () => {
    if (!canShuffle) return;
    const maxBatch = Math.ceil(unreadItems.length / 5);
    setBatchIndex((index) => (index + 1) % maxBatch);
  };

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
              title: clip(item.title, 80),
              approvalMode: active?.approvalMode ?? member.cli.approvalMode
            });
      await markInterpreted(item.id);
      await sendMessage({
        conversationId: conv.id,
        prompt: buildInterpretPrompt(item, t),
        preserveConversationTitle: true
      });
    } finally {
      setStartingId(null);
    }
  };

  return (
    <section className="side-card feed-card">
      <div className="side-card-header feed-card-header">
        <div className="feed-card-title">
          <span>{t("feed.cardTitle")}</span>
          <strong>{t("feed.cardCount", { count: visibleItems.length })}</strong>
        </div>
        <div className="feed-card-actions">
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

      {enabledSourceCount === 0 ? (
        <p className="feed-card-empty">{t("feed.cardNoSources")}</p>
      ) : visibleItems.length === 0 ? (
        <p className="feed-card-empty">
          {loading || refreshing ? t("feed.loading") : t("feed.cardNoItems")}
        </p>
      ) : (
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
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noreferrer"
                    className="feed-item-title"
                    title={item.title}
                  >
                    <span>{item.title}</span>
                    <ExternalLink size={11} strokeWidth={1.8} />
                  </a>
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
      )}
    </section>
  );
}

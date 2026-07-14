import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw, Sparkles } from "lucide-react";

import type { InfoCardConfig } from "@/services/infoCards/types";
import { useConversationStore } from "@/store/conversationStore";
import { useInfoCardStore } from "@/store/infoCardStore";
import { buildInfoCardPrompt, isInfoCardConversation } from "./infoCardInterpretation";

function formatTime(value: string | undefined): string {
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

function valueClass(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (/^-|−|↓/.test(normalized)) return "negative";
  if (/^\+|↑/.test(normalized)) return "positive";
  return "";
}

export function InfoDataCard({ card }: { card: InfoCardConfig }) {
  const { t } = useTranslation();
  const snapshot = useInfoCardStore((state) => state.snapshots[card.id]);
  const refreshing = useInfoCardStore((state) => Boolean(state.refreshing[card.id]));
  const refreshCard = useInfoCardStore((state) => state.refreshCard);
  const marketProvider = useInfoCardStore((state) => state.marketProvider);
  const activeId = useConversationStore((state) => state.activeId);
  const conversations = useConversationStore((state) => state.conversations);
  const messages = useConversationStore((state) => state.messages);
  const members = useConversationStore((state) => state.members);
  const newConversation = useConversationStore((state) => state.newConversation);
  const sendMessage = useConversationStore((state) => state.sendMessage);
  const [analyzing, setAnalyzing] = useState(false);
  const active = conversations.find((entry) => entry.id === activeId);
  const activeMessages = activeId ? messages[activeId] ?? [] : [];
  const configured =
    card.type === "market"
      ? Boolean(marketProvider?.configured && card.marketSymbols?.length)
      : Boolean(card.recipe?.url && card.recipe.rowSelector && Object.keys(card.recipe.fields).length);
  const sourceUrl =
    card.type === "market" ? marketProvider?.endpoint : card.recipe?.url;

  useEffect(() => {
    if (!configured || snapshot?.fetchedAt || snapshot?.lastError) return;
    void refreshCard(card.id);
  }, [card.id, configured, refreshCard, snapshot?.fetchedAt, snapshot?.lastError]);

  useEffect(() => {
    if (!configured) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshCard(card.id);
    }, card.refreshMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [card.id, card.refreshMinutes, configured, refreshCard]);

  const handleAnalyze = async () => {
    if (!snapshot?.items.length || (card.type !== "market" && card.type !== "sports")) {
      return;
    }
    const member = members.find((entry) => entry.id === active?.agentId) ?? members[0];
    if (!member) return;
    setAnalyzing(true);
    try {
      const conv =
        active && isInfoCardConversation(activeMessages, card.type)
          ? active
          : await newConversation({
              member,
              cwd: active?.cwd,
              title: card.title,
              approvalMode: active?.approvalMode ?? member.cli.approvalMode
            });
      await sendMessage({
        conversationId: conv.id,
        prompt: buildInfoCardPrompt(
          card.type,
          card.title,
          snapshot,
          t(`infoCards.prompts.${card.type}`)
        ),
        preserveConversationTitle: true
      });
    } finally {
      setAnalyzing(false);
    }
  };

  const rows = snapshot?.items ?? [];
  return (
    <section className={`side-card info-data-card ${card.type}-card`}>
      <div className="side-card-header info-card-header">
        <span>{card.title}</span>
        <div className="info-card-actions">
          {sourceUrl && (
            <button
              type="button"
              className="feed-card-action"
              title={t("infoCards.openSource")}
              aria-label={t("infoCards.openSource")}
              onClick={() => window.open(sourceUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink size={13} strokeWidth={1.8} />
            </button>
          )}
          <button
            type="button"
            className="feed-card-action"
            disabled={!configured || refreshing}
            title={t("infoCards.refresh")}
            aria-label={t("infoCards.refresh")}
            onClick={() => void refreshCard(card.id)}
          >
            <RefreshCw size={14} strokeWidth={1.8} className={refreshing ? "spin" : ""} />
          </button>
        </div>
      </div>

      {!configured ? (
        <p className="info-card-empty">{t("infoCards.needsRecipe")}</p>
      ) : rows.length === 0 ? (
        <p className="info-card-empty">
          {refreshing ? t("infoCards.refreshing") : t("infoCards.noData")}
        </p>
      ) : card.type === "market" ? (
        <ol className="market-index-list">
          {rows.map((row, index) => (
            <li key={`${row.name || "market"}-${index}`}>
              <div>
                <strong>{row.name || t("infoCards.unknownItem")}</strong>
                {row.status && <small>{row.status}</small>}
              </div>
              <div className="market-index-value">
                <strong>{row.value || "—"}</strong>
                <span className={valueClass(row.change)}>{row.change || "—"}</span>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="sports-score-list">
          {rows.map((row, index) => (
            <li key={`${row.home || "home"}-${row.away || "away"}-${index}`}>
              <div className="sports-score-meta">
                <span>{row.league || t("infoCards.sports")}</span>
                <span>{row.status || ""}</span>
              </div>
              <div className="sports-score-match">
                <span>{row.home || "—"}</span>
                <strong>{row.score || "vs"}</strong>
                <span>{row.away || "—"}</span>
              </div>
            </li>
          ))}
        </ol>
      )}

      {(snapshot?.fetchedAt || snapshot?.lastError) && (
        <div className={`info-card-status${snapshot.stale ? " stale" : ""}`}>
          <span>
            {snapshot.fetchedAt
              ? t("infoCards.updatedAt", { time: formatTime(snapshot.fetchedAt) })
              : t("infoCards.notUpdated")}
          </span>
          {snapshot.lastError && <span title={snapshot.lastError}>{t("infoCards.sourceError")}</span>}
        </div>
      )}

      <button
        type="button"
        className="info-card-analyze"
        disabled={!rows.length || analyzing}
        onClick={() => void handleAnalyze()}
      >
        <Sparkles size={13} strokeWidth={1.8} />
        {analyzing ? t("infoCards.analyzing") : t("infoCards.analyze")}
      </button>
    </section>
  );
}

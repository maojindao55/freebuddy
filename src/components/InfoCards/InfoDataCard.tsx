import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw, Sparkles } from "lucide-react";

import type { InfoCardConfig, SportsDateOffset } from "@/services/infoCards/types";
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

function marketIdentity(value: string | undefined): { name: string; symbol?: string } {
  const normalized = value?.trim() ?? "";
  const matched = normalized.match(/^(.*?)\s*·\s*((?:SH|SZ)\d{6})$/i);
  if (!matched) return { name: normalized };
  return { name: matched[1].trim(), symbol: matched[2].toUpperCase() };
}

export function InfoDataCard({ card }: { card: InfoCardConfig }) {
  const { t } = useTranslation();
  const snapshot = useInfoCardStore((state) => state.snapshots[card.id]);
  const refreshing = useInfoCardStore((state) => Boolean(state.refreshing[card.id]));
  const refreshCard = useInfoCardStore((state) => state.refreshCard);
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const marketProvider = useInfoCardStore((state) => state.marketProvider);
  const activeId = useConversationStore((state) => state.activeId);
  const conversations = useConversationStore((state) => state.conversations);
  const messages = useConversationStore((state) => state.messages);
  const members = useConversationStore((state) => state.members);
  const newConversation = useConversationStore((state) => state.newConversation);
  const sendMessage = useConversationStore((state) => state.sendMessage);
  const initializedCardId = useRef<string | undefined>(undefined);
  const [analyzing, setAnalyzing] = useState(false);
  const [switchingDate, setSwitchingDate] = useState(false);
  const active = conversations.find((entry) => entry.id === activeId);
  const activeMessages = activeId ? messages[activeId] ?? [] : [];
  const configured =
    card.type === "market"
      ? Boolean(marketProvider?.configured && card.marketSymbols?.length)
      : true;
  const sourceUrl =
    card.type === "market" ? marketProvider?.sourceUrl : snapshot?.sourceUrl;
  const sportsDateOffset = card.sportsDateOffset ?? 0;

  useEffect(() => {
    if (!configured) return;
    const shouldRefreshSports =
      card.type === "sports" && initializedCardId.current !== card.id;
    if (!shouldRefreshSports && (snapshot?.fetchedAt || snapshot?.lastError)) return;
    initializedCardId.current = card.id;
    void refreshCard(card.id);
  }, [card.id, card.type, configured, refreshCard, snapshot?.fetchedAt, snapshot?.lastError]);

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

  const handleSportsDateChange = async (dateOffset: SportsDateOffset) => {
    if (
      card.type !== "sports" ||
      dateOffset === sportsDateOffset ||
      switchingDate ||
      refreshing
    ) {
      return;
    }
    setSwitchingDate(true);
    try {
      await updateCard({ id: card.id, sportsDateOffset: dateOffset });
      await refreshCard(card.id);
    } finally {
      setSwitchingDate(false);
    }
  };

  const rows = snapshot?.items ?? [];
  const visibleRows = switchingDate ? [] : rows;
  return (
    <section className={`side-card info-data-card ${card.type}-card`}>
      <div className="side-card-header info-card-header">
        <span>
          {(!card.title || 
            /^(?:feed|rss news|rss 资讯|builtin rss|内置资讯队列|market indices|指数行情|sports events|体育赛事)$/i.test(card.title.trim())
          ) ? t(`infoCards.types.${card.type}`) : card.title}
        </span>
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

      {card.type === "sports" && (
        <div
          className="sports-date-filter"
          role="group"
          aria-label={t("infoCards.sportsDates.label")}
        >
          {([-1, 0, 1] as SportsDateOffset[]).map((dateOffset) => (
            <button
              key={dateOffset}
              type="button"
              className={sportsDateOffset === dateOffset ? "active" : ""}
              aria-pressed={sportsDateOffset === dateOffset}
              disabled={switchingDate || refreshing}
              onClick={() => void handleSportsDateChange(dateOffset)}
            >
              {t(
                dateOffset === -1
                  ? "infoCards.sportsDates.yesterday"
                  : dateOffset === 1
                    ? "infoCards.sportsDates.tomorrow"
                    : "infoCards.sportsDates.today"
              )}
            </button>
          ))}
        </div>
      )}

      {!configured ? (
        <p className="info-card-empty">{t("infoCards.needsConfiguration")}</p>
      ) : visibleRows.length === 0 ? (
        <p className="info-card-empty">
          {refreshing || switchingDate ? t("infoCards.refreshing") : t("infoCards.noData")}
        </p>
      ) : card.type === "market" ? (
        <ol className="market-index-list">
          {visibleRows.map((row, index) => {
            const identity = marketIdentity(row.name);
            return (
              <li key={`${row.name || "market"}-${index}`}>
                <div>
                  <strong>{identity.name || t("infoCards.unknownItem")}</strong>
                  {identity.symbol && <small>{identity.symbol}</small>}
                </div>
                <div className="market-index-value">
                  <strong>{row.value || "—"}</strong>
                  <span className={valueClass(row.change)}>{row.change || "—"}</span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <ol className="sports-score-list">
          {visibleRows.map((row, index) => (
            <li key={`${row.home || "home"}-${row.away || "away"}-${index}`}>
              <div className="sports-score-meta">
                <span>{row.league || t("infoCards.sports")}</span>
                <span>
                  {row.state === "pre"
                    ? formatTime(row.startTime)
                    : row.state === "in"
                      ? row.status && !/^(?:in progress|live)$/i.test(row.status)
                        ? `${t("infoCards.sportsStatus.live")} · ${row.status}`
                        : t("infoCards.sportsStatus.live")
                      : row.state === "post"
                        ? t("infoCards.sportsStatus.finished")
                        : row.status || ""}
                </span>
              </div>
              <div className="sports-score-match">
                <span className="sports-score-team">
                  {row.homeLogo && (
                    <img
                      src={row.homeLogo}
                      alt=""
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                      }}
                    />
                  )}
                  <span>{row.home || "—"}</span>
                </span>
                <strong>{row.score || "— : —"}</strong>
                <span className="sports-score-team away">
                  <span>{row.away || "—"}</span>
                  {row.awayLogo && (
                    <img
                      src={row.awayLogo}
                      alt=""
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                      }}
                    />
                  )}
                </span>
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
        disabled={!visibleRows.length || analyzing || switchingDate}
        onClick={() => void handleAnalyze()}
      >
        <Sparkles size={13} strokeWidth={1.8} />
        {analyzing ? t("infoCards.analyzing") : t("infoCards.analyze")}
      </button>
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, Save, Search, Trash2, X } from "lucide-react";

import { infoCardClient } from "@/services/infoCards/client";
import type {
  InfoCardConfig,
  MarketSymbolSearchResult
} from "@/services/infoCards/types";
import { useInfoCardStore } from "@/store/infoCardStore";
import { FeedTab } from "./FeedTab";

function MarketCardEditor({ card }: { card: InfoCardConfig }) {
  const { t } = useTranslation();
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const snapshot = useInfoCardStore((state) => state.snapshots[card.id]);
  const [symbols, setSymbols] = useState<string[]>(card.marketSymbols ?? []);
  const [symbolNames, setSymbolNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketSymbolSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [refreshMinutes, setRefreshMinutes] = useState(card.refreshMinutes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const selectedNames = useMemo(() => {
    const names = { ...symbolNames };
    for (const row of snapshot?.items ?? []) {
      const matched = row.name?.match(/^(.*?)\s*·\s*((?:SH|SZ)\d{6})$/i);
      if (matched) names[matched[2].toLowerCase()] = matched[1].trim();
    }
    return names;
  }, [snapshot?.items, symbolNames]);

  useEffect(() => {
    setSymbols(card.marketSymbols ?? []);
    setSymbolNames({});
    setRefreshMinutes(card.refreshMinutes);
  }, [card]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      setSearchError(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(false);
    const timer = window.setTimeout(() => {
      void infoCardClient
        .searchMarketSymbols(trimmed)
        .then((next) => {
          if (!cancelled) setResults(next);
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
            setSearchError(true);
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const addSymbol = (result: MarketSymbolSearchResult) => {
    if (symbols.length >= 10 || symbols.includes(result.symbol)) return;
    setSymbols([...symbols, result.symbol]);
    setSymbolNames((current) => ({ ...current, [result.symbol]: result.name }));
    setQuery("");
    setResults([]);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateCard({
        id: card.id,
        marketSymbols: symbols,
        refreshMinutes
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="info-card-config-editor">
      <p>{t("infoCards.ashare.symbolHint")}</p>
      <div className="market-symbol-chips" aria-label={t("infoCards.ashare.selectedSymbols")}>
        {symbols.map((symbol) => (
          <span className="market-symbol-chip" key={symbol}>
            <span>
              <strong>{selectedNames[symbol] || symbol.toUpperCase()}</strong>
              {selectedNames[symbol] && <small>{symbol.toUpperCase()}</small>}
            </span>
            <button
              type="button"
              title={t("infoCards.ashare.removeSymbol", {
                name: selectedNames[symbol] || symbol.toUpperCase()
              })}
              aria-label={t("infoCards.ashare.removeSymbol", {
                name: selectedNames[symbol] || symbol.toUpperCase()
              })}
              onClick={() => setSymbols(symbols.filter((entry) => entry !== symbol))}
            >
              <X size={13} />
            </button>
          </span>
        ))}
        {!symbols.length && (
          <span className="market-symbols-empty">{t("infoCards.ashare.noSelectedSymbols")}</span>
        )}
        <small className="market-symbol-count">
          {t("infoCards.ashare.selectedCount", { count: symbols.length })}
        </small>
      </div>
      <div className="info-card-selector-grid">
        <label className="market-symbol-search">
          <span>{t("infoCards.ashare.searchLabel")}</span>
          <div className="market-symbol-search-input">
            <Search size={15} aria-hidden="true" />
            <input
              value={query}
              placeholder={t("infoCards.ashare.searchPlaceholder")}
              autoComplete="off"
              disabled={symbols.length >= 10}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          {query.trim().length >= 2 && (
            <div className="market-symbol-results" role="listbox">
              {searching ? (
                <p>{t("infoCards.ashare.searching")}</p>
              ) : searchError ? (
                <p>{t("infoCards.ashare.searchError")}</p>
              ) : results.length ? (
                results.map((result) => {
                  const selected = symbols.includes(result.symbol);
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      key={result.symbol}
                      disabled={selected || symbols.length >= 10}
                      onClick={() => addSymbol(result)}
                    >
                      <span>
                        <strong>{result.name}</strong>
                        <small>
                          {result.code} · {t(`infoCards.ashare.exchanges.${result.exchange}`)}
                          {result.securityType ? ` · ${result.securityType}` : ""}
                        </small>
                      </span>
                      <span>{selected ? t("infoCards.ashare.selected") : t("infoCards.ashare.add")}</span>
                    </button>
                  );
                })
              ) : (
                <p>{t("infoCards.ashare.noSearchResults")}</p>
              )}
            </div>
          )}
        </label>
        <label>
          <span>{t("infoCards.refreshMinutes")}</span>
          <input
            type="number"
            min={1}
            max={720}
            value={refreshMinutes}
            onChange={(event) =>
              setRefreshMinutes(Math.max(1, Math.min(720, Number(event.currentTarget.value) || 1)))
            }
          />
        </label>
      </div>
      <button type="button" className="ghost" disabled={saving} onClick={() => void save()}>
        <Save size={14} />
        {saved ? t("infoCards.saved") : saving ? t("infoCards.saving") : t("common.save")}
      </button>
    </div>
  );
}

function SportsCardEditor({ card }: { card: InfoCardConfig }) {
  const { t } = useTranslation();
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const [refreshMinutes, setRefreshMinutes] = useState(card.refreshMinutes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setRefreshMinutes(card.refreshMinutes);
  }, [card]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateCard({ id: card.id, refreshMinutes });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="info-card-config-editor sports-card-editor">
      <p>{t("infoCards.sportsProviderHint")}</p>
      <div className="info-card-selector-grid">
        <label>
          <span>{t("infoCards.refreshMinutes")}</span>
          <input
            type="number"
            min={1}
            max={120}
            value={refreshMinutes}
            onChange={(event) =>
              setRefreshMinutes(Math.max(1, Math.min(120, Number(event.currentTarget.value) || 1)))
            }
          />
        </label>
      </div>
      <button
        type="button"
        className="ghost"
        disabled={saving}
        onClick={() => void save()}
      >
        <Save size={14} />
        {saved ? t("infoCards.saved") : saving ? t("infoCards.saving") : t("common.save")}
      </button>
    </div>
  );
}

function CardEditor({ card, index, total }: { card: InfoCardConfig; index: number; total: number }) {
  const { t } = useTranslation();
  const cards = useInfoCardStore((state) => state.cards);
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const deleteCard = useInfoCardStore((state) => state.deleteCard);
  const reorderCards = useInfoCardStore((state) => state.reorderCards);
  const [title, setTitle] = useState(card.title);

  useEffect(() => setTitle(card.title), [card.title]);

  const move = async (direction: -1 | 1) => {
    const ordered = [...cards].sort((a, b) => a.order - b.order);
    const currentIndex = ordered.findIndex((entry) => entry.id === card.id);
    const neighbor = ordered[currentIndex + direction];
    if (!neighbor) return;
    [ordered[currentIndex], ordered[currentIndex + direction]] = [neighbor, card];
    await reorderCards(ordered.map((entry) => entry.id));
  };

  return (
    <section className="info-card-editor">
      <div className="info-card-editor-header">
        <div>
          <strong>{t(`infoCards.types.${card.type}`)}</strong>
          <small>{card.type === "rss" ? t("infoCards.builtinRss") : card.id.slice(0, 8)}</small>
        </div>
        <div className="info-card-editor-actions">
          <button type="button" className="icon-btn" disabled={index === 0} onClick={() => void move(-1)}>
            <ArrowUp size={14} />
          </button>
          <button type="button" className="icon-btn" disabled={index === total - 1} onClick={() => void move(1)}>
            <ArrowDown size={14} />
          </button>
          <label className="feed-switch" title={card.enabled ? t("feed.enabled") : t("feed.disabled")}>
            <input
              type="checkbox"
              checked={card.enabled}
              onChange={(event) => void updateCard({ id: card.id, enabled: event.currentTarget.checked })}
            />
            <span aria-hidden="true" />
          </label>
          {card.type !== "rss" && (
            <button
              type="button"
              className="icon-btn danger"
              title={t("common.delete")}
              onClick={() => {
                if (window.confirm(t("infoCards.deleteConfirm", { title: card.title }))) {
                  void deleteCard(card.id);
                }
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <label className="info-card-title-field">
        <span>{t("infoCards.cardTitle")}</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          onBlur={() => {
            if (title.trim() && title.trim() !== card.title) {
              void updateCard({ id: card.id, title: title.trim() });
            }
          }}
        />
      </label>
      {card.type === "rss" ? (
        <details className="info-card-rss-settings">
          <summary>{t("infoCards.manageRssSources")}</summary>
          <FeedTab />
        </details>
      ) : card.type === "market" ? (
        <MarketCardEditor card={card} />
      ) : (
        <SportsCardEditor card={card} />
      )}
    </section>
  );
}

export function InfoCardsTab() {
  const { t } = useTranslation();
  const cards = useInfoCardStore((state) => state.cards);
  const loaded = useInfoCardStore((state) => state.loaded);
  const loading = useInfoCardStore((state) => state.loading);
  const load = useInfoCardStore((state) => state.load);
  const createCard = useInfoCardStore((state) => state.createCard);
  const [type, setType] = useState<"market" | "sports">("market");
  const ordered = useMemo(() => [...cards].sort((a, b) => a.order - b.order), [cards]);
  const selectedTypeExists = cards.some((card) => card.type === type);

  useEffect(() => {
    if (!loaded) void load();
  }, [load, loaded]);

  useEffect(() => {
    return window.freebuddy?.infoCards.onChanged(() => void load());
  }, [load]);

  return (
    <div className="settings-tab info-cards-settings-tab">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{t("infoCards.settingsTitle")}</h3>
        <span className="settings-section-desc">{t("infoCards.settingsDescription")}</span>
      </div>
      <section className="info-card-add-row">
        <select value={type} onChange={(event) => setType(event.currentTarget.value as "market" | "sports")}>
          <option value="market">{t("infoCards.types.market")}</option>
          <option value="sports">{t("infoCards.types.sports")}</option>
        </select>
        <button
          type="button"
          className="primary-btn"
          disabled={!loaded || loading || selectedTypeExists}
          title={selectedTypeExists ? t("infoCards.typeAlreadyAdded") : undefined}
          onClick={() => void createCard({ type })}
        >
          <Plus size={15} />
          {selectedTypeExists ? t("infoCards.typeAlreadyAdded") : t("infoCards.addCard")}
        </button>
      </section>
      <div className="info-card-editor-list">
        {ordered.map((card, index) => (
          <CardEditor key={card.id} card={card} index={index} total={ordered.length} />
        ))}
      </div>
    </div>
  );
}
